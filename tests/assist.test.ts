import { expect, test } from "bun:test";
import {
  aimAngles,
  angleDelta,
  createAimAssist,
  normalizeAimPolicy,
  normalizeDegrees,
  selectAimTarget,
  smoothAim,
  type AimView,
} from "../agent/lib/assist.js";
import { createMovementTrainer, normalizeMovementPatch } from "../agent/lib/ue/movement.js";

test("aim math handles wrapped angles and bounded smoothing", () => {
  expect(normalizeDegrees(181)).toBe(-179);
  expect(angleDelta(179, -179)).toBe(2);
  expect(aimAngles([0, 0, 0], [0, 10, 10])).toMatchObject({ yaw: 90, pitch: 45 });

  const view: AimView = { origin: [0, 0, 0], yaw: 179, pitch: 0 };
  const selection = selectAimTarget(view, [
    { id: "wrapped", point: [-10, -0.2, 0], hostile: true, visible: true },
  ], { maxFovDegrees: 10 });
  expect(selection).not.toBeNull();
  const next = smoothAim(view, selection!, 2);
  expect(Math.abs(angleDelta(view.yaw, next.yaw))).toBeLessThan(2);
});

test("aim selection requires positive hostility and honors life, visibility, FOV, and priority", () => {
  const view: AimView = { origin: [0, 0, 0], yaw: 0, pitch: 0 };
  const selected = selectAimTarget(view, [
    { id: "friendly", point: [10, 0, 0], hostile: false, visible: true },
    { id: "dead", point: [10, 0, 0], hostile: true, alive: false, visible: true },
    { id: "hidden", point: [10, 0, 0], hostile: true, visible: false },
    { id: "outside", point: [0, 10, 0], hostile: true, visible: true },
    { id: "low-priority", point: [100, 1, 0], hostile: true, visible: true },
    { id: "high-priority", point: [100, 2, 0], hostile: true, visible: true, priority: 10 },
  ], { maxFovDegrees: 20, maxDistance: 1_000, requireVisible: true });
  expect(selected?.id).toBe("high-priority");
});

test("aim policy and movement patches reject unknown or unbounded input", () => {
  expect(() => normalizeAimPolicy({ maxFovDegrees: 0 })).toThrow("maxFovDegrees");
  expect(() => normalizeAimPolicy({ exploit: 1 } as never)).toThrow("unknown aim policy field");
  expect(normalizeMovementPatch({ walk: 900, gravity: 0.5 })).toEqual({ walk: 900, gravity: 0.5 });
  expect(() => normalizeMovementPatch({ teleport: 1 })).toThrow("unknown movement field");
  expect(() => normalizeMovementPatch({ gravity: 101 })).toThrow("gravity");
  expect(() => normalizeMovementPatch({})).toThrow("at least one field");
  expect(() => createMovementTrainer().enforce(true, 49)).toThrow("intervalMs");
});

test("continuous aim requires offline confirmation and a live engagement gate", () => {
  let engaged = false;
  let writes = 0;
  const controller = createAimAssist({
    readView: () => ({ origin: [0, 0, 0], yaw: 0, pitch: 0 }),
    listTargets: () => [{ id: "dummy", point: [100, 5, 0], hostile: true, visible: true }],
    writeView: () => { writes++; return true; },
    engaged: () => engaged,
  }, { intervalMs: 5_000, maxFovDegrees: 20 });

  expect(() => controller.enable(false)).toThrow("offlineConfirmed");
  controller.enable(true);
  expect(controller.step()).toMatchObject({ applied: false, reason: "engagement gate inactive" });
  engaged = true;
  expect(controller.step()).toMatchObject({ applied: true, reason: "correction applied" });
  expect(writes).toBe(1);
  expect(controller.disable()).toMatchObject({ enabled: false, corrections: 1 });
});

test("aim controller contains adapter failures instead of leaking timer exceptions", () => {
  const controller = createAimAssist({
    readView: () => null,
    listTargets: () => [],
    writeView: () => false,
    engaged: () => { throw new Error("scene changed"); },
  }, { intervalMs: 5_000 });
  controller.enable(true);
  expect(controller.step()).toMatchObject({ applied: false, reason: "adapter failed: scene changed" });
  expect(controller.disable().enabled).toBe(false);
});
