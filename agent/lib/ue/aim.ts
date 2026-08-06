// Configurable UE aim-assist adapter for authorized offline accessibility and
// training targets. Team/hostility, visibility, engagement input, and target
// anatomy are game-specific and therefore supplied by the target. The generic
// fallback reads/writes AController::ControlRotation; prefer a verified game
// API through readView/writeView when one is available.

import {
  createAimAssist,
  type AimAssist,
  type AimCandidate,
  type AimPolicy,
  type AimView,
  type Vec3,
} from "../assist.js";
import { rD, rF, rP } from "../mem.js";
import { CTRL_PAWN, C2W_T, localPlayerController, worldLoc } from "./actor.js";
import { childOfType, classNameOf, firstInstance, instancesOf, propOff } from "./reflection.js";

export interface UeAimClassification {
  hostile: boolean;
  alive?: boolean;
  priority?: number;
}

export interface UeAimConfig {
  targetClasses: RegExp;
  classify(actor: NativePointer, className: string): UeAimClassification | null;
  /** Must reflect a discovered local input/state gate such as aim-held. */
  engaged(): boolean;
  visible?(actor: NativePointer): boolean;
  aimPoint?(actor: NativePointer): Vec3 | null;
  controllerClass?: string;
  controlRotationProperty?: string;
  rotationStorage?: "double" | "float";
  maxTargets?: number;
  refreshMs?: number;
  /** Preferred target-specific API overrides for nonstandard camera/control layouts. */
  readView?(): AimView | null;
  writeView?(next: Pick<AimView, "yaw" | "pitch">): boolean;
}

interface CachedTarget {
  actor: NativePointer;
  id: string;
  className: string;
  classification: UeAimClassification;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer within ${min}..${max}`);
  }
  return resolved;
}

function controller(config: UeAimConfig): NativePointer | null {
  if (!config.controllerClass) return localPlayerController();
  return firstInstance((object) => classNameOf(object) === config.controllerClass);
}

function readScalar(address: NativePointer, storage: "double" | "float"): number | null {
  return storage === "double" ? rD(address) : rF(address);
}

function writeScalar(address: NativePointer, value: number, storage: "double" | "float"): void {
  if (storage === "double") address.writeDouble(value);
  else address.writeFloat(value);
}

function reflectedView(config: UeAimConfig): AimView | null {
  const pc = controller(config);
  if (!pc) return null;
  const pawn = rP(pc.add(CTRL_PAWN));
  const camera = pawn && childOfType(pawn, "CameraComponent");
  const rotationOffset = propOff(pc, config.controlRotationProperty ?? "ControlRotation");
  if (!camera || rotationOffset == null) return null;
  const storage = config.rotationStorage ?? "double";
  const stride = storage === "double" ? 8 : 4;
  const pitch = readScalar(pc.add(rotationOffset), storage);
  const yaw = readScalar(pc.add(rotationOffset + stride), storage);
  const x = rD(camera.add(C2W_T));
  const y = rD(camera.add(C2W_T + 8));
  const z = rD(camera.add(C2W_T + 16));
  if (pitch == null || yaw == null || x == null || y == null || z == null) return null;
  return { origin: [x, y, z], pitch, yaw };
}

function reflectedWrite(config: UeAimConfig, next: Pick<AimView, "yaw" | "pitch">): boolean {
  const pc = controller(config);
  if (!pc) return false;
  const rotationOffset = propOff(pc, config.controlRotationProperty ?? "ControlRotation");
  if (rotationOffset == null) return false;
  const storage = config.rotationStorage ?? "double";
  const stride = storage === "double" ? 8 : 4;
  try {
    writeScalar(pc.add(rotationOffset), next.pitch, storage);
    writeScalar(pc.add(rotationOffset + stride), next.yaw, storage);
    return true;
  } catch {
    return false;
  }
}

/** Build a disabled controller. Enabling still requires offlineConfirmed=true. */
export function createUeAimAssist(config: UeAimConfig, policy: Partial<AimPolicy> = {}): AimAssist {
  const maxTargets = boundedInteger(config.maxTargets, 128, 1, 512, "maxTargets");
  const refreshMs = boundedInteger(config.refreshMs, 500, 50, 10_000, "refreshMs");
  const targetPattern = new RegExp(config.targetClasses.source, config.targetClasses.flags.replace(/[gy]/g, ""));
  let cached: CachedTarget[] = [];
  let refreshedAt = 0;

  const refresh = (): void => {
    const now = Date.now();
    if (now - refreshedAt < refreshMs) return;
    refreshedAt = now;
    const pc = controller(config);
    const self = pc ? rP(pc.add(CTRL_PAWN)) : null;
    const next: CachedTarget[] = [];
    for (const actor of instancesOf(targetPattern)) {
      if (self && actor.equals(self)) continue;
      const className = classNameOf(actor);
      if (!className) continue;
      const classification = config.classify(actor, className);
      if (!classification?.hostile) continue;
      next.push({ actor, id: actor.toString(), className, classification });
      if (next.length >= maxTargets) break;
    }
    cached = next;
  };

  const listTargets = (): AimCandidate[] => {
    refresh();
    const out: AimCandidate[] = [];
    for (const target of cached) {
      try {
        const point = config.aimPoint ? config.aimPoint(target.actor) : worldLoc(target.actor);
        if (!point) continue;
        out.push({
          id: `${target.className}:${target.id}`,
          point,
          hostile: true,
          alive: target.classification.alive,
          priority: target.classification.priority,
          visible: config.visible ? config.visible(target.actor) : undefined,
        });
      } catch {
        // Scene transitions can invalidate actors between refreshes.
      }
    }
    return out;
  };

  return createAimAssist({
    readView: () => config.readView ? config.readView() : reflectedView(config),
    listTargets,
    writeView: (next) => config.writeView?.(next) ?? reflectedWrite(config, next),
    engaged: () => config.engaged() === true,
  }, policy);
}
