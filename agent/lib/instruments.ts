// Managed runtime instruments. Unlike the legacy one-shot helpers, every
// trace/watch/freeze receives a stable id and can be inspected, edited,
// stopped, or deleted through RPC without losing ownership of its handle.

import { log } from "./log.js";
import * as watchlib from "./watch.js";

export type InstrumentKind = "trace" | "watch" | "freeze";
export type InstrumentState = "active" | "stopped" | "failed";

export interface InstrumentView {
  id: string;
  kind: InstrumentKind;
  label: string;
  address: string;
  state: InstrumentState;
  fired: number;
  verified: boolean;
  verificationState: "verified" | "unverified" | "failed";
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  stoppedAt?: number;
  detail?: string;
}

export interface InstrumentResult {
  ok: boolean;
  instrument?: InstrumentView;
  instruments?: InstrumentView[];
  deleted?: string;
  stopped?: number;
  failed?: number;
  error?: { code: string; message: string };
}

interface RuntimeHandle {
  fired(): number;
  stop(): void;
}

interface InstrumentRecord {
  id: string;
  kind: InstrumentKind;
  label: string;
  address: NativePointer;
  state: InstrumentState;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  stoppedAt?: number;
  detail?: string;
  firedBase: number;
  handle?: RuntimeHandle;
}

const ACTIVE_LIMIT = 64;
const HISTORY_LIMIT = 256;
const WATCH_TYPES = new Set<watchlib.WatchType>([
  "u8", "u16", "u32", "u64", "s32", "float", "double", "pointer",
]);
const records = new Map<string, InstrumentRecord>();
let nextId = 1;

function failure(code: string, message: string, instrument?: InstrumentView): InstrumentResult {
  return { ok: false, ...(instrument ? { instrument } : {}), error: { code, message } };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a JSON object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`unsupported option ${JSON.stringify(unknown)}`);
}

function type(value: unknown): watchlib.WatchType {
  const candidate = value === undefined ? "u32" : value;
  if (typeof candidate !== "string" || !WATCH_TYPES.has(candidate as watchlib.WatchType)) {
    throw new Error(`type must be one of ${[...WATCH_TYPES].join(", ")}`);
  }
  return candidate as watchlib.WatchType;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return candidate;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function boolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function label(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 120) {
    throw new Error("label must be a non-empty string up to 120 characters");
  }
  return value.trim();
}

function address(value: unknown): NativePointer {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("address must be a hexadecimal pointer such as 0x1234");
  }
  const result = ptr(value);
  if (result.isNull()) throw new Error("address must not be null");
  return result;
}

function currentFired(record: InstrumentRecord): number {
  try { return record.firedBase + (record.handle?.fired() ?? 0); }
  catch { return record.firedBase; }
}

function view(record: InstrumentRecord): InstrumentView {
  const fired = currentFired(record);
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    address: record.address.toString(),
    state: record.state,
    fired,
    verified: fired > 0,
    verificationState: record.state === "failed" ? "failed" : fired > 0 ? "verified" : "unverified",
    config: { ...record.config },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.stoppedAt === undefined ? {} : { stoppedAt: record.stoppedAt }),
    ...(record.detail ? { detail: record.detail } : {}),
  };
}

function activeCount(): number {
  let count = 0;
  for (const record of records.values()) if (record.handle) count++;
  return count;
}

function trimHistory(): void {
  if (records.size <= HISTORY_LIMIT) return;
  for (const [id, record] of records) {
    if (records.size <= HISTORY_LIMIT) break;
    if (!record.handle) records.delete(id);
  }
}

function normalizeConfig(kind: InstrumentKind, raw: unknown): Record<string, unknown> {
  const options = object(raw, "options");
  if (kind === "trace") {
    exactKeys(options, ["args", "backtrace", "log", "label"]);
    return {
      args: boundedInteger(options.args, 0, 0, 16, "args"),
      backtrace: boolean(options.backtrace, false, "backtrace"),
      log: boolean(options.log, false, "log"),
      label: label(options.label, "trace"),
    };
  }
  if (kind === "watch") {
    exactKeys(options, ["type", "label"]);
    return { type: type(options.type), label: label(options.label, "watch") };
  }
  exactKeys(options, ["type", "value", "intervalMs", "label"]);
  return {
    type: type(options.type),
    value: finiteNumber(options.value, "value"),
    intervalMs: boundedInteger(options.intervalMs, 10, 1, 60_000, "intervalMs"),
    label: label(options.label, "freeze"),
  };
}

function runtime(kind: InstrumentKind, target: NativePointer, config: Record<string, unknown>): RuntimeHandle {
  if (kind === "watch") {
    return watchlib.watch(target, config.type as watchlib.WatchType);
  }
  if (kind === "freeze") {
    return watchlib.freeze(
      target,
      config.value as number,
      config.type as watchlib.WatchType,
      config.intervalMs as number,
    );
  }

  let fired = 0;
  const argsToLog = config.args as number;
  const shouldLog = config.log as boolean;
  const shouldBacktrace = config.backtrace as boolean;
  const traceLabel = config.label as string;
  const listener = Interceptor.attach(target, {
    onEnter(args) {
      fired++;
      if (!shouldLog) return;
      const values = argsToLog
        ? Array.from({ length: argsToLog }, (_, index) => `${index}=${args[index]}`).join(" ")
        : "";
      log(`[trace:${traceLabel}] -> ${target}${values ? ` ${values}` : ""}`);
      if (shouldBacktrace) log(Thread.backtrace(this.context, Backtracer.ACCURATE).join("\n"));
    },
  });
  return { fired: () => fired, stop: () => listener.detach() };
}

function kind(value: unknown): InstrumentKind {
  if (value !== "trace" && value !== "watch" && value !== "freeze") {
    throw new Error("kind must be trace, watch, or freeze");
  }
  return value;
}

function stopRecord(record: InstrumentRecord): InstrumentResult {
  if (!record.handle) return { ok: true, instrument: view(record) };
  try {
    const handle = record.handle;
    const fired = handle.fired();
    handle.stop();
    record.firedBase += fired;
    delete record.handle;
    record.state = "stopped";
    record.updatedAt = Date.now();
    record.stoppedAt = record.updatedAt;
    delete record.detail;
    return { ok: true, instrument: view(record) };
  } catch (error) {
    record.state = "failed";
    record.updatedAt = Date.now();
    record.detail = `stop failed: ${(error as Error).message}`;
    return failure("stop-failed", record.detail, view(record));
  }
}

export function instrumentStart(kindValue: unknown, addressValue: unknown, options?: unknown): InstrumentResult {
  let instrumentKind: InstrumentKind;
  let target: NativePointer;
  let config: Record<string, unknown>;
  try {
    instrumentKind = kind(kindValue);
    target = address(addressValue);
    config = normalizeConfig(instrumentKind, options);
  } catch (error) {
    return failure("invalid-config", (error as Error).message);
  }
  if (activeCount() >= ACTIVE_LIMIT) return failure("active-limit", `at most ${ACTIVE_LIMIT} instruments may be active`);

  const now = Date.now();
  const record: InstrumentRecord = {
    id: `ins-${nextId++}`,
    kind: instrumentKind,
    label: config.label as string,
    address: target,
    state: "active",
    config,
    createdAt: now,
    updatedAt: now,
    firedBase: 0,
  };
  records.set(record.id, record);
  try {
    record.handle = runtime(instrumentKind, target, config);
  } catch (error) {
    record.state = "failed";
    record.detail = (error as Error).message;
    trimHistory();
    return failure("start-failed", record.detail, view(record));
  }
  trimHistory();
  return { ok: true, instrument: view(record) };
}

export function instrumentList(state?: unknown): InstrumentResult {
  if (state === null) state = undefined;
  if (state !== undefined && state !== "active" && state !== "stopped" && state !== "failed") {
    return failure("invalid-filter", "state must be active, stopped, or failed");
  }
  const instruments = [...records.values()]
    .filter((record) => state === undefined || record.state === state)
    .map(view);
  return { ok: true, instruments };
}

export function instrumentStatus(id: unknown): InstrumentResult {
  if (typeof id !== "string" || !id) return failure("invalid-id", "id must be a non-empty string");
  const record = records.get(id);
  return record ? { ok: true, instrument: view(record) } : failure("not-found", `instrument ${JSON.stringify(id)} does not exist`);
}

export function instrumentUpdate(id: unknown, patchValue: unknown): InstrumentResult {
  if (typeof id !== "string" || !id) return failure("invalid-id", "id must be a non-empty string");
  const record = records.get(id);
  if (!record) return failure("not-found", `instrument ${JSON.stringify(id)} does not exist`);
  if (!record.handle) return failure("not-active", `instrument ${JSON.stringify(id)} is not active`, view(record));

  let nextAddress: NativePointer;
  let nextConfig: Record<string, unknown>;
  try {
    const patch = object(patchValue, "patch");
    exactKeys(patch, ["address", "args", "backtrace", "log", "type", "value", "intervalMs", "label"]);
    nextAddress = patch.address === undefined ? record.address : address(patch.address);
    const optionPatch = { ...record.config, ...patch };
    delete optionPatch.address;
    nextConfig = normalizeConfig(record.kind, optionPatch);
  } catch (error) {
    return failure("invalid-config", (error as Error).message, view(record));
  }

  let replacement: RuntimeHandle;
  try {
    replacement = runtime(record.kind, nextAddress, nextConfig);
  } catch (error) {
    return failure("update-failed", `replacement could not start: ${(error as Error).message}`, view(record));
  }

  try {
    const previous = record.handle;
    const fired = previous.fired();
    previous.stop();
    record.firedBase += fired;
  } catch (error) {
    try { replacement.stop(); } catch { /* best effort */ }
    record.state = "failed";
    record.detail = `previous handle could not stop: ${(error as Error).message}`;
    record.updatedAt = Date.now();
    return failure("update-failed", record.detail, view(record));
  }

  record.handle = replacement;
  record.address = nextAddress;
  record.config = nextConfig;
  record.label = nextConfig.label as string;
  record.state = "active";
  record.updatedAt = Date.now();
  delete record.stoppedAt;
  delete record.detail;
  return { ok: true, instrument: view(record) };
}

export function instrumentStop(id: unknown): InstrumentResult {
  if (typeof id !== "string" || !id) return failure("invalid-id", "id must be a non-empty string");
  const record = records.get(id);
  return record ? stopRecord(record) : failure("not-found", `instrument ${JSON.stringify(id)} does not exist`);
}

export function instrumentDelete(id: unknown): InstrumentResult {
  if (typeof id !== "string" || !id) return failure("invalid-id", "id must be a non-empty string");
  const record = records.get(id);
  if (!record) return failure("not-found", `instrument ${JSON.stringify(id)} does not exist`);
  const stopped = stopRecord(record);
  if (!stopped.ok) return stopped;
  records.delete(id);
  return { ok: true, deleted: id };
}

export function instrumentStopAll(): InstrumentResult {
  let stopped = 0;
  let failed = 0;
  for (const record of records.values()) {
    if (!record.handle) continue;
    const result = stopRecord(record);
    if (result.ok) stopped++;
    else failed++;
  }
  return {
    ok: failed === 0,
    stopped,
    failed,
    instruments: [...records.values()].map(view),
    ...(failed ? { error: { code: "stop-failed", message: `${failed} instrument(s) could not stop` } } : {}),
  };
}
