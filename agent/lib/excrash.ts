// Exception / crash reporting — structured reports from gum exceptions.
// Side-effect free at import: the exception handler is installed ONLY by an
// explicit install() call.
//
// OWNERSHIP (b4 design task + architect review): Process.setExceptionHandler
// is process-global — watch.ts dispatch piggybacking vs a shared dispatcher
// here is an open choice. Until b4 lands that decision, install() takes full
// ownership and refuses to double-install. NEVER install at module-eval time.

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
 * Install the process exception handler and collect structured reports.
 * Throws when a handler is already installed by this module — handler
 * ownership is exclusive until the b4 dispatcher decision lands.
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

  Process.setExceptionHandler(handler);
  ok("excrash handler installed (report-only; faults still propagate)");

  return {
    reports,
    uninstall() {
      if (!handler) return;
      Process.setExceptionHandler(() => false);
      handler = null;
      ok("excrash handler removed");
    },
  };
}
