import { expect, test } from "bun:test";
import { buildProbeRequest, buildTargetLaunch } from "../src/tui/probe.js";
import {
  ANALYSIS_SURFACES,
  INSTRUMENT_SURFACES,
  launchForProcess,
  launchOnDevice,
  cycleSurface,
  processChoices,
  suggestedTargetName,
} from "../src/tui/index.js";
import { projectCommand } from "../src/tui/project.js";
import { PROJECT_VIEW } from "../src/tui/project.js";
import { EXPLORER_VIEW } from "../src/tui/explorer.js";
import { ACTION_VIEW } from "../src/tui/instrument.js";
import { parseRecordQuery, RECORD_ACTIONS } from "../src/tui/record.js";
import { MODE_PALETTE_ITEMS, journeyStage, modeAt, modeRoute, nextMode, paletteItemAt, routeGlobalInput } from "../src/tui/modebar.js";

test("mode and surface navigation wraps without invalid state", () => {
  expect(nextMode("instrument")).toBe("project");
  expect(modeAt(-1)).toBe("instrument");
  expect(paletteItemAt(999).mode).toBeDefined();
  expect(cycleSurface("instrument", "observe")).toBe("actions");
  expect(cycleSurface("analysis", "record")).toBe("actions");
  expect(modeRoute("analysis", 7)).toEqual({ mode: "analysis", sessionId: 7 });
  expect(modeRoute("project", null)).toEqual({ mode: "project", view: "list" });
  expect(journeyStage(modeRoute("project", null))).toBe("connect");
  expect(journeyStage(modeRoute("analysis", 7))).toBe("analyze");
  expect(journeyStage(modeRoute("instrument", 7))).toBe("instrument");
});

test("every visible TUI chooser is capped at three options", () => {
  expect(MODE_PALETTE_ITEMS).toHaveLength(3);
  expect(ANALYSIS_SURFACES).toHaveLength(3);
  expect(INSTRUMENT_SURFACES).toHaveLength(3);
  expect(ACTION_VIEW).toBe(3);
  expect(EXPLORER_VIEW).toBe(3);
  expect(PROJECT_VIEW).toBe(3);
  expect(RECORD_ACTIONS).toHaveLength(3);
});

test("Record query keeps one-field UX while allowing precise module scoping", () => {
  expect(parseRecordQuery("damage")).toEqual({ query: "damage" });
  expect(parseRecordQuery(" GameAssembly.dylib ! ApplyDamage ")).toEqual({
    module: "GameAssembly.dylib",
    query: "ApplyDamage",
  });
});

test("first-run process choices hide system noise and prioritize saved games", () => {
  const rows = [
    { pid: 1, name: "system-daemon", matchedTargets: [], suggestedAction: "probe" as const },
    { pid: 2, name: "Terraria.exe", matchedTargets: ["terraria"], suggestedAction: "attach-target" as const },
    { pid: 3, name: "Another Game", matchedTargets: [], suggestedAction: "probe" as const },
  ];
  expect(processChoices(rows, "", true).map((row) => row.pid)).toEqual([2]);
  expect(processChoices(rows, "game", true).map((row) => row.pid)).toEqual([3]);
  expect(processChoices(rows, "", false).map((row) => row.pid)).toEqual([2, 1, 3]);
});

test("captured text input permits only global quit", () => {
  expect(routeGlobalInput(true, "d", { ctrl: true })).toBe("captured");
  expect(routeGlobalInput(true, "", { escape: true })).toBe("captured");
  expect(routeGlobalInput(true, "q", { ctrl: true })).toBe("quit");
  expect(routeGlobalInput(false, "p", { ctrl: true })).toBe("global");
});
test("process enter follows a target match and otherwise opens Probe by PID", () => {
  expect(launchForProcess({
    pid: 42,
    name: "Game.exe",
    matchedTargets: ["game"],
    suggestedAction: "attach-target",
  })).toEqual({ kind: "target", target: "game", processOverride: "Game.exe" });
  expect(launchForProcess({
    pid: 43,
    name: "Unknown",
    matchedTargets: [],
    suggestedAction: "probe",
  })).toEqual({ kind: "probe-attach-pid", pid: 43, display: "Unknown" });
});

test("TUI launches bind process identity to the visible selected device", () => {
  expect(launchOnDevice(
    { kind: "probe-attach-pid", pid: 43, display: "Game" },
    { kind: "id", id: "phone-1" },
  )).toEqual({
    kind: "probe-attach-pid",
    pid: 43,
    display: "Game",
    device: { kind: "id", id: "phone-1" },
  });
});

test("process-to-target creation gets a safe visible suggestion", () => {
  expect(suggestedTargetName("C:\\Games\\My Game.exe")).toBe("my-game");
  expect(suggestedTargetName("Terraria.bin.osx")).toBe("terraria");
  expect(suggestedTargetName("!!!")).toBe("new-target");
});

test("global Ctrl shortcuts never become project mutations", () => {
  expect(projectCommand("d", { ctrl: true })).toBeNull();
  expect(projectCommand("r", { ctrl: true })).toBeNull();
  expect(projectCommand("d", {})).toBe("delete");
});

test("Probe form validates name, PID, and spawn requests before launch", () => {
  expect(buildProbeRequest("probe-attach-name", "  ", false)).toMatchObject({ ok: false });
  expect(buildProbeRequest("probe-attach-pid", "0", false)).toMatchObject({ ok: false });
  expect(buildProbeRequest("probe-attach-pid", "123", true)).toEqual({
    ok: true,
    request: { kind: "probe-attach-pid", pid: 123, childGating: true },
  });
  expect(buildProbeRequest("probe-spawn", " /games/Game ", true)).toEqual({
    ok: true,
    request: { kind: "probe-spawn", executable: "/games/Game" },
  });
});

test("registered target launch keeps spawn and child gating independent", () => {
  expect(buildTargetLaunch(" adofai ", undefined, false, false)).toEqual({
    kind: "target",
    target: "adofai",
  });
  expect(buildTargetLaunch("adofai", " ADOFAI ", true, false)).toEqual({
    kind: "target",
    target: "adofai",
    processOverride: "ADOFAI",
    spawnGating: true,
  });
  expect(buildTargetLaunch("adofai", undefined, false, true)).toEqual({
    kind: "target",
    target: "adofai",
    childGating: true,
  });
  expect(() => buildTargetLaunch(" ", undefined, false, false)).toThrow("target is required");
});
