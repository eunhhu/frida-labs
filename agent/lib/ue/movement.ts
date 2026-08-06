// Generic, reversible UCharacterMovementComponent trainer for authorized
// offline/single-player games. Values are captured from each live component
// before the first write; reset() restores those exact values instead of
// assuming UE defaults. Components are re-resolved across respawns.

import { rF } from "../mem.js";
import { classNameOf, propOff, childOfType } from "./reflection.js";
import { controlledPawn } from "./actor.js";

export type MovementKey =
  | "walk" | "crouch" | "accel" | "jump" | "gravity"
  | "air" | "fly" | "custom" | "friction" | "brake";

export const MOVE_FIELDS: Record<MovementKey, string> = {
  walk: "MaxWalkSpeed",
  crouch: "MaxWalkSpeedCrouched",
  accel: "MaxAcceleration",
  jump: "JumpZVelocity",
  gravity: "GravityScale",
  air: "AirControl",
  fly: "MaxFlySpeed",
  custom: "MaxCustomMovementSpeed",
  friction: "GroundFriction",
  brake: "BrakingDecelerationWalking",
};

const LIMITS: Record<MovementKey, readonly [number, number]> = {
  walk: [0, 100_000],
  crouch: [0, 100_000],
  accel: [0, 100_000],
  jump: [-100_000, 100_000],
  gravity: [-100, 100],
  air: [0, 100],
  fly: [0, 100_000],
  custom: [0, 100_000],
  friction: [0, 10_000],
  brake: [0, 100_000],
};

const KEYS = Object.keys(MOVE_FIELDS) as MovementKey[];

export interface MovementApplyResult {
  ok: boolean;
  component?: string;
  applied: Partial<Record<MovementKey, number>>;
  failed: MovementKey[];
}

export interface MovementResetResult {
  ok: boolean;
  restored: number;
  failed: string[];
  clean: boolean;
}

interface Capture {
  component: NativePointer;
  values: Partial<Record<MovementKey, number>>;
  movementMode?: number;
}

/** Strictly validate a movement patch and reject unknown or unbounded values. */
export function normalizeMovementPatch(input: Record<string, unknown>): Partial<Record<MovementKey, number>> {
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("movement patch must be an object");
  const out: Partial<Record<MovementKey, number>> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (!KEYS.includes(rawKey as MovementKey)) throw new Error(`unknown movement field ${JSON.stringify(rawKey)}`);
    const key = rawKey as MovementKey;
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) throw new Error(`${key} must be finite`);
    const [min, max] = LIMITS[key];
    if (rawValue < min || rawValue > max) throw new Error(`${key} must be within ${min}..${max}`);
    out[key] = rawValue;
  }
  if (Object.keys(out).length === 0) throw new Error("movement patch must contain at least one field");
  return out;
}

export function movementComponent(): NativePointer | null {
  const pawn = controlledPawn();
  if (!pawn) return null;
  return childOfType(pawn, "CharacterMovementComponent") ?? childOfType(pawn, "PawnMovementComponent");
}

function fieldAddress(component: NativePointer, key: MovementKey): NativePointer | null {
  const offset = propOff(component, MOVE_FIELDS[key]);
  return offset == null ? null : component.add(offset);
}

function readField(component: NativePointer, key: MovementKey): number | null {
  const address = fieldAddress(component, key);
  return address ? rF(address) : null;
}

function writeField(component: NativePointer, key: MovementKey, value: number): boolean {
  const address = fieldAddress(component, key);
  if (!address) return false;
  try { address.writeFloat(value); return true; } catch { return false; }
}

export class MovementTrainer {
  private readonly wanted: Partial<Record<MovementKey, number>> = {};
  private readonly captures = new Map<string, Capture>();
  private enforceTimer: ReturnType<typeof setInterval> | null = null;
  private flightEnabled = false;

  read(): Record<string, number | string | null> {
    const component = movementComponent();
    if (!component) return { error: "no movement component; control a character first" };
    const out: Record<string, number | string | null> = {
      component: component.toString(),
      class: classNameOf(component),
    };
    for (const key of KEYS) out[key] = readField(component, key);
    const modeOffset = propOff(component, "MovementMode");
    out.mode = modeOffset == null ? null : (() => { try { return component.add(modeOffset).readU8(); } catch { return null; } })();
    return out;
  }

  apply(input: Record<string, unknown>): MovementApplyResult {
    const patch = normalizeMovementPatch(input);
    const component = movementComponent();
    if (!component) return { ok: false, applied: {}, failed: Object.keys(patch) as MovementKey[] };
    const applied: Partial<Record<MovementKey, number>> = {};
    const failed: MovementKey[] = [];
    for (const key of Object.keys(patch) as MovementKey[]) {
      const value = patch[key]!;
      if (!this.captureField(component, key) || !writeField(component, key, value)) {
        failed.push(key);
        continue;
      }
      this.wanted[key] = value;
      applied[key] = value;
    }
    return { ok: failed.length === 0, component: component.toString(), applied, failed };
  }

  fly(on: boolean): { ok: boolean; enabled: boolean; restored: number; failed: string[] } {
    const failed: string[] = [];
    let restored = 0;
    if (on) {
      const component = movementComponent();
      if (!component || !this.captureMode(component)) return { ok: false, enabled: false, restored, failed: ["MovementMode unavailable"] };
      const offset = propOff(component, "MovementMode");
      try { component.add(offset!).writeU8(5); this.flightEnabled = true; }
      catch { return { ok: false, enabled: false, restored, failed: ["MovementMode write failed"] }; }
      return { ok: true, enabled: true, restored, failed };
    }

    this.flightEnabled = false;
    for (const capture of this.captures.values()) {
      if (capture.movementMode == null) continue;
      const offset = propOff(capture.component, "MovementMode");
      try {
        if (offset == null) throw new Error("offset unavailable");
        capture.component.add(offset).writeU8(capture.movementMode);
        restored++;
      } catch {
        failed.push(`${capture.component}:MovementMode`);
      }
    }
    return { ok: failed.length === 0, enabled: false, restored, failed };
  }

  enforce(on: boolean, intervalMs = 250): { enabled: boolean; intervalMs: number | null; wanted: Partial<Record<MovementKey, number>> } {
    if (on && (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 5_000)) {
      throw new Error("intervalMs must be an integer within 50..5,000");
    }
    if (this.enforceTimer) clearInterval(this.enforceTimer);
    this.enforceTimer = null;
    if (on) {
      this.enforceTimer = setInterval(() => {
        const component = movementComponent();
        if (!component) return;
        for (const key of Object.keys(this.wanted) as MovementKey[]) {
          if (this.captureField(component, key)) writeField(component, key, this.wanted[key]!);
        }
        if (this.flightEnabled && this.captureMode(component)) {
          const offset = propOff(component, "MovementMode");
          try { if (offset != null) component.add(offset).writeU8(5); } catch { /* component changed */ }
        }
      }, intervalMs);
    }
    return { enabled: this.enforceTimer !== null, intervalMs: this.enforceTimer ? intervalMs : null, wanted: { ...this.wanted } };
  }

  status(): {
    enforcing: boolean;
    flight: boolean;
    wanted: Partial<Record<MovementKey, number>>;
    capturedComponents: number;
  } {
    return {
      enforcing: this.enforceTimer !== null,
      flight: this.flightEnabled,
      wanted: { ...this.wanted },
      capturedComponents: this.captures.size,
    };
  }

  reset(): MovementResetResult {
    this.enforce(false);
    this.flightEnabled = false;
    let restored = 0;
    const failed: string[] = [];
    const remaining = new Map<string, Capture>();
    for (const [id, capture] of this.captures) {
      const retry: Capture = { component: capture.component, values: {} };
      for (const key of Object.keys(capture.values) as MovementKey[]) {
        if (writeField(capture.component, key, capture.values[key]!)) restored++;
        else {
          failed.push(`${capture.component}:${key}`);
          retry.values[key] = capture.values[key];
        }
      }
      if (capture.movementMode != null) {
        const offset = propOff(capture.component, "MovementMode");
        try {
          if (offset == null) throw new Error("offset unavailable");
          capture.component.add(offset).writeU8(capture.movementMode);
          restored++;
        } catch {
          failed.push(`${capture.component}:MovementMode`);
          retry.movementMode = capture.movementMode;
        }
      }
      if (Object.keys(retry.values).length > 0 || retry.movementMode != null) remaining.set(id, retry);
    }
    for (const key of KEYS) delete this.wanted[key];
    this.captures.clear();
    for (const [id, capture] of remaining) this.captures.set(id, capture);
    return { ok: failed.length === 0, restored, failed, clean: this.captures.size === 0 };
  }

  dispose(): MovementResetResult { return this.reset(); }

  private captureFor(component: NativePointer): Capture {
    const id = component.toString();
    let capture = this.captures.get(id);
    if (!capture) {
      capture = { component, values: {} };
      this.captures.set(id, capture);
    }
    return capture;
  }

  private captureField(component: NativePointer, key: MovementKey): boolean {
    const capture = this.captureFor(component);
    if (capture.values[key] != null) return true;
    const value = readField(component, key);
    if (value == null) return false;
    capture.values[key] = value;
    return true;
  }

  private captureMode(component: NativePointer): boolean {
    const capture = this.captureFor(component);
    if (capture.movementMode != null) return true;
    const offset = propOff(component, "MovementMode");
    if (offset == null) return false;
    try { capture.movementMode = component.add(offset).readU8(); return true; }
    catch { return false; }
  }
}

/** Create an isolated trainer when a target needs separate ownership. */
export function createMovementTrainer(): MovementTrainer { return new MovementTrainer(); }

/** Backward-compatible singleton; targets should still call reset()/dispose(). */
export const movement = new MovementTrainer();
