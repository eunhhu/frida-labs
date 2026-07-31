// Generic UE on-screen drawing: call UCanvas draw UFunctions through
// UObject::ProcessEvent, and drive them from an AHUD::PostRender hook so the
// Canvas is valid. ProcessEvent and the PostRender vtable slot are found at
// runtime. Reusable for any UE5 game with a Canvas HUD.

import { rP, rF } from "../mem.js";
import { OA, objAt, classNameOf, nameOf, isA, propOff, inModule, findClass, findFunc, defaultActorVtable } from "./reflection.js";

const HUD_CANVAS = 0x2f8; // AHUD::Canvas (UCanvas*), valid during PostRender
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Locate UObject::ProcessEvent: the shared vtable slot invoked with a UFunction as arg2. */
export async function findProcessEvent(ms = 700): Promise<{ slot: number; addr: NativePointer } | null> {
  const vts: NativePointer[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < OA.num && vts.length < 250; i += Math.max(1, (OA.num / 2500) | 0)) {
    const o = objAt(i); if (!o) continue;
    const vt = rP(o);
    if (vt && inModule(vt) && !seen.has(vt.toString())) { seen.add(vt.toString()); vts.push(vt); }
  }
  const cand: NativePointer[] = [];
  for (let s = 50; s < 90; s++) {
    const freq: Record<string, number> = {};
    for (const vt of vts) { const p = rP(vt.add(s * 8)); if (p && inModule(p)) freq[p.toString()] = (freq[p.toString()] || 0) + 1; }
    let best: string | null = null, bc = 0;
    for (const k in freq) if (freq[k] > bc) { bc = freq[k]; best = k; }
    if (best && bc >= vts.length * 0.7) cand.push(ptr(best));
  }
  let hit: { slot: number; addr: NativePointer } | null = null;
  const hooks: InvocationListener[] = [];
  cand.forEach((addr, slot) => {
    try {
      hooks.push(Interceptor.attach(addr, { onEnter(a) {
        if (hit) return;
        const fn = a[1];
        if (fn && !fn.isNull()) { try { if (classNameOf(fn) === "Function") hit = { slot, addr }; } catch { /* */ } }
      } }));
    } catch { /* */ }
  });
  await sleep(ms);
  hooks.forEach((h) => { try { h.detach(); } catch { /* */ } });
  Interceptor.flush();
  return hit;
}

/** Locate the AHUD render slot: a vtable override entered while Canvas is set. */
export async function findHudRenderSlot(hud: NativePointer, ms = 800): Promise<{ slot: number; vt: NativePointer } | null> {
  const hudVt = rP(hud);
  if (!hudVt) return null;
  const actorVt = defaultActorVtable();
  const diff: number[] = [];
  for (let s = 0; s < 300; s++) {
    const a = rP(hudVt.add(s * 8));
    const b = actorVt && rP(actorVt.add(s * 8));
    if (a && inModule(a) && (!b || !a.equals(b))) diff.push(s);
  }
  const counts: Record<number, number> = {};
  const hooks: InvocationListener[] = [];
  for (const s of diff) {
    const addr = rP(hudVt.add(s * 8));
    if (!addr) continue;
    try { hooks.push(Interceptor.attach(addr, { onEnter(a) { const t = a[0]; if (t && rP(t.add(HUD_CANVAS))) counts[s] = (counts[s] || 0) + 1; } })); } catch { /* */ }
  }
  await sleep(ms);
  hooks.forEach((h) => { try { h.detach(); } catch { /* */ } });
  Interceptor.flush();
  let best: number | null = null, bc = 0;
  for (const s in counts) if (counts[s] > bc) { bc = counts[s]; best = +s; }
  return best == null ? null : { slot: best, vt: hudVt };
}

export function liveHud(): NativePointer | null {
  for (let i = 0; i < OA.num; i++) { const o = objAt(i); if (o && isA(o, "HUD") && !(nameOf(o) ?? "").startsWith("Default__")) return o; }
  return null;
}

export type DrawFn = (canvas: NativePointer, W: number, H: number) => void;

/** A Canvas draw surface bound to ProcessEvent — call drawBox/drawLine inside an onDraw callback. */
export class UeCanvas {
  private pe!: NativeFunction<void, [NativePointer, NativePointer, NativePointer]>;
  private drawBoxFn: NativePointer | null = null;
  private drawLineFn: NativePointer | null = null;
  private buf = Memory.alloc(0x40);
  private hook: InvocationListener | null = null;
  clipX: number | null = null;
  clipY: number | null = null;
  ready = false;

  async init(): Promise<string> {
    const pe = await findProcessEvent();
    if (!pe) return "[ue] ProcessEvent not found";
    this.pe = new NativeFunction(pe.addr, "void", ["pointer", "pointer", "pointer"]);
    const cc = findClass("Canvas");
    this.drawBoxFn = cc && findFunc(cc, "K2_DrawBox");
    this.drawLineFn = cc && findFunc(cc, "K2_DrawLine");
    this.ready = !!this.drawBoxFn;
    return `[ue] canvas ready (ProcessEvent slot ${pe.slot}, K2_DrawBox ${this.drawBoxFn ? "ok" : "MISSING"})`;
  }

  // Both K2_DrawBox and K2_DrawLine share the param layout:
  //   FVector2D a@0x00, FVector2D b@0x10, float thickness@0x20, FLinearColor@0x24.
  drawBox(cv: NativePointer, x: number, y: number, w: number, h: number, th: number, r: number, g: number, b: number, a: number): void {
    if (!this.drawBoxFn) return;
    const B = this.buf;
    B.writeDouble(x); B.add(8).writeDouble(y);
    B.add(0x10).writeDouble(w); B.add(0x18).writeDouble(h);
    B.add(0x20).writeFloat(th);
    B.add(0x24).writeFloat(r); B.add(0x28).writeFloat(g); B.add(0x2c).writeFloat(b); B.add(0x30).writeFloat(a);
    this.pe(cv, this.drawBoxFn, B);
  }

  drawLine(cv: NativePointer, x1: number, y1: number, x2: number, y2: number, th: number, r: number, g: number, b: number, a: number): void {
    if (!this.drawLineFn) return;
    const B = this.buf;
    B.writeDouble(x1); B.add(8).writeDouble(y1);
    B.add(0x10).writeDouble(x2); B.add(0x18).writeDouble(y2);
    B.add(0x20).writeFloat(th);
    B.add(0x24).writeFloat(r); B.add(0x28).writeFloat(g); B.add(0x2c).writeFloat(b); B.add(0x30).writeFloat(a);
    this.pe(cv, this.drawLineFn, B);
  }

  /** Install the PostRender hook; onDraw runs every rendered frame with a valid Canvas. */
  async hookRender(onDraw: DrawFn): Promise<string> {
    if (!this.ready) { const r = await this.init(); if (!this.ready) return r; }
    const hud = liveHud();
    if (!hud) return "[ue] no HUD instance (enter a match first)";
    const rs = await findHudRenderSlot(hud);
    if (!rs) return "[ue] PostRender slot not found (HUD not rendering?)";
    const hookAddr = rP(rs.vt.add(rs.slot * 8));
    if (!hookAddr) return "[ue] bad hook address";
    const self = this;
    this.hook = Interceptor.attach(hookAddr, {
      onEnter(a) { (this as unknown as { hud: NativePointer }).hud = a[0]; },
      onLeave() {
        try {
          const hud2 = (this as unknown as { hud: NativePointer }).hud;
          if (!hud2) return;
          const cv = rP(hud2.add(HUD_CANVAS));
          if (!cv) return;
          if (self.clipX == null) { self.clipX = propOff(cv, "ClipX"); self.clipY = propOff(cv, "ClipY"); }
          const W = self.clipX != null ? rF(cv.add(self.clipX)) ?? 1920 : 1920;
          const H = self.clipY != null ? rF(cv.add(self.clipY)) ?? 1080 : 1080;
          onDraw(cv, W, H);
        } catch { /* never crash the render thread */ }
      },
    });
    Interceptor.flush();
    return `[ue] render hook installed (slot ${rs.slot})`;
  }

  unhook(): string {
    if (this.hook) { this.hook.detach(); this.hook = null; }
    Interceptor.flush();
    return "[ue] render hook removed";
  }
}
