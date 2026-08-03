// Stalker — code tracing / coverage, target-agnostic.
// Side-effect free at import; every entry point is explicit (follow/unfollow).
//
// Stalking a busy thread is expensive: by default every module except the
// main one is excluded (system libraries generate most of the noise), and
// events are summarized and flushed on an interval instead of being logged
// per-event. Capture is firing-verified like every other instrument.

import { log, ok } from "./log.js";
import { withVerification, type Verification, type VerificationStatus } from "./hook.js";

export interface StalkerEventMask {
  call?: boolean;   // direct calls (default true)
  ret?: boolean;    // returns (default false — very noisy)
  exec?: boolean;   // every executed instruction (default false)
  block?: boolean;  // basic blocks (default false)
  compile?: boolean; // compiled blocks (default false — useful for coverage)
}

export interface StalkerSessionOptions {
  /** Which event types to capture. Default: { call: true }. */
  events?: StalkerEventMask;
  /**
   * Extra ranges to exclude, on top of the defaults. Default exclusion:
   * every loaded module EXCEPT the main one (keeps system-library noise out).
   * Pass { excludeDefaults: false } to stalk everything.
   */
  excludeRanges?: Array<{ base: NativePointer; size: number }>;
  excludeDefaults?: boolean;
  /** Summary flush interval in ms. Default 2000; 0 disables periodic flush. */
  summaryIntervalMs?: number;
  /** Called with each parsed event line (already stringified). Off by default. */
  onEvent?: (line: string) => void;
}

export interface StalkerSummary {
  tid: number;
  counts: Record<string, number>;
  total: number;
  excludedRanges: number;
  verification: VerificationStatus;
}

export interface StalkerSession {
  readonly tid: number;
  readonly verification: Verification;
  summary(): StalkerSummary;
  /** Flush the accumulated counts to the log (also runs on the interval). */
  flushSummary(): StalkerSummary;
  /** Stop stalking and flush a final summary. Idempotent. */
  stop(): StalkerSummary;
}

function defaultExclusions(): Array<{ base: NativePointer; size: number }> {
  const mods = Process.enumerateModules();
  return mods.slice(1).map((m) => ({ base: m.base, size: m.size }));
}

/** Start stalking one thread (default: the current one). */
export function follow(tid?: ThreadId, opts: StalkerSessionOptions = {}): StalkerSession {
  const threadId = tid ?? Process.getCurrentThreadId();
  const events = { call: true, ...opts.events };
  const excludeDefaults = opts.excludeDefaults !== false;
  const ranges = [
    ...(excludeDefaults ? defaultExclusions() : []),
    ...(opts.excludeRanges ?? []),
  ];
  for (const r of ranges) Stalker.exclude({ base: r.base, size: r.size });

  const counts: Record<string, number> = {};
  let total = 0;
  let stopped = false;

  // Stalker.follow has no detach handle; verification detach stops the session.
  const verification = withVerification({ detach: () => stop() }, `stalker tid=${threadId}`);

  const drain = (raw: ArrayBuffer): void => {
    let parsed: unknown[][];
    try {
      parsed = Stalker.parse(raw, { annotate: false, stringify: true }) as unknown as unknown[][];
    } catch {
      return; // partial event blob — next flush covers it
    }
    for (const ev of parsed) {
      // annotate:false yields BARE events ([location, target], no kind) on
      // some frida versions and FULL events (["call", location, target]) on
      // others — detect per event instead of trusting the typings union.
      const first = ev[0];
      const kind = typeof first === "string" && /^[a-z]+$/.test(first) ? first : "bare";
      counts[kind] = (counts[kind] ?? 0) + 1;
      total++;
      verification.note();
      if (opts.onEvent) opts.onEvent(ev.map(String).join(" "));
    }
  };

  try {
    Stalker.follow(threadId, { events, onReceive: drain });
  } catch (e) {
    verification.fail((e as Error).message);
  }
  ok(`stalker following tid=${threadId} events=${JSON.stringify(events)} excluded=${ranges.length} range(s)`);

  const summary = (): StalkerSummary => ({
    tid: threadId,
    counts: { ...counts },
    total,
    excludedRanges: ranges.length,
    verification: verification.status(),
  });
  const flush = (): StalkerSummary => {
    const s = summary();
    log(`[stalker] tid=${threadId} total=${s.total} ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    return s;
  };
  const stop = (): StalkerSummary => {
    if (stopped) return summary();
    stopped = true;
    if (timer) clearInterval(timer);
    // Drain buffered events BEFORE unfollow: they only reach onReceive on the
    // queue-drain tick, so a short sample without flush reports total=0.
    try { Stalker.flush(); } catch { /* best effort */ }
    try { Stalker.unfollow(threadId); } catch { /* thread may be gone */ }
    Stalker.garbageCollect();
    ok(`stalker stopped tid=${threadId}`);
    return flush();
  };

  const interval = opts.summaryIntervalMs ?? 2000;
  const timer = interval > 0 ? setInterval(flush, interval) : null;

  return { tid: threadId, verification, summary, flushSummary: flush, stop };
}

/** Convenience: stalk a thread for `ms`, then stop and return the summary. */
export function sample(ms: number, tid?: ThreadId, opts: StalkerSessionOptions = {}): Promise<StalkerSummary> {
  const session = follow(tid, { summaryIntervalMs: 0, ...opts });
  return new Promise((resolve) => setTimeout(() => resolve(session.stop()), ms));
}
