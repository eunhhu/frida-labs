import { expect, test } from "bun:test";
import { annotateProcesses, canonicalProcessName, processNameMatches } from "../src/core/processes.js";

test("process matching handles platform extensions and paths", () => {
  expect(canonicalProcessName("C:\\Games\\Terraria.exe")).toBe("terraria");
  expect(processNameMatches("Terraria.exe", "Terraria")).toBe(true);
  expect(processNameMatches("Terraria.bin.osx", "Terraria.bin.osx")).toBe(true);
  expect(processNameMatches("Other.exe", "Terraria")).toBe(false);
});

test("process candidates expose target matches and a next action", () => {
  const rows = annotateProcesses([
    { pid: 10, name: "Game" },
    { pid: 11, name: "Unknown" },
  ], {
    targets: {
      game: { process: "Game.exe", mode: "attach", entry: "agent/targets/game/index.ts" },
    },
  }, "linux");
  expect(rows).toEqual([
    { pid: 10, name: "Game", matchedTargets: ["game"], suggestedAction: "attach-target" },
    { pid: 11, name: "Unknown", matchedTargets: [], suggestedAction: "probe" },
  ]);
});

test("process matching uses remote platform overrides and excludes targets on other devices", () => {
  const rows = annotateProcesses([
    { pid: 20, name: "MobileGame" },
  ], {
    targets: {
      mobile: {
        process: "MobileGame.exe",
        processByPlatform: { darwin: "MobileGame" },
        mode: "attach",
        entry: "agent/targets/mobile/index.ts",
        device: { kind: "usb" },
      },
      local: {
        process: "MobileGame",
        mode: "attach",
        entry: "agent/targets/local/index.ts",
      },
    },
  }, "darwin", {
    id: "phone-1",
    name: "Phone",
    type: "usb",
    platform: "darwin",
    arch: "arm64",
    selector: { kind: "id", id: "phone-1" },
  });
  expect(rows[0]?.matchedTargets).toEqual(["mobile"]);
});
