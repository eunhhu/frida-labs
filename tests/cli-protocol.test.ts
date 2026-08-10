import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCliArgs } from "../src/cli/args.js";
import { runCli } from "../src/cli/index.js";
import { commands } from "../src/core/commands.js";
import {
  targetMutationFailure,
  targetMutationSuccess,
} from "../src/core/protocol.js";
import { loadManifest, repoRoot, type TargetConfig } from "../src/core/manifest.js";
import type { ProjectResult } from "../src/core/projects.js";

function capture(): { out: string[]; err: string[]; io: { out(line: string): void; err(line: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

function output(result: ReturnType<typeof capture>): unknown {
  expect(result.out).toHaveLength(1);
  expect(result.err).toEqual([]);
  return JSON.parse(result.out[0]!);
}

const config: TargetConfig = {
  process: "Game.exe",
  mode: "attach",
  entry: "agent/targets/game/index.ts",
};

function projectResult(
  operation: ProjectResult["operation"],
  name = "game",
  warnings: string[] = [],
): ProjectResult {
  return {
    operation,
    name,
    entry: config.entry,
    config,
    warnings,
  };
}

test("boolean flags never consume positional arguments", () => {
  expect(parseCliArgs(["build", "--json", "terraria"])).toEqual({
    command: "build",
    args: ["terraria"],
    flags: { json: true },
  });
  expect(parseCliArgs(["run", "--no-watch", "terraria", "--json"])).toEqual({
    command: "run",
    args: ["terraria"],
    flags: { "no-watch": true, json: true },
  });
  expect(parseCliArgs(["run", "terraria", "--console"])).toEqual({
    command: "run",
    args: ["terraria"],
    flags: { console: true },
  });
  expect(parseCliArgs(["probe", "--session", "Game.exe", "--json"])).toEqual({
    command: "probe",
    args: ["Game.exe"],
    flags: { session: true, json: true },
  });
});

test("global and command help are successful and beginner-oriented", async () => {
  expect(parseCliArgs(["--help"])).toEqual({ command: "help", args: [], flags: {} });
  expect(parseCliArgs(["probe", "-h"])).toEqual({ command: "probe", args: [], flags: { help: true } });

  const global = capture();
  expect(await runCli(["--help"], global.io)).toBe(0);
  expect(global.err).toEqual([]);
  expect(global.out[0]).toContain("Connect → Analyze → Instrument");
  expect(global.out[0]).toContain("flab <command> --help");

  const command = capture();
  expect(await runCli(["probe", "--help"], command.io)).toBe(0);
  expect(command.err).toEqual([]);
  expect(command.out[0]).toContain("flab probe");
  expect(command.out[0]).toContain("engine-agnostic");

  const runHelp = capture();
  expect(await runCli(["run", "--help"], runHelp.io)).toBe(0);
  expect(runHelp.err).toEqual([]);
  expect(runHelp.out[0]).toContain("human Instrument dashboard");
  expect(runHelp.out[0]).toContain("--console");
});

test("value flags remain order-independent and reject missing values", () => {
  expect(parseCliArgs(["target", "set", "game", "--mode=spawn", "--proc", "Game.exe", "--json"])).toEqual({
    command: "target",
    args: ["set", "game"],
    flags: { mode: "spawn", proc: "Game.exe", json: true },
  });
  expect(parseCliArgs(["probe", "--pid", "123", "--json"])).toEqual({
    command: "probe",
    args: [],
    flags: { pid: "123", json: true },
  });
  expect(parseCliArgs(["probe", "123", "--json"])).toEqual({
    command: "probe",
    args: ["123"],
    flags: { json: true },
  });
  expect(parseCliArgs(["run", "game", "--device", "usb", "--device-timeout=8000", "--json"])).toEqual({
    command: "run",
    args: ["game"],
    flags: { device: "usb", "device-timeout": "8000", json: true },
  });
  expect(parseCliArgs(["probe", "Game", "--host", "10.0.0.8:27042", "--json"])).toEqual({
    command: "probe",
    args: ["Game"],
    flags: { host: "10.0.0.8:27042", json: true },
  });
  expect(parseCliArgs(["build", "game", "--out"])).toEqual({
    command: "build",
    args: ["game"],
    flags: {},
    error: {
      code: "missing-flag-value",
      flag: "out",
      message: "--out requires a value",
    },
  });
});

test("the registry exposes the approved device-aware command scope", () => {
  expect(commands.map((command) => command.name)).toEqual([
    "acp",
    "mcp",
    "agent",
    "devices",
    "processes",
    "targets",
    "new",
    "target",
    "build",
    "package",
    "run",
    "probe",
    "capabilities",
    "lib",
    "depcheck",
    "doctor",
  ]);
  const deviceFlags = ["device", "host", "device-timeout"];
  expect(commands.find((command) => command.name === "acp")?.allowedFlags).toEqual(["json", "upstream"]);
  expect(commands.find((command) => command.name === "mcp")?.allowedFlags).toEqual([]);
  expect(commands.find((command) => command.name === "agent")?.allowedFlags).toEqual(["json"]);
  expect(commands.find((command) => command.name === "devices")?.allowedFlags).toEqual(["json", ...deviceFlags]);
  expect(commands.find((command) => command.name === "processes")?.allowedFlags).toEqual(["json", "limit", "query", ...deviceFlags]);
  expect(commands.find((command) => command.name === "probe")?.allowedFlags).toEqual(["json", "pid", "spawn", "eval", "session", ...deviceFlags]);
  expect(commands.find((command) => command.name === "run")?.allowedFlags).toEqual(["json", "proc", "spawn", "console", "eval", "no-watch", "session", ...deviceFlags]);
  expect(commands.find((command) => command.name === "capabilities")?.allowedFlags).toEqual(["json"]);
  expect(commands.find((command) => command.name === "targets")?.allowedFlags).toEqual(["json"]);
  expect(commands.find((command) => command.name === "new")?.allowedFlags).toEqual(["json", "proc", ...deviceFlags]);
  expect(commands.find((command) => command.name === "build")?.allowedFlags).toEqual(["json", "out"]);
  expect(commands.find((command) => command.name === "package")?.allowedFlags).toEqual(["json", "out"]);
  expect(commands.find((command) => command.name === "lib")?.allowedFlags).toEqual(["json"]);
  expect(commands.find((command) => command.name === "depcheck")?.allowedFlags).toEqual(["json"]);
  expect(commands.find((command) => command.name === "doctor")?.allowedFlags).toEqual(["json", ...deviceFlags]);
  expect(commands.find((command) => command.name === "target")?.allowedFlags).toEqual([
    "json",
    "proc",
    "mode",
    "entry",
    "platforms",
    "registry-only",
    "confirm",
    ...deviceFlags,
  ]);
  expect(commands.find((command) => command.name === "target")?.usage).toBe(
    "flab target <set|rename|unregister|delete> ... [--json]",
  );
  expect(commands.find((command) => command.name === "target")?.detail?.split("\n")).toEqual([
    "set <name> [--proc P] [--mode attach|spawn] [--entry E] [--platforms JSON] [--device DEVICE | --host HOST]",
    "rename <old> <new> [--registry-only]",
    "unregister <name>",
    "delete <name> --confirm <name>",
  ]);
});

test("removed target subcommands fail as unknown operations without mutation", async () => {
  const manifestBefore = loadManifest();
  const removedSource = join(repoRoot(), "agent", "targets", "cli-contract-removed-scope");
  const sourceExistedBefore = existsSync(removedSource);
  const usage = "usage: flab target <set|rename|unregister|delete> ...";

  for (const [operation, operands] of [
    ["create", ["cli-contract-removed-scope"]],
    ["list", []],
    ["get", ["terraria"]],
    ["validate", ["terraria"]],
  ] as const) {
    const result = capture();
    expect(await runCli(["target", operation, ...operands, "--json"], result.io)).toBe(2);
    expect(output(result)).toEqual({
      error: `unknown target operation "${operation}". ${usage}`,
    });
  }

  const removedFlag = capture();
  expect(await runCli(["target", "validate", "--all", "--json"], removedFlag.io)).toBe(2);
  expect(output(removedFlag)).toEqual({ error: "unknown flag --all" });

  expect(loadManifest()).toEqual(manifestBefore);
  expect(existsSync(removedSource)).toBe(sourceExistedBefore);
});

test("target mutation success receipts contain exactly operation-relevant keys", () => {
  expect(targetMutationSuccess("set", projectResult("update"))).toEqual({
    ok: true,
    operation: "set",
    target: "game",
    config,
    warnings: [],
  });
  expect(targetMutationSuccess("rename", projectResult("rename", "renamed", ["source moved"]))).toEqual({
    ok: true,
    operation: "rename",
    target: "renamed",
    entry: "agent/targets/game/index.ts",
    config,
    warnings: ["source moved"],
  });
  expect(targetMutationSuccess("unregister", projectResult("unregister"))).toEqual({
    ok: true,
    operation: "unregister",
    target: "game",
    entry: "agent/targets/game/index.ts",
    warnings: [],
  });
  expect(targetMutationSuccess("delete", projectResult("delete"))).toEqual({
    ok: true,
    operation: "delete",
    target: "game",
    warnings: [],
  });
});

test("target mutation failure receipts contain no transport or error-envelope keys", () => {
  expect(targetMutationFailure("rename", "collision", "target already exists")).toEqual({
    ok: false,
    operation: "rename",
    code: "collision",
    message: "target already exists",
  });
  expect(targetMutationFailure("delete", "io", "cleanup failed", "/tmp/residue")).toEqual({
    ok: false,
    operation: "delete",
    code: "io",
    message: "cleanup failed",
    residue: "/tmp/residue",
  });
});

test("target usage and exact-name delete confirmation failures exit 2 with exact JSON", async () => {
  const rename = capture();
  expect(await runCli(["target", "rename", "game", "--json"], rename.io)).toBe(2);
  expect(output(rename)).toEqual({
    ok: false,
    operation: "rename",
    code: "usage",
    message: "usage: flab target rename <old> <new> [--registry-only]",
  });

  const confirmation = capture();
  expect(await runCli(["target", "delete", "game", "--json"], confirmation.io)).toBe(2);
  expect(output(confirmation)).toEqual({
    ok: false,
    operation: "delete",
    code: "confirmation",
    message: "delete confirmation must exactly match \"game\"",
  });
});

test("target validation and runtime operation failures exit 1 with exact JSON", async () => {
  const validation = capture();
  expect(await runCli(["target", "set", "game", "--mode", "invalid", "--json"], validation.io)).toBe(1);
  expect(output(validation)).toEqual({
    ok: false,
    operation: "set",
    code: "validation",
    message: "--mode must be attach or spawn",
  });

  const missing = capture();
  expect(await runCli(["target", "unregister", "cli-contract-missing", "--json"], missing.io)).toBe(1);
  expect(output(missing)).toEqual({
    ok: false,
    operation: "unregister",
    code: "unknown_target",
    message: "unknown target \"cli-contract-missing\"",
  });

  const [oldName, nextName] = Object.keys(loadManifest().targets);
  expect(oldName).toBeDefined();
  expect(nextName).toBeDefined();
  const conflict = capture();
  expect(await runCli(["target", "rename", oldName!, nextName!, "--json"], conflict.io)).toBe(1);
  expect(output(conflict)).toEqual({
    ok: false,
    operation: "rename",
    code: "collision",
    message: `target "${nextName}" already exists`,
  });
});

test("strict operation flags use exact target failures and removed flags stay removed", async () => {
  const inapplicable = capture();
  expect(await runCli(["target", "rename", "old", "next", "--platforms", "{}", "--json"], inapplicable.io)).toBe(2);
  expect(output(inapplicable)).toEqual({
    ok: false,
    operation: "rename",
    code: "unknown-flag",
    message: "--platforms is not valid for this operation",
  });

  const dryRun = capture();
  expect(await runCli(["target", "rename", "old", "next", "--dry-run", "--json"], dryRun.io)).toBe(2);
  expect(output(dryRun)).toEqual({
    ok: false,
    operation: "rename",
    code: "unknown-flag",
    message: "unknown flag --dry-run",
  });
});

test("strict command flags and surplus arguments are usage errors", async () => {
  const knownButWrong = capture();
  expect(await runCli(["doctor", "--proc", "Game.exe", "--json"], knownButWrong.io)).toBe(2);
  expect(output(knownButWrong)).toEqual({ error: "--proc is not valid for doctor" });

  const unknown = capture();
  expect(await runCli(["doctor", "--unknown", "--json"], unknown.io)).toBe(2);
  expect(output(unknown)).toEqual({ error: "unknown flag --unknown" });

  const extra = capture();
  expect(await runCli(["doctor", "unexpected", "--json"], extra.io)).toBe(2);
  expect(output(extra)).toEqual({ error: "usage: flab doctor" });
});

test("capabilities are discoverable and machine sessions require explicit JSON transport", async () => {
  const capability = capture();
  expect(await runCli(["capabilities", "--json"], capability.io)).toBe(0);
  expect(output(capability)).toMatchObject({
    protocol: "flab.ndjson.v1",
    instrumentLifecycle: {
      create: expect.stringContaining("instrumentStart"),
      edit: expect.stringContaining("instrumentUpdate"),
      delete: expect.stringContaining("instrumentDelete"),
    },
  });

  const session = capture();
  expect(await runCli(["probe", "Game.exe", "--session"], session.io)).toBe(2);
  expect(session.out).toEqual([]);
  expect(session.err).toEqual(["--session requires --json"]);

  const mixed = capture();
  expect(await runCli(["probe", "Game.exe", "--session", "--eval", "1", "--json"], mixed.io)).toBe(2);
  expect(output(mixed)).toEqual({ error: "--session cannot be combined with --eval" });

  const consoleJson = capture();
  expect(await runCli(["run", "terraria", "--console", "--json"], consoleJson.io)).toBe(2);
  expect(output(consoleJson)).toEqual({ error: "--console cannot be combined with --json" });
});

test("PID probe validation occurs before Frida and uses validation exit 1", async () => {
  for (const argv of [
    ["probe", "--pid", "0", "--json"],
    ["probe", "--pid", "12x", "--json"],
    ["probe", "--pid", "123", "--spawn", "--json"],
  ]) {
    const result = capture();
    expect(await runCli(argv, result.io)).toBe(1);
    expect(output(result)).toEqual({
      error: argv.includes("--spawn")
        ? "--pid cannot be combined with --spawn"
        : "--pid must be a positive safe integer",
    });
  }

  const ambiguous = capture();
  expect(await runCli(["probe", "Game.exe", "--pid", "123", "--json"], ambiguous.io)).toBe(2);
  expect(output(ambiguous)).toEqual({
    error: "usage: flab probe (<process> | --pid <pid>) [--eval code]",
  });
});

test("conflicting device selectors fail before Frida", async () => {
  const result = capture();
  expect(await runCli([
    "probe", "Game.exe", "--device", "usb", "--host", "10.0.0.8:27042", "--json",
  ], result.io)).toBe(1);
  expect(output(result)).toEqual({ error: "--device and --host are mutually exclusive" });
});
