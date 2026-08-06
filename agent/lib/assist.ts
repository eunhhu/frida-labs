// Engine-neutral accessibility/training primitives for authorized offline or
// single-player games. This module selects and smooths aim targets only; it
// never discovers teams, bypasses visibility, fires weapons, or touches a
// process by itself. A game target must provide truthful, live-verified
// adapters and an explicit engagement gate.

export type Vec3 = readonly [number, number, number];

export interface AimView {
  origin: Vec3;
  yaw: number;
  pitch: number;
}

export interface AimCandidate {
  id: string;
  point: Vec3;
  /** Targets must be positively classified; unknown/friendly rows are skipped. */
  hostile: boolean;
  alive?: boolean;
  /** Undefined means visibility is unknown, not visible. */
  visible?: boolean;
  /** Higher values win ties; keep this bounded and game-specific. */
  priority?: number;
}

export interface AimPolicy {
  maxFovDegrees: number;
  maxDistance: number;
  smoothing: number;
  requireVisible: boolean;
  intervalMs: number;
  distanceWeight: number;
  priorityWeight: number;
}

export interface AimSelection {
  id: string;
  point: Vec3;
  yaw: number;
  pitch: number;
  yawDelta: number;
  pitchDelta: number;
  angularError: number;
  distance: number;
  score: number;
  visible: boolean | null;
}

export interface AimAssistAdapter {
  readView(): AimView | null;
  listTargets(): AimCandidate[];
  writeView(next: Pick<AimView, "yaw" | "pitch">): boolean;
  /** Continuous correction only runs while this game-specific gate is true. */
  engaged(): boolean;
}

export interface AimAssistStatus {
  enabled: boolean;
  policy: AimPolicy;
  ticks: number;
  corrections: number;
  last: AimSelection | null;
  lastReason: string;
  cleanup: "timer-owned; camera corrections are transient";
}

export interface AimStepResult {
  applied: boolean;
  reason: string;
  selection: AimSelection | null;
  next?: { yaw: number; pitch: number };
}

const DEFAULT_POLICY: AimPolicy = {
  maxFovDegrees: 18,
  maxDistance: 10_000,
  smoothing: 6,
  requireVisible: true,
  intervalMs: 16,
  distanceWeight: 0.15,
  priorityWeight: 0.25,
};

const finite = (value: number): boolean => Number.isFinite(value);
const finiteVec = (value: Vec3): boolean => value.length === 3 && value.every(finite);
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Normalize degrees into [-180, 180). */
export function normalizeDegrees(value: number): number {
  if (!finite(value)) throw new Error("angle must be finite");
  return ((value + 180) % 360 + 360) % 360 - 180;
}

/** Return the shortest signed rotation from current to target. */
export function angleDelta(current: number, target: number): number {
  return normalizeDegrees(target - current);
}

/** Convert a world-space point into yaw/pitch with positive pitch looking up. */
export function aimAngles(origin: Vec3, point: Vec3): { yaw: number; pitch: number; distance: number } {
  if (!finiteVec(origin) || !finiteVec(point)) throw new Error("origin and point must contain finite coordinates");
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  const planar = Math.hypot(dx, dy);
  const distance = Math.hypot(planar, dz);
  if (distance <= 1e-9) throw new Error("origin and point must differ");
  return {
    yaw: normalizeDegrees(Math.atan2(dy, dx) * 180 / Math.PI),
    pitch: clamp(Math.atan2(dz, planar) * 180 / Math.PI, -89.9, 89.9),
    distance,
  };
}

/** Validate and fill a bounded aim policy. Unknown keys are rejected. */
export function normalizeAimPolicy(input: Partial<AimPolicy> = {}): AimPolicy {
  const allowed = new Set<keyof AimPolicy>([
    "maxFovDegrees", "maxDistance", "smoothing", "requireVisible",
    "intervalMs", "distanceWeight", "priorityWeight",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key as keyof AimPolicy)) throw new Error(`unknown aim policy field ${JSON.stringify(key)}`);
  }
  const next = { ...DEFAULT_POLICY, ...input };
  if (!finite(next.maxFovDegrees) || next.maxFovDegrees < 0.1 || next.maxFovDegrees > 180) {
    throw new Error("maxFovDegrees must be within 0.1..180");
  }
  if (!finite(next.maxDistance) || next.maxDistance < 1 || next.maxDistance > 10_000_000) {
    throw new Error("maxDistance must be within 1..10,000,000");
  }
  if (!finite(next.smoothing) || next.smoothing < 1 || next.smoothing > 100) {
    throw new Error("smoothing must be within 1..100");
  }
  if (!Number.isInteger(next.intervalMs) || next.intervalMs < 8 || next.intervalMs > 5_000) {
    throw new Error("intervalMs must be an integer within 8..5,000");
  }
  if (!finite(next.distanceWeight) || next.distanceWeight < 0 || next.distanceWeight > 10) {
    throw new Error("distanceWeight must be within 0..10");
  }
  if (!finite(next.priorityWeight) || next.priorityWeight < 0 || next.priorityWeight > 10) {
    throw new Error("priorityWeight must be within 0..10");
  }
  if (typeof next.requireVisible !== "boolean") throw new Error("requireVisible must be boolean");
  return next;
}

/** Select one positively classified target inside distance, visibility, and angular gates. */
export function selectAimTarget(
  view: AimView,
  candidates: readonly AimCandidate[],
  policyInput: Partial<AimPolicy> = {},
): AimSelection | null {
  if (!finiteVec(view.origin) || !finite(view.yaw) || !finite(view.pitch)) throw new Error("view must be finite");
  const policy = normalizeAimPolicy(policyInput);
  let best: AimSelection | null = null;
  for (const candidate of candidates.slice(0, 512)) {
    if (!candidate.id || candidate.hostile !== true || candidate.alive === false) continue;
    if (policy.requireVisible && candidate.visible !== true) continue;
    if (!finiteVec(candidate.point)) continue;
    let desired: ReturnType<typeof aimAngles>;
    try { desired = aimAngles(view.origin, candidate.point); } catch { continue; }
    if (desired.distance > policy.maxDistance) continue;
    const yawDelta = angleDelta(view.yaw, desired.yaw);
    const pitchDelta = angleDelta(view.pitch, desired.pitch);
    const angularError = Math.hypot(yawDelta, pitchDelta);
    if (angularError > policy.maxFovDegrees) continue;
    const priority = clamp(finite(candidate.priority ?? 0) ? candidate.priority ?? 0 : 0, -100, 100);
    const score = angularError / policy.maxFovDegrees
      + desired.distance / policy.maxDistance * policy.distanceWeight
      - priority * policy.priorityWeight;
    const row: AimSelection = {
      id: candidate.id,
      point: candidate.point,
      yaw: desired.yaw,
      pitch: desired.pitch,
      yawDelta,
      pitchDelta,
      angularError,
      distance: desired.distance,
      score,
      visible: candidate.visible ?? null,
    };
    if (!best || row.score < best.score || (row.score === best.score && row.id < best.id)) best = row;
  }
  return best;
}

/** Apply one bounded smoothing step without overshoot. */
export function smoothAim(view: AimView, selection: AimSelection, smoothing = DEFAULT_POLICY.smoothing): { yaw: number; pitch: number } {
  if (!finite(smoothing) || smoothing < 1 || smoothing > 100) throw new Error("smoothing must be within 1..100");
  return {
    yaw: normalizeDegrees(view.yaw + selection.yawDelta / smoothing),
    pitch: clamp(view.pitch + selection.pitchDelta / smoothing, -89.9, 89.9),
  };
}

export class AimAssist {
  private policy: AimPolicy;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private corrections = 0;
  private last: AimSelection | null = null;
  private lastReason = "disabled";

  constructor(private readonly adapter: AimAssistAdapter, policy: Partial<AimPolicy> = {}) {
    this.policy = normalizeAimPolicy(policy);
  }

  configure(patch: Partial<AimPolicy>): AimAssistStatus {
    this.policy = normalizeAimPolicy({ ...this.policy, ...patch });
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => { this.step(); }, this.policy.intervalMs);
    }
    return this.status();
  }

  preview(): AimStepResult {
    try {
      const view = this.adapter.readView();
      if (!view) return { applied: false, reason: "view unavailable", selection: null };
      const selection = selectAimTarget(view, this.adapter.listTargets(), this.policy);
      return { applied: false, reason: selection ? "candidate selected" : "no eligible target", selection };
    } catch (error) {
      return { applied: false, reason: `preview failed: ${errorText(error)}`, selection: null };
    }
  }

  step(): AimStepResult {
    this.ticks++;
    if (!this.timer) return this.finish(false, "disabled", null);
    try {
      if (!this.adapter.engaged()) return this.finish(false, "engagement gate inactive", null);
      const view = this.adapter.readView();
      if (!view) return this.finish(false, "view unavailable", null);
      const selection = selectAimTarget(view, this.adapter.listTargets(), this.policy);
      if (!selection) return this.finish(false, "no eligible target", null);
      const next = smoothAim(view, selection, this.policy.smoothing);
      if (!this.adapter.writeView(next)) return this.finish(false, "view write rejected", selection, next);
      this.corrections++;
      return this.finish(true, "correction applied", selection, next);
    } catch (error) {
      return this.finish(false, `adapter failed: ${errorText(error)}`, null);
    }
  }

  enable(offlineConfirmed: boolean): AimAssistStatus {
    if (offlineConfirmed !== true) throw new Error("offlineConfirmed must be true");
    if (!this.timer) this.timer = setInterval(() => { this.step(); }, this.policy.intervalMs);
    this.lastReason = "enabled; waiting for engagement gate";
    return this.status();
  }

  disable(): AimAssistStatus {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastReason = "disabled";
    return this.status();
  }

  status(): AimAssistStatus {
    return {
      enabled: this.timer !== null,
      policy: { ...this.policy },
      ticks: this.ticks,
      corrections: this.corrections,
      last: this.last,
      lastReason: this.lastReason,
      cleanup: "timer-owned; camera corrections are transient",
    };
  }

  dispose(): AimAssistStatus { return this.disable(); }

  private finish(
    applied: boolean,
    reason: string,
    selection: AimSelection | null,
    next?: { yaw: number; pitch: number },
  ): AimStepResult {
    this.last = selection;
    this.lastReason = reason;
    return { applied, reason, selection, ...(next ? { next } : {}) };
  }
}

/** Create a disabled aim controller; the caller owns disable()/dispose(). */
export function createAimAssist(adapter: AimAssistAdapter, policy: Partial<AimPolicy> = {}): AimAssist {
  return new AimAssist(adapter, policy);
}
