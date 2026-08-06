import { expect, test } from "bun:test";
import { libReference } from "../src/core/libref.js";

test("agent library catalog contains only explicit top-level callable exports", () => {
  const modules = libReference();
  const names = modules.flatMap((module) => module.functions.map((fn) => fn.name));
  for (const impossible of ["if", "return", "for"]) expect(names).not.toContain(impossible);

  const detect = modules.find((module) => module.module === "detect")!;
  expect(detect.functions.map((fn) => fn.name)).toEqual(["detectAll", "detect"]);
  const excrash = modules.find((module) => module.module === "excrash")!;
  expect(excrash.functions.map((fn) => fn.name)).toEqual(["addExceptionHandler", "buildReport", "install"]);
  expect(modules.find((module) => module.module === "watch")?.functions.map((fn) => fn.name)).toContain("watch");
  expect(modules.find((module) => module.module === "log")?.about).not.toContain("<reference");
  expect(modules.find((module) => module.module === "assist")?.functions.map((fn) => fn.name)).toEqual([
    "normalizeDegrees",
    "angleDelta",
    "aimAngles",
    "normalizeAimPolicy",
    "selectAimTarget",
    "smoothAim",
    "createAimAssist",
  ]);
  expect(modules.find((module) => module.module === "ue/aim")?.functions.map((fn) => fn.name)).toContain("createUeAimAssist");
  expect(modules.find((module) => module.module === "ue/esp")?.functions.map((fn) => fn.name)).toContain("createEsp");
  expect(modules.find((module) => module.module === "ue/movement")?.functions.map((fn) => fn.name)).toContain("createMovementTrainer");
});

test("catalog signatures and docs come from the owning source declaration", () => {
  const cocos = libReference().find((module) => module.module === "cocos")!;
  const find = cocos.functions.find((fn) => fn.name === "findCocos")!;
  expect(find.signature).toBe("function findCocos(): CocosModule | null");
  expect(find.doc).toContain("Locate the cocos2d runtime module");
});
