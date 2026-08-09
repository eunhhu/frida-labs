import { expect, test } from "bun:test";
import { completeHumanRepl, humanReplHelp } from "../src/core/commands.js";

test("human REPL completes direct and awaited RPC calls", () => {
  expect(completeHumanRepl("await modI", ["modInfo", "modState"])).toEqual([
    ["await modInfo("],
    "await modI",
  ]);
  expect(completeHumanRepl("modS", ["modInfo", "modState"])).toEqual([
    ["modState("],
    "modS",
  ]);
  expect(completeHumanRepl(".e", ["modInfo"])).toEqual([[".exit", ".exports"], ".e"]);
  expect(completeHumanRepl("/h", ["modInfo"])).toEqual([["/help"], "/h"]);
});

test("human REPL help is host-generated from descriptors and advertises the TUI controls", () => {
  const help = humanReplHelp([{
    name: "toggle",
    label: "God mode",
    category: "Player",
    args: [{ name: "enabled", type: "boolean", ui: { control: "checkbox" } }],
    capabilities: ["instrument"],
    effect: "control",
    returns: "json",
  }]);
  expect(help).toContain(".help | /help | :help");
  expect(help).toContain("checkboxes, sliders, selects, input fields");
  expect(help).toContain("toggle(enabled:checkbox) — God mode");
});
