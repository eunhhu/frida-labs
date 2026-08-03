// MemoryAccessMonitor — watch memory ranges for reads/writes/executions.
// Side-effect free at import; monitoring starts only via enable().
//
// Platform caveats (documented failure modes, call sites should surface them):
//  - MemoryAccessMonitor.enable() THROWS for misaligned/unguardable ranges;
//    our enable() never rethrows — failures land in verification state
//    "failed" (see enable()).
//  - Platform finding (darwin 26.5.2 arm64, SIP on): enable() SUCCEEDS but
//    access callbacks are never delivered — silent non-delivery, exactly the
//    failure class firing-verification exists for. On this host a demo
//    reporting verified:false is the honest, expected result; never treat
//    enable() success as evidence of hits.
//  - Fault race: access callbacks can still arrive briefly AFTER disable()
//    while the fault queue drains, and a page freed mid-monitoring can produce
//    a final callback for an already-dead address. Callers must tolerate
//    callbacks for torn-down state (all callbacks are wrapped in try/catch).

import { log, ok } from "./log.js";
import { withVerification, type Verification } from "./hook.js";

export interface MamRange {
  base: NativePointer;
  size: number;
}

export interface MamSession {
  readonly verification: Verification;
  readonly ranges: MamRange[];
  /** True between a successful enable() and disable(). */
  readonly active: boolean;
  /** Stop monitoring (idempotent). */
  disable(): void;
}

export interface MamOptions {
  ranges: MamRange[];
  /** Access callback — wrapped in try/catch; may fire briefly after disable(). */
  onAccess: (details: MemoryAccessDetails) => void;
  /** Log every access (default false — very noisy). */
  logAccess?: boolean;
}

/**
 * Enable a monitor over the given ranges. Never throws: setup failures are
 * captured in verification.status() (state "failed") so callers can branch
 * on it instead of crashing the agent.
 */
export function enable(opts: MamOptions): MamSession {
  const verification = withVerification({ detach: () => disable() }, "mam");
  let active = false;

  const guarded = (details: MemoryAccessDetails): void => {
    verification.note();
    if (opts.logAccess) {
      log(`[mam] ${details.operation} ${details.address} from ${details.from}`);
    }
    try {
      opts.onAccess(details);
    } catch (e) {
      log(`[mam] onAccess callback threw: ${(e as Error).message}`);
    }
  };

  try {
    MemoryAccessMonitor.enable(opts.ranges, { onAccess: guarded });
    active = true;
    ok(`mam watching ${opts.ranges.length} range(s)`);
  } catch (e) {
    verification.fail((e as Error).message);
    log(`[mam] enable failed: ${(e as Error).message} (page alignment? unsupported range?)`);
  }

  function disable(): void {
    if (!active) return;
    active = false;
    try { MemoryAccessMonitor.disable(); } catch { /* already disabled */ }
    ok("mam disabled");
  }

  return {
    verification,
    ranges: opts.ranges,
    get active() { return active; },
    disable,
  };
}

/**
 * One-shot demo helper: watch `range` for `ms`, calling `trigger` once right
 * after enabling, then report the verification status.
 */
export function probe(
  range: MamRange,
  ms: number,
  trigger: () => void,
): Promise<{ fired: number; verified: boolean }> {
  const session = enable({ ranges: [range], onAccess: () => {} });
  if (!session.active) return Promise.resolve({ fired: 0, verified: false });
  try { trigger(); } catch { /* trigger must not kill the agent */ }
  return new Promise((resolve) =>
    setTimeout(() => {
      session.disable();
      resolve({ fired: session.verification.fired, verified: session.verification.verified });
    }, ms),
  );
}
