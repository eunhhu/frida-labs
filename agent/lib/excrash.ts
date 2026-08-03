// Exception / crash reporting — structured reports from gum exceptions.
// Side-effect free at import: the exception handler is installed ONLY by an
// explicit install() call.
//
// OWNERSHIP (b4 decision, architect-approved direction): this module owns the
// single process-global Process.setExceptionHandler via a shared dispatcher.
// Consumers (watch.ts hardware watchpoints, install() crash reporting)
// register handlers; first handler returning true swallows the exception.
// The dispatcher arms lazily on the FIRST registration — import stays
// side-effect free. NEVER call Process.setExceptionHandler outside this file.

import { log, ok } from "./log.js";
import { symbolicate } from "./sym.js";

export interface CrashReport {
  /** e.g. "access-violation", "abort", "illegal-instruction". */
  type: string;
  /** Faulting instruction pointer, symbolicated. */
  pc: string;
  /** For memory faults: address + operation, when present. */
  memory?: { address: string; operation: string };
  /** Symbolicated backtrace (accurate). */
  backtrace: string[];
  /** Raw register dump (best effort per arch). */
  registers: Record<string, string>;
}

export interface ExCrashSession {
  /** Reports collected since install (ring buffer, last 16). */
  readonly reports: CrashReport[];
  /** Remove the handler (idempotent). */
  uninstall(): void;
}

const MAX_REPORTS = 16;
type Handler = (details: ExceptionDetails) => boolean;
const handlers: Array<{ id: string; fn: Handler; swallow: boolean }> = [];
let dispatcherArmed = false;

function armDispatcher(): void {
  if (dispatcherArmed) return;
  dispatcherArmed = true;
  Process.setExceptionHandler((exc) => {
    for (const h of handlers) {
      try { if (h.fn(exc)) return true; } catch { /* a broken handler must not kill the chain */ }
    }
    return false;
  });
}

/**
 * Register an exception handler under a unique id. Returns an idempotent
 * unregister. Handlers with swallow=true (e.g. hardware watchpoints) always
 * run BEFORE observers like crash reporting — observers must never see
 * routine swallowed traps as crashes. Within the same class, registration
 * order is dispatch order. This is the ONLY sanctioned way to hook process
 * exceptions.
 */
export function addExceptionHandler(id: string, fn: Handler, swallow = false): () => void {
  if (handlers.some((h) => h.id === id)) throw new Error(`exception handler '${id}' already registered`);
  armDispatcher();
  const entry = { id, fn, swallow };
  // Swallowing handlers keep relative order and always precede observers.
  const idx = swallow ? handlers.filter((h) => h.swallow).length : handlers.length;
  handlers.splice(idx, 0, entry);
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    const i = handlers.findIndex((h) => h.id === id);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** Build a structured report from a gum exception. */
export function buildReport(details: ExceptionDetails): CrashReport {
  const ctx = details.context;
  const registers: Record<string, string> = {};
  try {
    for (const name of Object.keys(ctx as unknown as Record<string, unknown>)) {
      const v = (ctx as unknown as Record<string, { toString(): string }>)[name];
      if (v && typeof v.toString === "function" && /^0x[0-9a-f]+$/i.test(v.toString())) {
        registers[name] = v.toString();
      }
    }
  } catch { /* register dump is best effort */ }

  let backtrace: string[] = [];
  try {
    backtrace = symbolicate(Thread.backtrace(ctx, Backtracer.ACCURATE));
  } catch { /* corrupted stacks fail the walk */ }

  const report: CrashReport = {
    type: details.type,
    pc: symbolicate([details.address])[0],
    backtrace,
    registers,
  };
  const mem = details.memory;
  if (mem) {
    report.memory = { address: mem.address.toString(), operation: mem.operation };
  }
  return report;
}

/**
 * Install crash reporting through the shared dispatcher and collect
 * structured reports. Report-only: the registered observer never swallows —
 * fatal faults still propagate after every handler ran. Double install()
 * throws via the dispatcher's unique-id rule.
 */
export function install(onReport?: (r: CrashReport) => void): ExCrashSession {
  let handler: ((details: ExceptionDetails) => boolean) | null = null;
  const reports: CrashReport[] = [];

  handler = (details: ExceptionDetails): boolean => {
    const report = buildReport(details);
    reports.push(report);
    if (reports.length > MAX_REPORTS) reports.shift();
    log(`[excrash] ${report.type} at ${report.pc}`);
    try {
      onReport?.(report);
    } catch (e) {
      log(`[excrash] onReport callback threw: ${(e as Error).message}`);
    }
    // false = pass the exception on to the default handler (process still
    // crashes for fatal faults); this module reports, it does not swallow.
    return false;
  };

  const unregister = addExceptionHandler("excrash", (details) => handler!(details));
  ok("excrash handler installed (report-only; faults still propagate)");

  return {
    reports,
    uninstall() {
      if (!handler) return;
      handler = null;
      unregister();
      ok("excrash handler removed");
    },
  };
}
