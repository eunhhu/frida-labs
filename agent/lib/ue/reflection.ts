// Generic Unreal Engine 5 reflection engine — reusable for ANY UE5 game.
// Auto-discovers GUObjectArray + GNames from memory signatures (addresses move
// every launch) and exposes name/class/property resolution over the live
// UObject graph. Field offsets below are the stable UE5 layout; override via
// setOffsets() if a particular build differs.

import { rP, rU16, rU32, mainModule, moduleByPattern } from "../mem.js";

const MOD = moduleByPattern(/-Win64-Shipping\.exe$/i) ?? mainModule();
const LO = MOD.base;
const HI = MOD.base.add(MOD.size);
export const gameModule = MOD;

export const inModule = (p: NativePointer | null): boolean =>
  !!p && p.compare(LO) >= 0 && p.compare(HI) < 0;

export const O = {
  CLASS: 0x10, NAME: 0x18, OUTER: 0x20, FLAGS: 0x08,
  SUPER: 0x40, CHILDREN: 0x48, CHILDPROPS: 0x50, PROPSIZE: 0x58,
  FIELD_NEXT: 0x18, FIELD_NAME: 0x20, PROP_OFFSET: 0x44, UFIELD_NEXT: 0x28,
};

export interface ObjArray { objects: NativePointer; num: number; }

function findObjArray(): ObjArray {
  const EPC = 65536;
  const ranges = Process.enumerateRanges("rw-").filter((r) => inModule(r.base));
  for (const rg of ranges) {
    let a = rg.base;
    const end = rg.base.add(rg.size).sub(0x20);
    while (a.compare(end) < 0) {
      const objects = rP(a);
      if (objects) {
        const maxE = rU32(a.add(0x10)), numE = rU32(a.add(0x14)), maxC = rU32(a.add(0x18)), numC = rU32(a.add(0x1c));
        if (maxE && numE && maxC && numC && maxC <= 4096 && maxE === maxC * EPC &&
            numE > 0 && numE <= maxE && numC >= 1 && numC <= maxC && numC === Math.ceil(numE / EPC)) {
          const c0 = rP(objects); const o0 = c0 && rP(c0); const vt = o0 && rP(o0);
          if (inModule(vt)) return { objects, num: numE };
        }
      }
      a = a.add(8);
    }
  }
  throw new Error("[ue] GUObjectArray not found");
}

function findNames(): NativePointer {
  const decodeNone = (blk: NativePointer): boolean => {
    const h = rU16(blk);
    if (h == null || h & 1) return false;
    try { return blk.add(2).readUtf8String((h >> 6) & 0x3ff) === "None"; } catch { return false; }
  };
  const ranges = Process.enumerateRanges("rw-").filter((r) => inModule(r.base));
  for (const rg of ranges) {
    let a = rg.base.add(8);
    const end = rg.base.add(rg.size).sub(0x220);
    while (a.compare(end) < 0) {
      const cb = rU32(a.sub(8));
      if (cb !== null && cb >= 1 && cb <= 64) {
        const cursor = rU32(a.sub(4));
        if (cursor !== null && cursor > 0 && cursor <= 131072) {
          const b0 = rP(a);
          if (b0 && !inModule(b0) && decodeNone(b0)) {
            let ok = true;
            for (let i = 0; i <= cb; i++) if (!rP(a.add(i * 8))) { ok = false; break; }
            if (ok) return a;
          }
        }
      }
      a = a.add(8);
    }
  }
  throw new Error("[ue] GNames not found");
}

let cachedOA: ObjArray | null = null;
let cachedGnames: NativePointer | null = null;

/** Lazy GUObjectArray — resolved on first call, NEVER at import (lib invariant). */
export function oa(): ObjArray { return (cachedOA ??= findObjArray()); }
/** Lazy GNames — resolved on first call, NEVER at import (lib invariant). */
export function gnames(): NativePointer { return (cachedGnames ??= findNames()); }

export function resolveId(id: number): string | null {
  const bp = rP(gnames().add((id >>> 16) * 8));
  if (!bp) return null;
  const e = bp.add((id & 0xffff) * 2);
  const h = rU16(e);
  if (h == null) return null;
  const len = (h >> 6) & 0x3ff;
  try { return h & 1 ? e.add(2).readUtf16String(len) : e.add(2).readUtf8String(len); } catch { return null; }
}

export function fname(p: NativePointer): string | null {
  const id = rU32(p), num = rU32(p.add(4));
  if (id == null) return null;
  let s = resolveId(id);
  if (s && num) s = `${s}_${num - 1}`;
  return s;
}

export function objAt(i: number): NativePointer | null {
  const chunk = rP(oa().objects.add((i >>> 16) * 8));
  return chunk ? rP(chunk.add((i & 0xffff) * 24)) : null;
}

export const nameOf = (o: NativePointer | null): string | null => (o ? fname(o.add(O.NAME)) : null);
export const classOf = (o: NativePointer | null): NativePointer | null => (o ? rP(o.add(O.CLASS)) : null);
export const classNameOf = (o: NativePointer | null): string | null => { const c = classOf(o); return c ? nameOf(c) : null; };
export const outerOf = (o: NativePointer): NativePointer | null => rP(o.add(O.OUTER));
export const superOf = (c: NativePointer): NativePointer | null => rP(c.add(O.SUPER));

export function isA(o: NativePointer, target: string): boolean {
  let c = classOf(o);
  for (let g = 0; c && g < 40; g++) { if (nameOf(c) === target) return true; c = superOf(c); }
  return false;
}

export function pkgOf(o: NativePointer): NativePointer {
  let p: NativePointer | null = o, last = o;
  for (let g = 0; p && g < 40; g++) { last = p; p = outerOf(p); }
  return last;
}

export function propOff(o: NativePointer, name: string): number | null {
  let c = classOf(o);
  for (let g = 0; c && g < 30; g++) {
    let f = rP(c.add(O.CHILDPROPS));
    for (let k = 0; f && k < 600; k++) { if (fname(f.add(O.FIELD_NAME)) === name) return rU32(f.add(O.PROP_OFFSET)); f = rP(f.add(O.FIELD_NEXT)); }
    c = superOf(c);
  }
  return null;
}

export function childOfType(actor: NativePointer, type: string, span = 0x600): NativePointer | null {
  for (let x = 0; x < span; x += 8) {
    const v = rP(actor.add(x));
    if (v) { try { if (isA(v, type)) return v; } catch { /* */ } }
  }
  return null;
}

export function firstInstance(pred: (o: NativePointer) => boolean): NativePointer | null {
  for (let i = 0; i < oa().num; i++) {
    const o = objAt(i);
    if (o && !(nameOf(o) ?? "").startsWith("Default__")) { try { if (pred(o)) return o; } catch { /* */ } }
  }
  return null;
}

/** Every live instance whose class name matches a regex (skips CDOs). */
export function instancesOf(re: RegExp): NativePointer[] {
  const out: NativePointer[] = [];
  for (let i = 0; i < oa().num; i++) {
    const o = objAt(i);
    if (!o) continue;
    const cn = classNameOf(o);
    if (cn && re.test(cn) && !(nameOf(o) ?? "").startsWith("Default__")) out.push(o);
  }
  return out;
}

export function findClass(name: string): NativePointer | null {
  for (let i = 0; i < oa().num; i++) { const o = objAt(i); if (o && classNameOf(o) === "Class" && nameOf(o) === name) return o; }
  return null;
}

export function findFunc(cls: NativePointer, name: string): NativePointer | null {
  let f = rP(cls.add(O.CHILDREN));
  for (let k = 0; f && k < 5000; k++) { if (classNameOf(f) === "Function" && nameOf(f) === name) return f; f = rP(f.add(O.UFIELD_NEXT)); }
  return null;
}

export function defaultActorVtable(): NativePointer | null {
  for (let i = 0; i < oa().num; i++) { const o = objAt(i); if (o && nameOf(o) === "Default__Actor") return rP(o); }
  return null;
}

/** List the classes owned by a /Script or /Game package, e.g. classesInPackage("/Script/PenguinHotel"). */
export function classesInPackage(pkg: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < oa().num; i++) {
    const o = objAt(i);
    if (o && classNameOf(o) === "Class" && nameOf(pkgOf(o)) === pkg) { const n = nameOf(o); if (n) out.push(n); }
  }
  return out.sort();
}
