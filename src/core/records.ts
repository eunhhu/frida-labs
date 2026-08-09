// Analysis Record persistence and live coordination. A human can play one
// controlled scenario while the generic probe emits bounded call events; the
// resulting JSONL + metadata can be paged and summarized without screenshots.

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { DeviceInfo } from "./devices.js";
import { repoRoot } from "./manifest.js";
import type { GameSession } from "./session.js";

export const ANALYSIS_RECORD_SCHEMA = "flab.analysis-record.v1";
export const ANALYSIS_RECORD_EVENT_SCHEMA = "flab.record.event.v1";
export const ANALYSIS_RECORD_MAX_EVENTS = 100_000;
export const ANALYSIS_RECORD_MAX_BYTES = 64 * 1024 * 1024;
export const ANALYSIS_RECORD_EVENT_MAX_BYTES = 64 * 1024;

export interface AnalysisRecordProbe {
  id: string;
  name: string;
  address: string;
  args?: number;
  captureReturn?: boolean;
  backtrace?: boolean;
}

export interface AnalysisRecordOptions {
  maxEvents?: number;
  perProbeLimit?: number;
  sampleEvery?: number;
  maxDurationMs?: number;
}

export interface AnalysisRecordContext {
  target: string;
  process: string;
  pid: number;
  device: DeviceInfo;
}

export interface AnalysisRecordMetadata {
  schema: typeof ANALYSIS_RECORD_SCHEMA;
  id: string;
  label: string;
  status: "active" | "completed" | "interrupted" | "failed";
  reason?: string;
  startedAt: string;
  stoppedAt?: string;
  target: string;
  process: string;
  pid: number;
  device: DeviceInfo;
  probes: AnalysisRecordProbe[];
  options: Required<AnalysisRecordOptions>;
  eventCount: number;
  dropped: number;
  bytes: number;
  eventsPath: string;
  agentResult?: unknown;
}

export interface AnalysisRecordPage {
  record: AnalysisRecordMetadata;
  events: Array<{ sequence: number; receivedAt: string; event: Record<string, unknown> }>;
  nextCursor: number;
  eof: boolean;
  malformed: number;
}

export interface AnalysisRecordSummary {
  schema: "flab.analysis-record-summary.v1";
  record: AnalysisRecordMetadata;
  functions: Array<{
    probeId: string;
    name: string;
    enters: number;
    leaves: number;
    firstTimestamp: number | null;
    lastTimestamp: number | null;
    durationMs: { count: number; min: number | null; max: number | null; average: number | null };
    threads: number[];
    argumentSamples: unknown[][];
    returnSamples: unknown[];
  }>;
  transitions: Array<{ from: string; to: string; count: number }>;
  malformed: number;
}

interface RecordEventPayload {
  type: "flab.record.event";
  schema: typeof ANALYSIS_RECORD_EVENT_SCHEMA;
  recordId: string;
  sequence: number;
  event: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${field} contains unsupported field ${JSON.stringify(extra)}`);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be a non-empty string up to ${max} characters`);
  return value.trim();
}

function integer(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return selected;
}

function boolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function normalizeAnalysisRecordPlan(
  probesValue: unknown,
  optionsValue?: unknown,
): { probes: AnalysisRecordProbe[]; options: Required<AnalysisRecordOptions> } {
  if (!Array.isArray(probesValue) || probesValue.length < 1 || probesValue.length > 64) throw new Error("probes must contain 1..64 entries");
  const ids = new Set<string>();
  const probes = probesValue.map((value, index) => {
    if (!record(value)) throw new Error(`probes[${index}] must be an object`);
    exact(value, ["id", "name", "address", "args", "captureReturn", "backtrace", "module", "source"], `probes[${index}]`);
    const id = text(value.id ?? `fn-${index + 1}`, `probes[${index}].id`, 96);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || ids.has(id)) throw new Error(`probes[${index}].id must be unique and identifier-safe`);
    ids.add(id);
    const address = text(value.address, `probes[${index}].address`, 64);
    if (!/^0x[0-9a-f]+$/i.test(address)) throw new Error(`probes[${index}].address must be a hexadecimal pointer`);
    return {
      id,
      name: text(value.name ?? address, `probes[${index}].name`, 300),
      address,
      args: integer(value.args, 4, 0, 16, `probes[${index}].args`),
      captureReturn: boolean(value.captureReturn, true, `probes[${index}].captureReturn`),
      backtrace: boolean(value.backtrace, false, `probes[${index}].backtrace`),
    };
  });
  const options = optionsValue === undefined || optionsValue === null ? {} : optionsValue;
  if (!record(options)) throw new Error("options must be an object");
  exact(options, ["maxEvents", "perProbeLimit", "sampleEvery", "maxDurationMs"], "options");
  return {
    probes,
    options: {
      maxEvents: integer(options.maxEvents, 50_000, 1, ANALYSIS_RECORD_MAX_EVENTS, "maxEvents"),
      perProbeLimit: integer(options.perProbeLimit, 10_000, 1, 50_000, "perProbeLimit"),
      sampleEvery: integer(options.sampleEvery, 1, 1, 10_000, "sampleEvery"),
      maxDurationMs: integer(options.maxDurationMs, 30 * 60_000, 1_000, 2 * 60 * 60_000, "maxDurationMs"),
    },
  };
}

function safeRecordId(value: unknown): string {
  const id = text(value, "record id", 96);
  if (!/^rec-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("record id is invalid");
  return id;
}

function metadataClone(metadata: AnalysisRecordMetadata): AnalysisRecordMetadata {
  return structuredClone(metadata);
}

function writeAtomic(path: string, value: unknown): void {
  const staging = resolve(dirname(path), `.flab-record-${randomUUID()}`);
  try {
    writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(staging, path);
  } finally {
    if (existsSync(staging)) rmSync(staging, { force: true });
  }
}

class AnalysisRecordWriter {
  private readonly stream: WriteStream;
  private backpressured = false;
  private streamFailure: Error | null = null;
  private stopped = false;
  private stopPromise: Promise<AnalysisRecordMetadata> | null = null;

  constructor(
    readonly metadata: AnalysisRecordMetadata,
    private readonly metadataPath: string,
    eventsPath: string,
  ) {
    const fd = openSync(eventsPath, "wx");
    try {
      this.stream = createWriteStream(eventsPath, { fd, autoClose: true });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.stream.on("drain", () => { this.backpressured = false; });
    this.stream.on("error", (error) => {
      this.backpressured = true;
      this.streamFailure = error;
    });
    const header = `${JSON.stringify({ type: "header", ...metadata })}\n`;
    this.metadata.bytes = Buffer.byteLength(header);
    if (!this.stream.write(header)) this.backpressured = true;
    try {
      writeAtomic(this.metadataPath, this.metadata);
    } catch (error) {
      this.stream.destroy();
      throw error;
    }
  }

  append(payload: RecordEventPayload): boolean {
    if (this.stopped || this.backpressured || this.metadata.eventCount >= this.metadata.options.maxEvents) {
      this.metadata.dropped++;
      return false;
    }
    const entry = {
      type: "event",
      sequence: this.metadata.eventCount + 1,
      agentSequence: payload.sequence,
      receivedAt: new Date().toISOString(),
      event: payload.event,
    };
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > ANALYSIS_RECORD_EVENT_MAX_BYTES || this.metadata.bytes + bytes > ANALYSIS_RECORD_MAX_BYTES) {
      this.metadata.dropped++;
      return false;
    }
    this.metadata.eventCount++;
    this.metadata.bytes += bytes;
    if (!this.stream.write(line)) this.backpressured = true;
    return true;
  }

  stop(reason: string, agentResult?: unknown): Promise<AnalysisRecordMetadata> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.metadata.status = reason === "requested" || reason.endsWith("-limit") ? "completed" : reason === "start-failed" ? "failed" : "interrupted";
    this.metadata.reason = reason;
    this.metadata.stoppedAt = new Date().toISOString();
    if (agentResult !== undefined) this.metadata.agentResult = agentResult;
    this.stopPromise = new Promise<AnalysisRecordMetadata>((resolveStop, rejectStop) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (this.streamFailure) {
          this.metadata.status = "failed";
          this.metadata.reason = `storage-error: ${this.streamFailure.message}`;
        }
        try {
          writeAtomic(this.metadataPath, this.metadata);
          resolveStop(metadataClone(this.metadata));
        } catch (error) {
          rejectStop(error);
        }
      };
      if (this.stream.destroyed || this.stream.closed) {
        done();
        return;
      }
      this.stream.once("finish", done);
      this.stream.once("error", done);
      this.stream.end(`${JSON.stringify({
        type: "footer",
        status: this.metadata.status,
        reason,
        eventCount: this.metadata.eventCount,
        dropped: this.metadata.dropped,
        stoppedAt: this.metadata.stoppedAt,
      })}\n`);
    });
    return this.stopPromise;
  }
}

export interface AnalysisRecordStoreOptions {
  root?: string;
}

export class AnalysisRecordStore {
  readonly directory: string;
  private writers = new Map<string, AnalysisRecordWriter>();

  constructor(options: AnalysisRecordStoreOptions = {}) {
    const workspace = realpathSync(resolve(options.root ?? repoRoot()));
    const directory = resolve(workspace, "artifacts", "records");
    if (!inside(workspace, directory)) throw new Error("record directory escapes the workspace");
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("record directory must not be a symlink");
    const real = realpathSync(directory);
    if (!inside(workspace, real)) throw new Error("record directory resolves outside the workspace");
    this.directory = real;
  }

  start(labelValue: unknown, context: AnalysisRecordContext, probesValue: unknown, optionsValue?: unknown): AnalysisRecordMetadata {
    const label = text(labelValue, "label", 200);
    const { probes, options } = normalizeAnalysisRecordPlan(probesValue, optionsValue);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const id = `rec-${stamp}-${randomBytes(5).toString("hex")}`;
    const eventsName = `${id}.jsonl`;
    const metadata: AnalysisRecordMetadata = {
      schema: ANALYSIS_RECORD_SCHEMA,
      id,
      label,
      status: "active",
      startedAt: new Date().toISOString(),
      target: context.target,
      process: context.process,
      pid: context.pid,
      device: context.device,
      probes,
      options,
      eventCount: 0,
      dropped: 0,
      bytes: 0,
      eventsPath: `artifacts/records/${eventsName}`,
    };
    const writer = new AnalysisRecordWriter(
      metadata,
      resolve(this.directory, `${id}.json`),
      resolve(this.directory, eventsName),
    );
    this.writers.set(id, writer);
    return metadataClone(metadata);
  }

  append(payload: unknown): boolean {
    if (!record(payload) || payload.type !== "flab.record.event" || payload.schema !== ANALYSIS_RECORD_EVENT_SCHEMA ||
        typeof payload.sequence !== "number" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || !record(payload.event)) {
      return false;
    }
    const id = safeRecordId(payload.recordId);
    const writer = this.writers.get(id);
    return writer ? writer.append(payload as unknown as RecordEventPayload) : false;
  }

  active(id?: string): AnalysisRecordMetadata | null {
    if (id) return this.writers.has(safeRecordId(id)) ? metadataClone(this.writers.get(id)!.metadata) : null;
    const writer = this.writers.values().next().value as AnalysisRecordWriter | undefined;
    return writer ? metadataClone(writer.metadata) : null;
  }

  async stop(idValue: unknown, reason: string, agentResult?: unknown): Promise<AnalysisRecordMetadata> {
    const id = safeRecordId(idValue);
    const writer = this.writers.get(id);
    if (!writer) throw new Error(`active record ${JSON.stringify(id)} not found`);
    try {
      return await writer.stop(reason, agentResult);
    } finally {
      this.writers.delete(id);
    }
  }

  get(idValue: unknown): AnalysisRecordMetadata {
    const id = safeRecordId(idValue);
    const active = this.writers.get(id);
    if (active) return metadataClone(active.metadata);
    const path = resolve(this.directory, `${id}.json`);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error(`record ${JSON.stringify(id)} not found`);
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!record(value) || value.schema !== ANALYSIS_RECORD_SCHEMA || value.id !== id) throw new Error(`record ${JSON.stringify(id)} metadata is invalid`);
    return value as unknown as AnalysisRecordMetadata;
  }

  list(): AnalysisRecordMetadata[] {
    const fromDisk = readdirSync(this.directory)
      .filter((name) => /^rec-[A-Za-z0-9._-]+\.json$/.test(name))
      .flatMap((name) => {
        try { return [this.get(name.slice(0, -5))]; }
        catch { return []; }
      });
    const byId = new Map(fromDisk.map((metadata) => [metadata.id, metadata]));
    for (const writer of this.writers.values()) byId.set(writer.metadata.id, metadataClone(writer.metadata));
    return [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 200);
  }

  async read(idValue: unknown, cursorValue = 0, limitValue = 100): Promise<AnalysisRecordPage> {
    const recordMetadata = this.get(idValue);
    const cursor = integer(cursorValue, 0, 0, Number.MAX_SAFE_INTEGER, "cursor");
    const limit = integer(limitValue, 100, 1, 500, "limit");
    const path = resolve(this.directory, `${recordMetadata.id}.jsonl`);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error(`record ${JSON.stringify(recordMetadata.id)} events not found`);
    const events: AnalysisRecordPage["events"] = [];
    let malformed = 0;
    let lastSeen = cursor;
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (events.length >= limit) { lines.close(); break; }
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { malformed++; continue; }
      if (!record(value) || value.type !== "event" || typeof value.sequence !== "number" || !record(value.event)) continue;
      if (value.sequence <= cursor) continue;
      lastSeen = value.sequence;
      events.push({
        sequence: value.sequence,
        receivedAt: typeof value.receivedAt === "string" ? value.receivedAt : "",
        event: value.event,
      });
    }
    return {
      record: recordMetadata,
      events,
      nextCursor: lastSeen,
      eof: lastSeen >= recordMetadata.eventCount || events.length === 0,
      malformed,
    };
  }

  async summary(idValue: unknown): Promise<AnalysisRecordSummary> {
    const metadata = this.get(idValue);
    const stats = new Map<string, {
      name: string; enters: number; leaves: number; first: number | null; last: number | null;
      durationCount: number; durationTotal: number; durationMin: number | null; durationMax: number | null;
      threads: Set<number>; args: unknown[][]; returns: unknown[];
    }>();
    const transitions = new Map<string, number>();
    const previousEnterByThread = new Map<string, string>();
    let malformed = 0;
    const path = resolve(this.directory, `${metadata.id}.jsonl`);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error(`record ${JSON.stringify(metadata.id)} events not found`);
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { malformed++; continue; }
      if (!record(value) || value.type !== "event" || !record(value.event)) continue;
      const event = value.event;
      const probeId = typeof event.probeId === "string" ? event.probeId : "unknown";
      const name = typeof event.function === "string" ? event.function : probeId;
      const current = stats.get(probeId) ?? {
        name, enters: 0, leaves: 0, first: null, last: null,
        durationCount: 0, durationTotal: 0, durationMin: null, durationMax: null,
        threads: new Set<number>(), args: [], returns: [],
      };
      const timestamp = typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : null;
      if (timestamp !== null) {
        current.first = current.first === null ? timestamp : Math.min(current.first, timestamp);
        current.last = current.last === null ? timestamp : Math.max(current.last, timestamp);
      }
      const threadKey = typeof event.threadId === "number" && Number.isFinite(event.threadId) ? String(event.threadId) : "unknown";
      if (typeof event.threadId === "number" && current.threads.size < 32) current.threads.add(event.threadId);
      if (event.phase === "enter") {
        current.enters++;
        if (Array.isArray(event.args) && current.args.length < 3) current.args.push(event.args.slice(0, 16));
        const previousEnter = previousEnterByThread.get(threadKey);
        if (previousEnter) transitions.set(`${previousEnter}\u0000${probeId}`, (transitions.get(`${previousEnter}\u0000${probeId}`) ?? 0) + 1);
        previousEnterByThread.set(threadKey, probeId);
      } else if (event.phase === "leave") {
        current.leaves++;
        if (event.returnValue !== undefined && current.returns.length < 3) current.returns.push(event.returnValue);
        if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
          current.durationCount++;
          current.durationTotal += event.durationMs;
          current.durationMin = current.durationMin === null ? event.durationMs : Math.min(current.durationMin, event.durationMs);
          current.durationMax = current.durationMax === null ? event.durationMs : Math.max(current.durationMax, event.durationMs);
        }
      }
      stats.set(probeId, current);
    }
    return {
      schema: "flab.analysis-record-summary.v1",
      record: metadata,
      functions: [...stats].map(([probeId, value]) => ({
        probeId,
        name: value.name,
        enters: value.enters,
        leaves: value.leaves,
        firstTimestamp: value.first,
        lastTimestamp: value.last,
        durationMs: {
          count: value.durationCount,
          min: value.durationMin,
          max: value.durationMax,
          average: value.durationCount ? value.durationTotal / value.durationCount : null,
        },
        threads: [...value.threads],
        argumentSamples: value.args,
        returnSamples: value.returns,
      })).sort((left, right) => right.enters - left.enters).slice(0, 128),
      transitions: [...transitions]
        .map(([key, count]) => {
          const [from, to] = key.split("\u0000");
          return { from: from!, to: to!, count };
        })
        .sort((left, right) => right.count - left.count)
        .slice(0, 128),
      malformed,
    };
  }
}

function resultOk(value: unknown): boolean {
  return record(value) && value.ok === true;
}

export interface RecordPlanResult {
  query: string;
  module: string | null;
  candidates: AnalysisRecordProbe[];
  matched: number;
  truncated: boolean;
}

export class RecordingCoordinator {
  private activeRecord: { id: string; session: GameSession } | null = null;
  private finalizing: Promise<AnalysisRecordMetadata> | null = null;
  private completedRecord: AnalysisRecordMetadata | null = null;

  constructor(readonly store = new AnalysisRecordStore()) {}

  async plan(session: GameSession, query: string, module?: string, limit = 24): Promise<RecordPlanResult> {
    const value = await session.call("recordPlan", [query, module ?? null, limit]);
    if (!record(value) || !Array.isArray(value.candidates)) throw new Error("recordPlan returned an invalid result");
    const { probes } = normalizeAnalysisRecordPlan(value.candidates, {});
    return {
      query: typeof value.query === "string" ? value.query : query,
      module: typeof value.module === "string" ? value.module : null,
      candidates: probes,
      matched: typeof value.matched === "number" ? value.matched : probes.length,
      truncated: value.truncated === true,
    };
  }

  async start(
    session: GameSession,
    context: AnalysisRecordContext,
    label: string,
    probes: unknown,
    options?: unknown,
  ): Promise<AnalysisRecordMetadata> {
    if (this.activeRecord) throw new Error(`record ${this.activeRecord.id} is already active`);
    if (this.finalizing) await this.finalizing;
    this.completedRecord = null;
    const metadata = this.store.start(label, context, probes, options);
    try {
      const started = await session.call("recordStart", [metadata.id, metadata.probes, metadata.options]);
      if (!resultOk(started)) throw new Error(record(started) && record(started.error) && typeof started.error.message === "string" ? started.error.message : "recordStart failed");
      this.activeRecord = { id: metadata.id, session };
      return this.store.get(metadata.id);
    } catch (error) {
      await this.store.stop(metadata.id, "start-failed", { error: (error as Error).message });
      throw error;
    }
  }

  capture(payload: Record<string, unknown>): void {
    const active = this.activeRecord;
    if (!active || payload.recordId !== active.id) return;
    if (payload.type === "flab.record.event") {
      if (!this.store.append(payload)) void this.stop("host-limit").catch(() => {});
      return;
    }
    if (payload.type === "flab.record.state" && payload.state === "stopped") {
      this.activeRecord = null;
      const reason = record(payload.result) && typeof payload.result.reason === "string" ? payload.result.reason : "agent-stopped";
      void this.finalize(active.id, reason, payload.result).catch(() => {});
    }
  }

  async status(): Promise<{ record: AnalysisRecordMetadata | null; agent: unknown; completed: AnalysisRecordMetadata | null }> {
    const active = this.activeRecord;
    if (!active) return { record: null, agent: null, completed: this.completedRecord ? metadataClone(this.completedRecord) : null };
    const agent = await active.session.call("recordStatus", []);
    return { record: this.store.active(active.id), agent, completed: null };
  }

  async stop(reason = "requested"): Promise<AnalysisRecordMetadata | null> {
    const active = this.activeRecord;
    if (!active) return this.finalizing;
    this.activeRecord = null;
    let agentResult: unknown;
    try { agentResult = await active.session.call("recordStop", []); }
    catch (error) { agentResult = { ok: false, error: (error as Error).message }; }
    return this.finalize(active.id, reason, agentResult);
  }

  private finalize(id: string, reason: string, agentResult?: unknown): Promise<AnalysisRecordMetadata> {
    if (this.finalizing) return this.finalizing;
    const pending = this.store.stop(id, reason, agentResult);
    this.finalizing = pending;
    void pending.then(
      (metadata) => { this.completedRecord = metadataClone(metadata); },
      () => { /* caller reports the persistence failure */ },
    ).finally(() => {
      if (this.finalizing === pending) this.finalizing = null;
    });
    return pending;
  }

  get activeId(): string | null {
    return this.activeRecord?.id ?? null;
  }
}
