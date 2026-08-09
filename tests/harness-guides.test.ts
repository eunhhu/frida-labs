import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

const skillPaths = [
  ".agents/skills/build-game-mod/SKILL.md",
  ".claude/skills/build-game-mod/SKILL.md",
  ".gjc/skills/build-game-mod/SKILL.md",
] as const;

test("every coding harness resolves the same game-mod completion contract", () => {
  const guide = read("docs/agent-game-mod-guide.md");
  for (const phrase of [
    "flab.ndjson.v1",
    "flab.control.v1",
    "flab acp",
    "flab mcp",
    "record.plan",
    "record.summary",
    "instrument.source.write",
    "module.link",
    "instrument.package",
    "modInfo",
    "modHelp",
    "modState",
    "label",
    "category",
    "instrumentStart",
    "LIVE VERIFICATION BLOCKED",
    "agent/targets/<slug>/README.md",
    "win condition",
    "economy",
    "reward",
    "semantic-model.json",
    "aim assist",
    "ESP/awareness",
    "movement assistance",
    "memory write watch",
    "auto-fire",
  ]) {
    expect(guide).toContain(phrase);
  }

  for (const path of skillPaths) {
    const skill = read(path);
    expect(skill.startsWith("---\nname: build-game-mod\ndescription:")).toBe(true);
    expect(skill).toContain("docs/agent-game-mod-guide.md");
    expect(skill).toContain("TUI");
    expect(skill).toContain("REPL");
    expect(skill).toContain("NDJSON");
    expect(skill).toContain("LIVE VERIFICATION BLOCKED");
    expect(skill).toContain("win-loss");
    expect(skill).toContain("economy/reward");
    expect(skill).toContain("aim assist");
    expect(skill).toContain("ESP/awareness");
    expect(skill).toContain("movement assistance");
    expect(skill).toContain("flab.control.v1");
    expect(skill).toContain("flab acp");
    expect(skill).toContain("flab mcp");
    expect(skill).toContain("record.plan");
    expect(skill).not.toContain("TODO");
  }
});

test("harness-native invocation adapters remain discoverable", () => {
  const readme = read("README.md");
  expect(readme).toContain("/skill:build-game-mod");
  expect(readme).toContain("$build-game-mod");
  expect(readme).toContain("/build-game-mod");
  expect(readme).toContain("/game-mod");
  expect(readme).toContain("flab agent --json");
  expect(readme).toContain("flab acp");
  expect(readme).toContain("flab mcp");
  expect(readme).toContain('gjc --mcp-config "$PWD/.mcp.json"');

  expect(JSON.parse(read(".mcp.json"))).toEqual({
    mcpServers: {
      flab: {
        type: "stdio",
        command: "bun",
        args: ["src/bin.ts", "mcp"],
      },
    },
  });
  expect(read(".codex/config.toml")).toContain("[mcp_servers.flab]");
  expect(read(".codex/config.toml")).toContain('args = ["src/bin.ts", "mcp"]');

  const control = read("docs/agent-control-api.md");
  expect(control).toContain("owned-offline");
  expect(control).toContain("private-lab");
  expect(control).toContain("participantsConsented");
  expect(control).toContain("instrument.source.write");
  expect(control).toContain("module.link");
  expect(control).toContain("instrument.package");
  expect(control).toContain("flab_control");
  expect(control).toContain("record.summary");
  expect(control).toContain("Never use prompt");

  const gjc = read(".gjc/config.yml");
  expect(gjc).toContain("enabled: true");
  expect(gjc).toContain("enableSkillCommands: true");
  expect(gjc).toContain("enablePiProject: true");

  const openCode = read(".opencode/commands/game-mod.md");
  expect(openCode).toContain("agent: build");
  expect(openCode).toContain("$ARGUMENTS");
  expect(openCode).toContain("build-game-mod");
  expect(openCode).toContain("win-loss");
  expect(openCode).toContain("aim assist");
  expect(openCode).toContain("offline confirmation");

  const ignore = read(".gitignore");
  expect(ignore).toContain("!.gjc/config.yml");
  expect(ignore).toContain("!.gjc/skills/*/SKILL.md");
});
