// Generic UCharacterMovementComponent trainer. Works for any UE5 game that uses
// the stock character movement component. The component is re-resolved on every
// call so it survives respawns and round changes.

import { rP, rF } from "../mem.js";
import { classNameOf, propOff, childOfType } from "./reflection.js";
import { controlledPawn } from "./actor.js";

export const MOVE_FIELDS: Record<string, string> = {
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

const STOCK: Record<string, number> = {
  walk: 600, crouch: 300, accel: 2048, jump: 420, gravity: 1,
  air: 0.05, fly: 600, custom: 600, friction: 8, brake: 2048,
};

export function movementComponent(): NativePointer | null {
  const pawn = controlledPawn();
  if (!pawn) return null;
  return childOfType(pawn, "CharacterMovementComponent") ?? childOfType(pawn, "PawnMovementComponent");
}

function setF(mc: NativePointer, key: string, v: number): boolean {
  const off = propOff(mc, MOVE_FIELDS[key]);
  if (off == null) return false;
  try { mc.add(off).writeFloat(v); return true; } catch { return false; }
}

const wanted: Record<string, number> = {};
let enforceTimer: ReturnType<typeof setInterval> | null = null;

export const movement = {
  read(): Record<string, number | null> | string {
    const mc = movementComponent();
    if (!mc) return "[movement] no component (control a character first)";
    const out: Record<string, number | null> = {};
    (out as Record<string, unknown>)._comp = classNameOf(mc);
    for (const k in MOVE_FIELDS) { const off = propOff(mc, MOVE_FIELDS[k]); out[k] = off != null ? rF(mc.add(off)) : null; }
    return out;
  },
  apply(opts: Record<string, number>): Record<string, boolean> | string {
    const mc = movementComponent();
    if (!mc) return "[movement] no component";
    const done: Record<string, boolean> = {};
    for (const k in opts) if (MOVE_FIELDS[k]) { wanted[k] = opts[k]; done[k] = setF(mc, k, opts[k]); }
    return done;
  },
  fly(on: boolean): string {
    const mc = movementComponent();
    if (!mc) return "[movement] no component";
    const off = propOff(mc, "MovementMode");
    if (off == null) return "[movement] MovementMode not found";
    try { mc.add(off).writeU8(on ? 5 : 1); return `[movement] fly=${on}`; } catch { return "[movement] write failed"; }
  },
  enforce(on: boolean, intervalMs = 250): string {
    if (enforceTimer) { clearInterval(enforceTimer); enforceTimer = null; }
    if (on) enforceTimer = setInterval(() => { const mc = movementComponent(); if (mc) for (const k in wanted) setF(mc, k, wanted[k]); }, intervalMs);
    return `[movement] enforce=${on}`;
  },
  reset(): Record<string, boolean> | string {
    for (const k in wanted) delete wanted[k];
    this.enforce(false);
    return this.apply(STOCK);
  },
};
