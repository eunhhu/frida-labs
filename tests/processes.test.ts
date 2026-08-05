import { expect, test } from "bun:test";
import {
  annotateProcesses,
  canonicalProcessName,
  mapApplicationIdentifiers,
  processNameMatches,
  resolveAttachTarget,
  type AttachDiscoveryDevice,
} from "../src/core/processes.js";

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

test("localized mobile processes map back to saved bundle-id targets", () => {
  const visible = mapApplicationIdentifiers(
    [{ pid: 731, name: "냥코 대전쟁" }],
    [{ pid: 731, name: "냥코 대전쟁", identifier: "jp.co.ponos.battlecatskr" }],
  );
  const rows = annotateProcesses(visible, {
    targets: {
      battlecatskr: {
        process: "jp.co.ponos.battlecatskr",
        mode: "attach",
        entry: "agent/targets/battlecatskr/index.ts",
        device: { kind: "id", id: "phone-1" },
      },
    },
  }, "linux", {
    id: "phone-1",
    name: "Phone",
    type: "usb",
    platform: "linux",
    arch: "arm64",
    selector: { kind: "usb" },
  });

  expect(rows).toEqual([{
    pid: 731,
    name: "냥코 대전쟁",
    identifiers: ["jp.co.ponos.battlecatskr"],
    matchedTargets: ["battlecatskr"],
    suggestedAction: "attach-target",
  }]);
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

test("attach resolves a mobile bundle identifier to its running PID", async () => {
  const device: AttachDiscoveryDevice = {
    enumerateProcesses: async () => [{ pid: 731, name: "localized game name" }],
    enumerateApplications: async (options) => {
      expect(options).toEqual({ identifiers: ["com.example.game"] });
      return [{ pid: 731, name: "Localized Game", identifier: "com.example.game" }];
    },
  };

  await expect(resolveAttachTarget(device, "com.example.game")).resolves.toEqual({
    target: 731,
    display: "Localized Game (com.example.game)",
    source: "application",
  });
});

test("attach keeps desktop process-name matching ahead of application lookup", async () => {
  let applicationLookups = 0;
  const device: AttachDiscoveryDevice = {
    enumerateProcesses: async () => [{ pid: 42, name: "Terraria" }],
    enumerateApplications: async () => {
      applicationLookups += 1;
      return [];
    },
  };

  await expect(resolveAttachTarget(device, "Terraria.exe")).resolves.toEqual({
    target: 42,
    display: "Terraria",
    source: "process",
  });
  expect(applicationLookups).toBe(0);
});

test("attach explains when a configured mobile application is not running", async () => {
  const device: AttachDiscoveryDevice = {
    enumerateProcesses: async () => [],
    enumerateApplications: async () => [
      { pid: 0, name: "Example", identifier: "com.example.game" },
    ],
  };

  await expect(resolveAttachTarget(device, "com.example.game")).rejects.toThrow(
    "Example (com.example.game) is installed but not running",
  );
});

test("attach falls back to configured name when discovery is unavailable", async () => {
  const unavailable = async (): Promise<never> => { throw new Error("unsupported"); };
  const device: AttachDiscoveryDevice = {
    enumerateProcesses: unavailable,
    enumerateApplications: unavailable,
  };

  await expect(resolveAttachTarget(device, "Game.exe")).resolves.toEqual({
    target: "Game.exe",
    display: "Game.exe",
    source: "configured",
  });
});
