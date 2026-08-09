// Reversible movement Instrument for UE5's experimental Mover stack. Current
// games frequently use MoverComponent instead of UCharacterMovementComponent;
// their live CommonLegacyMovementSettings object is the authoritative source.

import { controlledPawn, worldLoc } from "./actor.js";
import { childOfType, classNameOf, isA, propOff } from "./reflection.js";

type MoverKey = "walk" | "accel" | "jump" | "air" | "friction" | "brake";

const FIELDS: Record<MoverKey, { owner: "settings" | "falling"; property: string; limits: readonly [number, number] }> = {
  walk: { owner: "settings", property: "MaxSpeed", limits: [0, 100_000] },
  accel: { owner: "settings", property: "Acceleration", limits: [0, 100_000] },
  jump: { owner: "settings", property: "JumpUpwardsSpeed", limits: [-100_000, 100_000] },
  air: { owner: "falling", property: "AirControlPercentage", limits: [0, 100] },
  friction: { owner: "settings", property: "GroundFriction", limits: [0, 10_000] },
  brake: { owner: "settings", property: "Deceleration", limits: [0, 100_000] },
};

const KEYS = Object.keys(FIELDS) as MoverKey[];

interface ResolvedMover {
  pawn: NativePointer;
  component: NativePointer;
  settings: NativePointer;
  falling: NativePointer | null;
}

interface Capture {
  object: NativePointer;
  property: string;
  value: number;
}

function pointerAt(object: NativePointer, property: string): NativePointer | null {
  const offset = propOff(object, property);
  if (offset == null) return null;
  try {
    const value = object.add(offset).readPointer();
    return value.isNull() ? null : value;
  } catch { return null; }
}

function sharedSettings(component: NativePointer): NativePointer | null {
  const data = pointerAt(component, "SharedSettings");
  if (!data) return null;
  try {
    const value = data.readPointer();
    return !value.isNull() && isA(value, "CommonLegacyMovementSettings") ? value : null;
  } catch { return null; }
}

function fallingMode(component: NativePointer): NativePointer | null {
  const offset = propOff(component, "MovementModes");
  if (offset == null) return null;
  let data: NativePointer, capacity: number;
  try {
    data = component.add(offset).readPointer();
    capacity = component.add(offset + 12).readS32();
  } catch { return null; }
  if (data.isNull() || capacity < 1 || capacity > 128) return null;
  // FScriptMap entries are 24 bytes in current UE5 Mover builds. Scan the
  // bounded occupied region by pointer stride so sparse slots remain safe.
  for (let dataOffset = 0; dataOffset < capacity * 24; dataOffset += Process.pointerSize) {
    try {
      const candidate = data.add(dataOffset).readPointer();
      if (!candidate.isNull() && isA(candidate, "FallingMode")) return candidate;
    } catch { /* sparse or uncommitted slot */ }
  }
  return null;
}

export function resolveMover(): ResolvedMover | null {
  const pawn = controlledPawn();
  if (!pawn) return null;
  const component = childOfType(pawn, "MoverComponent");
  if (!component) return null;
  const settings = sharedSettings(component);
  return settings ? { pawn, component, settings, falling: fallingMode(component) } : null;
}

function fieldObject(resolved: ResolvedMover, key: MoverKey): NativePointer | null {
  return FIELDS[key].owner === "settings" ? resolved.settings : resolved.falling;
}

function readField(resolved: ResolvedMover, key: MoverKey): number | null {
  const object = fieldObject(resolved, key);
  if (!object) return null;
  const offset = propOff(object, FIELDS[key].property);
  if (offset == null) return null;
  try { return object.add(offset).readFloat(); } catch { return null; }
}

function writeField(resolved: ResolvedMover, key: MoverKey, value: number): boolean {
  const object = fieldObject(resolved, key);
  if (!object) return false;
  const offset = propOff(object, FIELDS[key].property);
  if (offset == null) return false;
  try { object.add(offset).writeFloat(value); return object.add(offset).readFloat() === Math.fround(value); } catch { return false; }
}

function normalize(input: Record<string, unknown>): Partial<Record<MoverKey, number>> {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("movement patch must be an object");
  const out: Partial<Record<MoverKey, number>> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (!KEYS.includes(rawKey as MoverKey)) throw new Error(`unsupported Mover field ${JSON.stringify(rawKey)}; use ${KEYS.join(", ")}`);
    const key = rawKey as MoverKey;
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) throw new Error(`${key} must be finite`);
    const [min, max] = FIELDS[key].limits;
    if (rawValue < min || rawValue > max) throw new Error(`${key} must be within ${min}..${max}`);
    out[key] = rawValue;
  }
  if (!Object.keys(out).length) throw new Error("movement patch must contain at least one field");
  return out;
}

export class MoverMovementInstrument {
  private readonly wanted: Partial<Record<MoverKey, number>> = {};
  private readonly captures = new Map<string, Capture>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private applied = 0;
  private lastError: string | null = null;

  read(): Record<string, unknown> {
    const resolved = resolveMover();
    if (!resolved) return { error: "no live UE Mover settings; control a character first", backend: "mover" };
    const values: Record<string, number | null> = {};
    for (const key of KEYS) values[key] = readField(resolved, key);
    return {
      backend: "mover",
      component: resolved.component.toString(),
      componentClass: classNameOf(resolved.component),
      settings: resolved.settings.toString(),
      location: worldLoc(resolved.pawn),
      ...values,
    };
  }

  apply(input: Record<string, unknown>): { ok: boolean; backend: "mover"; component?: string; applied: Partial<Record<MoverKey, number>>; failed: MoverKey[]; readback: Record<string, unknown> } {
    const patch = normalize(input);
    const resolved = resolveMover();
    const applied: Partial<Record<MoverKey, number>> = {};
    const failed: MoverKey[] = [];
    if (!resolved) return { ok: false, backend: "mover", applied, failed: Object.keys(patch) as MoverKey[], readback: this.read() };
    for (const key of Object.keys(patch) as MoverKey[]) {
      if (!this.capture(resolved, key) || !writeField(resolved, key, patch[key]!)) { failed.push(key); continue; }
      this.wanted[key] = patch[key]!;
      applied[key] = patch[key]!;
      this.applied++;
    }
    return { ok: failed.length === 0, backend: "mover", component: resolved.component.toString(), applied, failed, readback: this.read() };
  }

  enforce(on: boolean, intervalMs = 250): { enabled: boolean; intervalMs: number | null; wanted: Partial<Record<MoverKey, number>> } {
    if (on && (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 5_000)) throw new Error("intervalMs must be an integer within 50..5,000");
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (on) {
      this.timer = setInterval(() => {
        const resolved = resolveMover();
        if (!resolved) { this.lastError = "Mover settings unavailable"; return; }
        this.lastError = null;
        for (const key of Object.keys(this.wanted) as MoverKey[]) {
          if (this.capture(resolved, key) && writeField(resolved, key, this.wanted[key]!)) this.applied++;
          else this.lastError = `${key} write failed`;
        }
      }, intervalMs);
    }
    return { enabled: this.timer !== null, intervalMs: this.timer ? intervalMs : null, wanted: { ...this.wanted } };
  }

  status(): { backend: "mover"; enforcing: boolean; wanted: Partial<Record<MoverKey, number>>; capturedFields: number; applied: number; lastError: string | null } {
    return { backend: "mover", enforcing: this.timer !== null, wanted: { ...this.wanted }, capturedFields: this.captures.size, applied: this.applied, lastError: this.lastError };
  }

  reset(): { ok: boolean; backend: "mover"; restored: number; failed: string[]; clean: boolean } {
    this.enforce(false);
    let restored = 0;
    const failed: string[] = [];
    for (const [id, capture] of this.captures) {
      const offset = propOff(capture.object, capture.property);
      try {
        if (offset == null) throw new Error("offset unavailable");
        capture.object.add(offset).writeFloat(capture.value);
        if (capture.object.add(offset).readFloat() !== capture.value) throw new Error("readback mismatch");
        restored++;
        this.captures.delete(id);
      } catch { failed.push(id); }
    }
    for (const key of KEYS) delete this.wanted[key];
    this.lastError = failed.length ? `${failed.length} restore(s) failed` : null;
    return { ok: failed.length === 0, backend: "mover", restored, failed, clean: this.captures.size === 0 };
  }

  dispose(): ReturnType<MoverMovementInstrument["reset"]> { return this.reset(); }

  private capture(resolved: ResolvedMover, key: MoverKey): boolean {
    const object = fieldObject(resolved, key);
    if (!object) return false;
    const property = FIELDS[key].property;
    const id = `${object}:${property}`;
    if (this.captures.has(id)) return true;
    const value = readField(resolved, key);
    if (value == null) return false;
    this.captures.set(id, { object, property, value });
    return true;
  }
}

export const moverMovement = new MoverMovementInstrument();
