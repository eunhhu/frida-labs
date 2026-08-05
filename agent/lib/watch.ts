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

export interface WatchHandle { readonly addr: NativePointer; fired(): number; stop(): void; }
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
  threads: Array<{ thread: ThreadDetails; slot: number }>;
  hits: number;
}

const active = new Map<number, ActiveWatch>();
let nextWatchId = 1;
let handlerInstalled = false;
// Frida exposes a numeric hardware-watchpoint slot. Architectures commonly
// provide fewer than 16; unsupported slots throw and are skipped per thread.
const MAX_WATCHPOINT_SLOTS = 16;

function installExceptionHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  // Registered through the shared dispatcher owned by excrash.ts — NEVER
  // call Process.setExceptionHandler directly. swallow=true so our routine
  // watchpoint traps are handled before any observer (crash reporting).
  addExceptionHandler("watch", (exc) => {
    const hitAddr = exc.memory?.address;
    const currentThread = Process.getCurrentThreadId();
    const isHardwareTrap = exc.type === "breakpoint" || exc.type === "single-step";
    const matches: Array<{ id: number; watch: ActiveWatch }> = [];
    for (const [id, candidate] of active) {
      if (!candidate.threads.some((armed) => armed.thread.id === currentThread)) continue;
      if (hitAddr) {
        const hi = candidate.addr.add(candidate.size);
        if (hitAddr.compare(candidate.addr) >= 0 && hitAddr.compare(hi) < 0) matches.push({ id, watch: candidate });
      } else if (isHardwareTrap) {
        // Darwin/arm64 reports hardware watchpoints as EXC_BREAKPOINT without
        // ExceptionDetails.memory. Frida's own documented example identifies
        // these by current thread + breakpoint/single-step type.
        matches.push({ id, watch: candidate });
      }
    }
    if (matches.length === 0) return false;

    for (const { id, watch: matched } of matches) {
      const triggered = matched.threads.filter((armed) => armed.thread.id === currentThread);
      matched.threads = matched.threads.filter((armed) => armed.thread.id !== currentThread);
      for (const armed of triggered) {
        try { armed.thread.unsetHardwareWatchpoint(armed.slot); } catch { /* thread may be exiting */ }
      }
      matched.hits++;

      let value: number | string = "<unreadable>";
      try { value = RW[matched.type].read(matched.addr); } catch { /* page may have gone away */ }
      let backtrace = "";
      try { backtrace = symbolicate(Thread.backtrace(exc.context, Backtracer.ACCURATE).slice(0, 6)).join("\n    "); }
      catch { /* exception contexts do not always support accurate unwind */ }
      ok(`[watch] ${matched.addr} <- ${value}${backtrace ? `\n    ${backtrace}` : ""}`);

      // Frida's documented pattern disables the watchpoint before swallowing
      // the trap. Re-arm after this exception returns so continuous watches do
      // not immediately retrigger the same instruction.
      setTimeout(() => {
        if (active.get(id) !== matched) return;
        for (const armed of triggered) {
          try {
            armed.thread.setHardwareWatchpoint(armed.slot, matched.addr, matched.size, "w");
            matched.threads.push(armed);
          } catch { /* thread ended or slot became unavailable */ }
        }
      }, 0);
    }
    return true;
  }, true);
}

/**
 * Hardware watchpoint: log (with backtrace) every write the game makes to
 * `addr`. Arms an available slot on every current thread. Call h.stop() to
 * remove it.
 */
export function watch(addr: NativePointer, type: WatchType = "u32"): WatchHandle {
  installExceptionHandler();
  const size = SIZE[type];
  const threads: Array<{ thread: ThreadDetails; slot: number }> = [];
  let armed = 0;
  for (const t of Process.enumerateThreads()) {
    const used = new Set<number>();
    for (const w of active.values()) {
      for (const a of w.threads) if (a.thread.id === t.id) used.add(a.slot);
    }
    for (let slot = 0; slot < MAX_WATCHPOINT_SLOTS; slot++) {
      if (used.has(slot)) continue;
      try {
        t.setHardwareWatchpoint(slot, addr, size, "w");
        threads.push({ thread: t, slot });
        armed++;
        break;
      } catch { /* slot unsupported or unavailable — try the next one */ }
    }
  }
  if (armed === 0) {
    const message = "[watch] could not arm any thread — platform may not support hw watchpoints";
    warn(message);
    throw new Error(message);
  }
  ok(`[watch] armed on ${armed} thread(s) @ ${addr} (${type})`);
  const id = nextWatchId++;
  const record: ActiveWatch = { addr, size, type, threads, hits: 0 };
  active.set(id, record);
  return {
    addr,
    fired: () => record.hits,
    stop() {
      const w = active.get(id);
      if (!w) return;
      active.delete(id);
      for (const a of w.threads) { try { a.thread.unsetHardwareWatchpoint(a.slot); } catch { /* gone */ } }
    },
  };
}

/** Remove every armed watchpoint. */
export function unwatchAll(): void {
  for (const w of active.values()) {
    for (const a of w.threads) { try { a.thread.unsetHardwareWatchpoint(a.slot); } catch { /* */ } }
  }
  active.clear();
}

// --- freeze -----------------------------------------------------------------

/**
 * Re-write `value` to `addr` every `ms` — the classic "freeze HP" cheat.
 * Works even where watchpoints don't. Call fz.stop() to release.
 */
export function freeze(addr: NativePointer, value: number, type: WatchType = "u32", ms = 1): FreezeHandle {
  let fired = 0;
  const timer = setInterval(() => {
    try { RW[type].write(addr, value); fired++; } catch { /* page gone */ }
  }, ms);
  ok(`[freeze] ${addr} = ${value} (${type}) every ${ms}ms`);
  return { addr, value, fired: () => fired, stop() { clearInterval(timer); } };
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
