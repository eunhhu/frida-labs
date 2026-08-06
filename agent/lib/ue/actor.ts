// Generic UE actor spatial helpers: root component, world location, the local
// view camera, and world->screen projection. Reusable for any UE5 game.

import { rP, rD, rF } from "../mem.js";
import { propOff, childOfType, firstInstance, isA } from "./reflection.js";

export const C2W = 0x1e0;       // USceneComponent::ComponentToWorld (FTransform)
export const C2W_T = 0x200;     // …translation (FVector, double)
export const CTRL_PAWN = 0x2e8; // AController::Pawn
export const ROOT_COMP = 0x1b8; // AActor::RootComponent

export function rootComp(actor: NativePointer): NativePointer | null {
  return rP(actor.add(ROOT_COMP)) ?? childOfType(actor, "SceneComponent");
}

export function worldLoc(actor: NativePointer): [number, number, number] | null {
  const c = rootComp(actor);
  if (!c) return null;
  const x = rD(c.add(C2W_T)), y = rD(c.add(C2W_T + 8)), z = rD(c.add(C2W_T + 16));
  return x == null || y == null || z == null ? null : [x, y, z];
}

export const localPlayerController = (): NativePointer | null =>
  firstInstance((o) => isA(o, "PlayerController"));

export const controlledPawn = (): NativePointer | null => {
  const pc = localPlayerController();
  return pc ? rP(pc.add(CTRL_PAWN)) : null;
};

/** Quaternion-rotate a vector (UE X-forward / Y-right / Z-up). */
export function qrot(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export interface View { t: number[]; fwd: number[]; right: number[]; up: number[]; focal: number; W: number; H: number; fov: number; }

/** View basis from a camera component's world transform + FOV. */
export function viewFromCamera(cam: NativePointer, W: number, H: number): View {
  const q = [rD(cam.add(C2W)), rD(cam.add(C2W + 8)), rD(cam.add(C2W + 16)), rD(cam.add(C2W + 24))] as number[];
  const t = [rD(cam.add(C2W_T)), rD(cam.add(C2W_T + 8)), rD(cam.add(C2W_T + 16))] as number[];
  const fovOff = propOff(cam, "FieldOfView");
  const fov = fovOff != null ? rF(cam.add(fovOff)) ?? 90 : 90;
  return {
    t, fov, W, H,
    fwd: qrot(q, [1, 0, 0]), right: qrot(q, [0, 1, 0]), up: qrot(q, [0, 0, 1]),
    focal: (W / 2) / Math.tan((fov * Math.PI) / 360),
  };
}

/** Local view from whatever pawn the player controls (first-person or spectate camera). */
export function localView(W = 1920, H = 1080): View | null {
  const pawn = controlledPawn();
  if (!pawn) return null;
  const cam = childOfType(pawn, "CameraComponent");
  return cam ? viewFromCamera(cam, W, H) : null;
}

export interface Screen { x: number; y: number; depth: number; }

export function worldToScreen(view: View, wp: readonly number[]): Screen | null {
  const d = [wp[0] - view.t[0], wp[1] - view.t[1], wp[2] - view.t[2]];
  const depth = d[0] * view.fwd[0] + d[1] * view.fwd[1] + d[2] * view.fwd[2];
  if (depth <= 1) return null;
  const rx = d[0] * view.right[0] + d[1] * view.right[1] + d[2] * view.right[2];
  const ry = d[0] * view.up[0] + d[1] * view.up[1] + d[2] * view.up[2];
  return { x: Math.round(view.W / 2 + (rx / depth) * view.focal), y: Math.round(view.H / 2 - (ry / depth) * view.focal), depth };
}
