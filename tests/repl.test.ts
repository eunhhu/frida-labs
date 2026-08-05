import { expect, test } from "bun:test";
import { completeHumanRepl } from "../src/core/commands.js";

test("human REPL completes direct and awaited RPC calls", () => {
  expect(completeHumanRepl("await modI", ["modInfo", "modState"])).toEqual([
    ["await modInfo("],
    "await modI",
  ]);
  expect(completeHumanRepl("modS", ["modInfo", "modState"])).toEqual([
    ["modState("],
    "modS",
  ]);
  expect(completeHumanRepl(".e", ["modInfo"])).toEqual([[".exit"], ".e"]);
});
