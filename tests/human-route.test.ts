import { expect, test } from "bun:test";
import { humanTuiSource } from "../src/cli/human-route.js";

test("interactive human launches open the dashboard while explicit expert transports stay CLI", () => {
  expect(humanTuiSource([], true)).toBe("default");
  expect(humanTuiSource(["tui"], true)).toBe("tui");
  expect(humanTuiSource(["run", "terraria"], true)).toBe("run");
  expect(humanTuiSource(["run", "terraria", "--spawn"], true)).toBe("run");

  for (const argv of [
    ["run", "terraria", "--console"],
    ["run", "terraria", "--eval", "modState()"],
    ["run", "terraria", "--session", "--json"],
    ["run", "--help"],
    ["run", "-h"],
  ]) expect(humanTuiSource(argv, true), argv.join(" ")).toBeNull();

  expect(humanTuiSource(["run", "terraria"], false)).toBeNull();
  expect(humanTuiSource([], false)).toBeNull();
});

test("FLAB_NO_TUI forces CLI dispatch even on a TTY", () => {
  process.env.FLAB_NO_TUI = "1";
  try {
    expect(humanTuiSource([], true)).toBeNull();
    expect(humanTuiSource(["run", "terraria"], true)).toBeNull();
    expect(humanTuiSource(["tui"], true)).toBeNull();
  } finally {
    delete process.env.FLAB_NO_TUI;
  }
});
