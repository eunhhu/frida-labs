// Generic native hooking / tracing helpers, target-agnostic.
//
// Firing verification core: on hosts affected by frida #3752 (silent
// Interceptor on some darwin kernels) a hook can attach cleanly yet never
// fire. Every instrument surface (hook/mono.trace/il2cpp/stalker/mam) wraps
// its listener with `withVerification` so callers can distinguish
// "attach ok, not fired yet" from "attach failed". verified:false is NOT
// failed:true — it may just mean the trigger path never ran.

import { log, ok } from "./log.js";

export type VerificationState = "verified" | "unverified" | "failed";

export interface VerificationStatus {
  /** Times the instrumented event was observed. */
  fired: number;
  /** fired >= 1. */
  verified: boolean;
  state: VerificationState;
  detail?: string;
}

export interface Verification {
  readonly fired: number;
  readonly verified: boolean;
  status(): VerificationStatus;
  /** Call from the instrument's event path (onEnter/onAccess/onReceive…). */
  note(): void;
  /** Mark attach/setup failure explicitly (state -> "failed"). */
  fail(detail: string): void;
  /**
   * Warn-by-default firing check: logs a #3752-aware warning when the hook
   * never fired; with { strict: true } throws instead. Returns verified.
   */
  assertFired(opts?: { strict?: boolean; label?: string }): boolean;
  /** Detach the underlying listener (idempotent). */
  detach(): void;
}

/** Wrap any listener-like object with firing verification. */
export function withVerification(listener: { detach(): void } | null, label = "hook"): Verification {
  let fired = 0;
  let failed: string | null = listener === null ? "attach returned null" : null;
  let detached = false;
  const v: Verification = {
    get fired() { return fired; },
    get verified() { return fired >= 1; },
    status(): VerificationStatus {
      return {
        fired,
        verified: fired >= 1,
        state: failed !== null ? "failed" : fired >= 1 ? "verified" : "unverified",
        ...(failed !== null ? { detail: failed } : {}),
      };
    },
    note() { fired++; },
    fail(detail: string) { failed = detail; },
    assertFired(opts = {}) {
      const ok_ = fired >= 1;
      if (!ok_) {
        const msg =
          `[verify] ${opts.label ?? label} never fired (state=${failed !== null ? "failed" : "unverified"}) — ` +
          (failed !== null
            ? `attach failed: ${failed}`
            : "either the trigger path never ran, or this host silently drops Interceptor hits (frida #3752); re-run with a confirmed trigger");
        if (opts.strict) throw new Error(msg);
        log(msg);
      }
      return ok_;
    },
    detach() {
      if (detached) return;
      detached = true;
      try { listener?.detach(); } catch { /* already gone */ }
    },
  };
  return v;
}

export interface TraceOptions {
  name?: string;
  args?: number; // how many arg registers to dump
  backtrace?: boolean;
  onEnter?: (args: InvocationArguments, ctx: CpuContext) => void;
  onLeave?: (ret: InvocationReturnValue) => void;
}

/** Attach a logging tracer to a native address; returns the listener so you can detach(). */
export function trace(target: NativePointer, opts: TraceOptions = {}): InvocationListener {
  const label = opts.name ?? target.toString();
  return Interceptor.attach(target, {
    onEnter(args) {
      const dumped = opts.args ? Array.from({ length: opts.args }, (_, i) => `${i}=${args[i]}`).join(" ") : "";
      log(`[trace] -> ${label} ${dumped}`);
      if (opts.backtrace) {
        log(Thread.backtrace(this.context, Backtracer.ACCURATE).map(DebugSymbol.fromAddress).join("\n"));
      }
      opts.onEnter?.(args, this.context);
    },
    onLeave(ret) {
      if (opts.onLeave) opts.onLeave(ret);
      else log(`[trace] <- ${label} = ${ret}`);
    },
  });
}

/** Replace a function's return value with a constant (quick "always true/false" patches). */
export function stub(target: NativePointer, retValue: NativePointer | number): InvocationListener {
  const v = typeof retValue === "number" ? ptr(retValue) : retValue;
  ok(`stub ${target} -> ${v}`);
  return Interceptor.attach(target, { onLeave(ret) { ret.replace(v); } });
}
/** Replace a native function outright with a JS implementation (NativeCallback). */
export function implementation(
  target: NativePointer,
  fn: (...args: NativePointer[]) => NativePointer | number | void,
  retType: NativeFunctionReturnType = "pointer",
  argTypes: NativeFunctionArgumentType[] = [],
): Verification {
  try {
    const v = withVerification({ detach: () => Interceptor.revert(target) }, `implementation ${target}`);
    // The NativeCallback wrapper feeds note() so fired counts actual JS
    // replacement invocations, not just the replace succeeding.
    Interceptor.replace(target, new NativeCallback(((...args: unknown[]) => { v.note(); return fn(...(args as never[])); }) as never, retType, argTypes as NativeCallbackArgumentType[]));
    ok(`implementation ${target} (js replacement)`);
    return v;
  } catch (e) {
    const v = withVerification(null, `implementation ${target}`);
    v.fail((e as Error).message);
    return v;
  }
}

/** Swap in a pre-compiled replacement pointer (Interceptor.replace). */
export function replace(target: NativePointer, replacement: NativePointer): Verification {
  try {
    Interceptor.replace(target, replacement);
    ok(`replace ${target} -> ${replacement}`);
    return withVerification({ detach: () => Interceptor.revert(target) }, `replace ${target}`);
  } catch (e) {
    const v = withVerification(null, `replace ${target}`);
    v.fail((e as Error).message);
    return v;
  }
}

/** Detach every interceptor and flush — the reliable reset when re-hooking the same address. */
export function detachAll(): void {
  Interceptor.detachAll();
  Interceptor.flush();
  ok("all interceptors detached");
}
