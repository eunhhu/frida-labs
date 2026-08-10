/// <reference path="../globals.d.ts" />
// Bounded function-call recording for human-play analysis. The target emits
// structured events; host code persists and summarizes them for AI agents.

import {
  control,
  hook,
  instrumentDescriptors,
  instrumentHandlers,
  read,
  type InstrumentActions,
} from "./instrument.js";

export const RECORD_EVENT_SCHEMA = "flab.record.event.v1";

export interface RecordCandidate {
  id: string;
  name: string;
  module: string;
  address: string;
  source: "export" | "symbol";
}

export interface RecordProbe {
  id?: string;
  name?: string;
  address: string;
  args?: number;
  captureReturn?: boolean;
  backtrace?: boolean;
}

export interface RecordOptions {
  maxEvents?: number;
  perProbeLimit?: number;
  sampleEvery?: number;
  maxDurationMs?: number;
}

interface NormalizedProbe {
  id: string;
  name: string;
  address: NativePointer;
  args: number;
  captureReturn: boolean;
  backtrace: boolean;
}

interface ActiveProbe {
  probe: NormalizedProbe;
  listener: InvocationListener;
  hits: number;
  captured: number;
}

interface ActiveRecord {
  id: string;
  startedAt: number;
  sequence: number;
  emitted: number;
  dropped: number;
  options: Required<RecordOptions>;
  probes: ActiveProbe[];
  timer: ReturnType<typeof setTimeout>;
  stopScheduled: boolean;
}

interface CallContext {
  callId: string;
  startedAt: number;
  capture: boolean;
}

let active: ActiveRecord | null = null;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  const extra = Object.keys(value).find((field) => !fields.includes(field));
  if (extra) throw new Error(`unsupported ${JSON.stringify(extra)} in recording plan`);
}

function integer(value: unknown, fallback: number, min: number, max: number, field: string): number {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return selected;
}

function bool(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function text(value: unknown, fallback: string, field: string, max = 200): string {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "string" || !selected.trim() || selected.length > max) {
    throw new Error(`${field} must be a non-empty string up to ${max} characters`);
  }
  return selected.trim();
}

function normalizeOptions(value: unknown): Required<RecordOptions> {
  const options = value === undefined || value === null ? {} : object(value, "options");
  exact(options, ["maxEvents", "perProbeLimit", "sampleEvery", "maxDurationMs"]);
  return {
    maxEvents: integer(options.maxEvents, 50_000, 1, 100_000, "maxEvents"),
    perProbeLimit: integer(options.perProbeLimit, 10_000, 1, 50_000, "perProbeLimit"),
    sampleEvery: integer(options.sampleEvery, 1, 1, 10_000, "sampleEvery"),
    maxDurationMs: integer(options.maxDurationMs, 30 * 60_000, 1_000, 2 * 60 * 60_000, "maxDurationMs"),
  };
}

function normalizeProbes(value: unknown): NormalizedProbe[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("probes must contain 1..64 entries");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const probe = object(entry, `probes[${index}]`);
    exact(probe, ["id", "name", "address", "args", "captureReturn", "backtrace"]);
    const addressText = text(probe.address, "", `probes[${index}].address`, 64);
    if (!/^0x[0-9a-f]+$/i.test(addressText)) throw new Error(`probes[${index}].address must be a hexadecimal pointer`);
    const address = ptr(addressText);
    if (address.isNull()) throw new Error(`probes[${index}].address must not be null`);
    const id = text(probe.id, `fn-${index + 1}`, `probes[${index}].id`, 96);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || ids.has(id)) throw new Error(`probes[${index}].id must be unique and identifier-safe`);
    ids.add(id);
    return {
      id,
      name: text(probe.name, addressText, `probes[${index}].name`, 300),
      address,
      args: integer(probe.args, 4, 0, 16, `probes[${index}].args`),
      captureReturn: bool(probe.captureReturn, true, `probes[${index}].captureReturn`),
      backtrace: bool(probe.backtrace, false, `probes[${index}].backtrace`),
    };
  });
}

function emit(record: ActiveRecord, event: Record<string, unknown>): void {
  if (record.emitted >= record.options.maxEvents) {
    record.dropped++;
    scheduleStop(record, "event-limit");
    return;
  }
  record.emitted++;
  send({
    type: "flab.record.event",
    schema: RECORD_EVENT_SCHEMA,
    recordId: record.id,
    sequence: record.emitted,
    event,
  });
  if (record.emitted >= record.options.maxEvents) scheduleStop(record, "event-limit");
}

function scheduleStop(record: ActiveRecord, reason: string): void {
  if (record.stopScheduled) return;
  record.stopScheduled = true;
  setTimeout(() => {
    if (active === record) stop(reason);
  }, 0);
}

function stop(reason: string): Record<string, unknown> {
  const record = active;
  if (!record) return { ok: true, active: false, reason: "not-active" };
  active = null;
  clearTimeout(record.timer);
  const failures: string[] = [];
  for (const item of record.probes) {
    try { item.listener.detach(); }
    catch (error) { failures.push(`${item.probe.id}: ${(error as Error).message}`); }
  }
  const result = {
    ok: failures.length === 0,
    active: false,
    recordId: record.id,
    reason,
    startedAt: record.startedAt,
    stoppedAt: Date.now(),
    emitted: record.emitted,
    dropped: record.dropped,
    probes: record.probes.map((item) => ({
      id: item.probe.id,
      name: item.probe.name,
      address: item.probe.address.toString(),
      hits: item.hits,
      captured: item.captured,
    })),
    ...(failures.length ? { failures } : {}),
  };
  send({ type: "flab.record.state", recordId: record.id, state: "stopped", result });
  return result;
}

/** Search bounded native exports/symbols before arming hooks. */
export function recordPlan(queryValue: unknown, moduleValue?: unknown, limitValue?: unknown): Record<string, unknown> {
  const query = text(queryValue, "", "query").toLowerCase();
  const moduleName = moduleValue === undefined || moduleValue === null || moduleValue === ""
    ? null
    : text(moduleValue, "", "module", 300);
  const limit = integer(limitValue, 24, 1, 100, "limit");
  const modules = moduleName
    ? Process.enumerateModules().filter((module) => module.name.toLowerCase() === moduleName.toLowerCase())
    : Process.enumerateModules();
  if (moduleName && modules.length === 0) throw new Error(`module ${JSON.stringify(moduleName)} not found`);
  const found = new Map<string, RecordCandidate>();
  let matched = 0;
  const add = (module: Module, name: string, address: NativePointer, source: "export" | "symbol"): void => {
    if (!name.toLowerCase().includes(query)) return;
    matched++;
    const key = address.toString();
    if (found.has(key) || found.size >= limit) return;
    found.set(key, {
      id: `fn-${found.size + 1}`,
      name: `${module.name}!${name}`,
      module: module.name,
      address: key,
      source,
    });
  };
  for (const module of modules) {
    for (const entry of module.enumerateExports()) add(module, entry.name, entry.address, "export");
    if (moduleName) {
      try {
        for (const entry of module.enumerateSymbols()) add(module, entry.name, entry.address, "symbol");
      } catch { /* symbols unsupported on this target */ }
    }
  }
  return { query, module: moduleName, candidates: [...found.values()], matched, truncated: matched > found.size };
}

/** Arm one bounded recording session. Host supplies record id and persists events. */
export function recordStart(recordIdValue: unknown, probesValue: unknown, optionsValue?: unknown): Record<string, unknown> {
  if (active) return { ok: false, error: { code: "already-active", message: `record ${active.id} is active` } };
  let recordId: string;
  let probes: NormalizedProbe[];
  let options: Required<RecordOptions>;
  try {
    recordId = text(recordIdValue, "", "recordId", 96);
    if (!/^rec-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recordId)) throw new Error("recordId must start with rec- and contain identifier-safe characters");
    probes = normalizeProbes(probesValue);
    options = normalizeOptions(optionsValue);
  } catch (error) {
    return { ok: false, error: { code: "invalid-plan", message: (error as Error).message } };
  }

  const startedAt = Date.now();
  const record: ActiveRecord = {
    id: recordId,
    startedAt,
    sequence: 0,
    emitted: 0,
    dropped: 0,
    options,
    probes: [],
    timer: setTimeout(() => stop("duration-limit"), options.maxDurationMs),
    stopScheduled: false,
  };
  try {
    for (const probe of probes) {
      const item: ActiveProbe = { probe, listener: null as unknown as InvocationListener, hits: 0, captured: 0 };
      item.listener = Interceptor.attach(probe.address, {
        onEnter(args) {
          item.hits++;
          const context = this as InvocationContext & { __flabRecord?: CallContext };
          const capture = item.captured < options.perProbeLimit && item.hits % options.sampleEvery === 0;
          if (!capture) {
            context.__flabRecord = { callId: "", startedAt: 0, capture: false };
            return;
          }
          item.captured++;
          const callId = `${probe.id}:${++record.sequence}`;
          const callStartedAt = Date.now();
          context.__flabRecord = { callId, startedAt: callStartedAt, capture: true };
          emit(record, {
            phase: "enter",
            callId,
            probeId: probe.id,
            function: probe.name,
            address: probe.address.toString(),
            timestamp: callStartedAt,
            threadId: Process.getCurrentThreadId(),
            args: Array.from({ length: probe.args }, (_, index) => args[index].toString()),
            ...(probe.backtrace
              ? { backtrace: Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 32).map((address) => DebugSymbol.fromAddress(address).toString()) }
              : {}),
          });
        },
        onLeave(retval) {
          const context = this as InvocationContext & { __flabRecord?: CallContext };
          const call = context.__flabRecord;
          if (!call?.capture || !probe.captureReturn) return;
          const timestamp = Date.now();
          emit(record, {
            phase: "leave",
            callId: call.callId,
            probeId: probe.id,
            function: probe.name,
            address: probe.address.toString(),
            timestamp,
            durationMs: Math.max(0, timestamp - call.startedAt),
            threadId: Process.getCurrentThreadId(),
            returnValue: retval.toString(),
          });
        },
      });
      record.probes.push(item);
    }
    active = record;
    send({ type: "flab.record.state", recordId, state: "active", probes: probes.length, options });
    return { ok: true, active: true, recordId, startedAt, probes: probes.length, options };
  } catch (error) {
    clearTimeout(record.timer);
    for (const item of record.probes) try { item.listener.detach(); } catch { /* best effort */ }
    return { ok: false, error: { code: "hook-failed", message: (error as Error).message } };
  }
}

export function recordStatus(): Record<string, unknown> {
  if (!active) return { ok: true, active: false };
  return {
    ok: true,
    active: true,
    recordId: active.id,
    startedAt: active.startedAt,
    emitted: active.emitted,
    dropped: active.dropped,
    options: active.options,
    probes: active.probes.map((item) => ({
      id: item.probe.id,
      name: item.probe.name,
      address: item.probe.address.toString(),
      hits: item.hits,
      captured: item.captured,
    })),
  };
}

export function recordStop(): Record<string, unknown> {
  return stop("requested");
}

/** Reusable RPC surface for every generic probe and game Instrument. */
export function recordingRpcSurface() {
  return instrumentHandlers(recordingInstrumentActions());
}

/** One truthful descriptor inventory shared by human and agent interfaces. */
export function recordingDescriptors(): unknown[] {
  return instrumentDescriptors(recordingInstrumentActions());
}

/** Declarative entries for targets using defineInstrument(). */
export function recordingInstrumentActions(): InstrumentActions {
  return {
    recordPlan: read({
      label: "Plan function recording",
      category: "Record",
      args: [{ name: "query", type: "string" }, { name: "module", type: "string?" }, { name: "limit", type: "integer?" }],
      doc: "Find bounded native export/symbol candidates before human-play recording",
      returns: "table",
    }, recordPlan),
    recordStart: hook({
      label: "Start analysis Record",
      category: "Record",
      args: [{ name: "recordId", type: "string" }, { name: "probes", type: "json" }, { name: "options", type: "json?" }],
      doc: "Hook 1..64 selected functions and emit bounded timing, raw argument, return, thread, and optional backtrace events",
      returns: "verification",
      status: "recordStatus",
    }, recordStart),
    recordStatus: read({
      label: "Read Record status",
      category: "Record",
      doc: "Read active Record counts and per-function hits",
    }, recordStatus),
    recordStop: control({
      label: "Stop analysis Record",
      category: "Record",
      doc: "Detach every Record hook and return bounded counts",
      returns: "verification",
      status: "recordStatus",
    }, recordStop),
  };
}
