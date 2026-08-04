// Memory watch / poke / freeze — the cheat-engine loop, scriptable.
//
//   poke(ptr, 9999, "u32")            one-shot typed write
//   const fz = freeze(ptr, 9999)      re-write every tick ("freeze HP")
//   fz.stop()
//   const h = watch(ptr, "u32")       log every game write (hw watchpoint)
//   h.stop()
//
// Watchpoints: frida-gum exposes per-thread hardware watchpoints
// (ThreadDetails.setHardwareWatchpoint) — no callback, hits arrive as
// exceptions dispatched by the shared handler owned by excrash.ts
// (addExceptionHandler, swallow=true). We arm every thread, swallow
// watchpoint exceptions whose faulting address is ours, and let everything
// else pass through to the remaining handlers and finally the OS.

import { addExceptionHandler } from "./excrash.js";
import { symbolicate } from "./sym.js";
import { ok, warn } from "./log.js";

export type WatchType = "u8" | "u16" | "u32" | "u64" | "s32" | "float" | "double" | "pointer";

export interface WatchHandle { readonly addr: NativePointer; stop(): void; }
export interface FreezeHandle extends WatchHandle { value: number; }

type Reader = (p: NativePointer) => number | string;
type Writer = (p: NativePointer, v: number) => void;

const RW: Record<WatchType, { read: Reader; write: Writer }> = {
  u8:      { read: (p) => p.readU8(),                 write: (p, v) => p.writeU8(v) },
  u16:     { read: (p) => p.readU16(),                write: (p, v) => p.writeU16(v) },
  u32:     { read: (p) => p.readU32(),                write: (p, v) => p.writeU32(v) },
  u64:     { read: (p) => p.readU64().toString(),     write: (p, v) => p.writeU64(v) },
  s32:     { read: (p) => p.readS32(),                write: (p, v) => p.writeS32(v) },
  float:   { read: (p) => p.readFloat(),              write: (p, v) => p.writeFloat(v) },
  double:  { read: (p) => p.readDouble(),             write: (p, v) => p.writeDouble(v) },
  pointer: { read: (p) => p.readPointer().toString(), write: (p, v) => p.writePointer(ptr(v)) },
};

// pointer width resolved lazily — Process.* at module scope would break the
// lib import-time side-effect invariant (barrel import-safety).
const SIZE: Record<WatchType, number> = {
  u8: 1, u16: 2, u32: 4, u64: 8, s32: 4, float: 4, double: 8,
  get pointer() { return Process.pointerSize; },
};

/** Read once, typed. */
export function peek(addr: NativePointer, type: WatchType = "u32"): number | string {
  return RW[type].read(addr);
}

/** Write once, typed. Returns false if the address is not writable. */
export function poke(addr: NativePointer, value: number, type: WatchType = "u32"): boolean {
  try { RW[type].write(addr, value); return true; } catch { return false; }
}

// --- watch ------------------------------------------------------------------

interface ActiveWatch {
  addr: NativePointer;
  size: number;
  type: WatchType;
  threads: ThreadDetails[];
}

const active = new Map<number, ActiveWatch>();
let handlerInstalled = false;

function installExceptionHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  // Registered through the shared dispatcher owned by excrash.ts — NEVER
  // call Process.setExceptionHandler directly. swallow=true so our routine
  // watchpoint traps are handled before any observer (crash reporting).
  addExceptionHandler("watch", (exc) => {
    const hitAddr = exc.memory?.address;
    if (!hitAddr) return false; // not a memory fault — let the OS deal with it
    for (const w of active.values()) {
      const lo = w.addr, hi = w.addr.add(w.size);
      if (hitAddr.compare(lo) >= 0 && hitAddr.compare(hi) < 0) {
        const v = RW[w.type].read(w.addr);
        const bt = symbolicate(Thread.backtrace(exc.context, Backtracer.ACCURATE).slice(0, 6)).join("\n    ");
        ok(`[watch] ${w.addr} <- ${v}\n    ${bt}`);
        return true; // swallowed — re-arm happens implicitly since DR regs persist
      }
    }
    return false;
  }, true);
}

/**
 * Hardware watchpoint: log (with backtrace) every write the game makes to
 * `addr`. Arms slot 0 on every current thread. Call h.stop() to remove.
 */
export function watch(addr: NativePointer, type: WatchType = "u32"): WatchHandle {
  installExceptionHandler();
  const size = SIZE[type];
  const id = active.size;
  const threads: ThreadDetails[] = [];
  let armed = 0;
  for (const t of Process.enumerateThreads()) {
    try { t.setHardwareWatchpoint(0, addr, size, "w"); threads.push(t); armed++; } catch { /* unsupported thread */ }
  }
  if (armed === 0) warn("[watch] could not arm any thread — platform may not support hw watchpoints");
  else ok(`[watch] armed on ${armed} thread(s) @ ${addr} (${type})`);
  active.set(id, { addr, size, type, threads });
  return {
    addr,
    stop() {
      const w = active.get(id);
      if (!w) return;
      active.delete(id);
      for (const t of w.threads) { try { t.unsetHardwareWatchpoint(0); } catch { /* gone */ } }
    },
  };
}

/** Remove every armed watchpoint. */
export function unwatchAll(): void {
  for (const w of active.values()) {
    for (const t of w.threads) { try { t.unsetHardwareWatchpoint(0); } catch { /* */ } }
  }
  active.clear();
}

// --- freeze -----------------------------------------------------------------

/**
 * Re-write `value` to `addr` every `ms` — the classic "freeze HP" cheat.
 * Works even where watchpoints don't. Call fz.stop() to release.
 */
export function freeze(addr: NativePointer, value: number, type: WatchType = "u32", ms = 1): FreezeHandle {
  const timer = setInterval(() => { try { RW[type].write(addr, value); } catch { /* page gone */ } }, ms);
  ok(`[freeze] ${addr} = ${value} (${type}) every ${ms}ms`);
  return { addr, value, stop() { clearInterval(timer); } };
}

// --- diff -------------------------------------------------------------------

/** Snapshot `addr[0..len]` and report which bytes differ from right now. */
export function diff(before: ArrayBuffer, addr: NativePointer, len: number): string[] {
  const a = new Uint8Array(before);
  let now: ArrayBuffer | null;
  try { now = addr.readByteArray(len); } catch { return ["<unreadable>"]; }
  if (!now) return ["<unreadable>"];
  const b = new Uint8Array(now);
  const out: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(`+0x${i.toString(16)}: ${a[i]!.toString(16)} -> ${b[i]!.toString(16)}`);
  }
  return out;
}

/** Capture a snapshot for a later diff(). */
export function snapshot(addr: NativePointer, len = 64): ArrayBuffer | null {
  try { return addr.readByteArray(len); } catch { return null; }
}
