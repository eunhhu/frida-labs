// Generic native hooking / tracing helpers, target-agnostic.

import { log, ok } from "./log.js";

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

/** Detach every interceptor and flush — the reliable reset when re-hooking the same address. */
export function detachAll(): void {
  Interceptor.detachAll();
  Interceptor.flush();
  ok("all interceptors detached");
}
