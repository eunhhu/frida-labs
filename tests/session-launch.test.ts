import { expect, test } from "bun:test";
import { resolveLaunchRequest } from "../src/core/session.js";

const PROBE_ENTRY = "agent/targets/_probe/index.ts";

function expectInvalid(request: unknown): void {
  expect(() => resolveLaunchRequest(request)).toThrow();
}

test("probe name attach resolves to the canonical probe entry", () => {
  expect(resolveLaunchRequest({
    kind: "probe-attach-name",
    process: "  Game.exe  ",
    childGating: true,
  })).toEqual({
    options: {
      target: PROBE_ENTRY,
      processOverride: "Game.exe",
      childGating: true,
    },
    initialDisplay: "Game.exe",
  });
});

test("plain digits remain a process name in the name discriminant", () => {
  const resolved = resolveLaunchRequest({ kind: "probe-attach-name", process: "731" });
  expect(resolved.options.processOverride).toBe("731");
  expect(resolved.options.attachPid).toBeUndefined();
});

test("probe PID attach remains numeric and has a stable initial display", () => {
  expect(resolveLaunchRequest({ kind: "probe-attach-pid", pid: 731 })).toEqual({
    options: {
      target: PROBE_ENTRY,
      attachPid: 731,
      processDisplay: "pid:731",
    },
    initialDisplay: "pid:731",
  });

  expect(resolveLaunchRequest({
    kind: "probe-attach-pid",
    pid: 731,
    display: "  known process  ",
    childGating: false,
  })).toEqual({
    options: {
      target: PROBE_ENTRY,
      attachPid: 731,
      processDisplay: "known process",
      childGating: false,
    },
    initialDisplay: "known process",
  });
});

test("probe spawn maps the executable without manifest lookup", () => {
  expect(resolveLaunchRequest({ kind: "probe-spawn", executable: "  ./game  " })).toEqual({
    options: {
      target: PROBE_ENTRY,
      processOverride: "./game",
      spawn: true,
    },
    initialDisplay: "./game",
  });
});

test("target launch preserves the compatibility session options", () => {
  expect(resolveLaunchRequest({
    kind: "target",
    target: " terraria ",
    processOverride: " Terraria.exe ",
    spawn: true,
    noWatch: true,
    spawnGating: true,
    childGating: false,
  })).toEqual({
    options: {
      target: "terraria",
      processOverride: "Terraria.exe",
      spawn: true,
      noWatch: true,
      spawnGating: true,
      childGating: false,
    },
    initialDisplay: "Terraria.exe",
  });
});

test("launch requests preserve one strict device selector across attach and spawn", () => {
  expect(resolveLaunchRequest({
    kind: "probe-attach-pid",
    pid: 731,
    device: { kind: "usb", timeoutMs: 8_000 },
  }).options.device).toEqual({ kind: "usb", timeoutMs: 8_000 });
  expect(resolveLaunchRequest({
    kind: "probe-spawn",
    executable: "com.example.game",
    device: { kind: "endpoint", address: "10.0.0.8:27042" },
  }).options.device).toEqual({ kind: "endpoint", address: "10.0.0.8:27042" });
  expect(resolveLaunchRequest({
    kind: "target",
    target: "terraria",
    device: { kind: "id", id: "phone-1" },
  }).options.device).toEqual({ kind: "id", id: "phone-1" });
});

test("launch validation rejects invalid values and mixed union variants", () => {
  for (const request of [
    null,
    [],
    {},
    { kind: "unknown" },
    { kind: "probe-attach-name", process: "" },
    { kind: "probe-attach-name", process: "Game", spawnGating: true },
    { kind: "probe-attach-name", process: 42 },
    { kind: "probe-attach-pid", pid: 0 },
    { kind: "probe-attach-pid", pid: -1 },
    { kind: "probe-attach-pid", pid: 1.5 },
    { kind: "probe-attach-pid", pid: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "probe-attach-pid", pid: Number.NaN },
    { kind: "probe-attach-pid", pid: Number.POSITIVE_INFINITY },
    { kind: "probe-attach-pid", pid: "42" },
    { kind: "probe-attach-pid", pid: 42, display: "   " },
    { kind: "probe-attach-pid", pid: 42, executable: "Game" },
    { kind: "probe-attach-pid", pid: 42, spawnGating: true },
    { kind: "probe-attach-pid", pid: 42, spawn: true },
    { kind: "probe-spawn", executable: "   " },
    { kind: "probe-spawn", executable: "Game", childGating: true },
    { kind: "probe-spawn", executable: 42 },
    { kind: "probe-spawn", executable: "Game", spawnGating: true },
    { kind: "target", target: "" },
    { kind: "target", target: "game", processOverride: "   " },
    { kind: "target", target: "game", spawnGating: "yes" },
    { kind: "target", target: "game", executable: "Game" },
    { kind: "target", target: "game", childGating: 1 },
    { kind: "target", target: "game", device: { kind: "usb", extra: true } },
    { kind: "probe-spawn", executable: "Game", device: { kind: "id", id: "" } },
  ]) {
    expectInvalid(request);
  }
});
