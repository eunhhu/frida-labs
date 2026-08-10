import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnalysisRecordStore,
  loadManifest,
  normalizeAnalysisRecordPlan,
  repoRoot,
  targetTemplate,
  type DeviceInfo,
} from "../src/core/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "flab-records-"));
  roots.push(value);
  return value;
}

const device: DeviceInfo = {
  id: "local",
  name: "Local System",
  type: "local",
  platform: "darwin",
  arch: "arm64",
  selector: { kind: "local" },
};

test("analysis Records persist bounded events and derive AI-ready call summaries", async () => {
  const store = new AnalysisRecordStore({ root: root() });
  const metadata = store.start(
    "human jump",
    { target: "_probe", process: "Fixture", pid: 42, device },
    [
      { id: "input", name: "Game!Input", address: "0x1000", args: 2 },
      { id: "jump", name: "Game!Jump", address: "0x2000", args: 1 },
    ],
    { maxEvents: 20 },
  );
  const append = (sequence: number, event: Record<string, unknown>): boolean => store.append({
    type: "flab.record.event",
    schema: "flab.record.event.v1",
    recordId: metadata.id,
    sequence,
    event,
  });
  expect(append(1, { phase: "enter", probeId: "input", function: "Game!Input", timestamp: 100, threadId: 7, args: ["0x1", "0x2"] })).toBe(true);
  expect(append(2, { phase: "leave", probeId: "input", function: "Game!Input", timestamp: 102, threadId: 7, durationMs: 2, returnValue: "0x1" })).toBe(true);
  expect(append(3, { phase: "enter", probeId: "jump", function: "Game!Jump", timestamp: 110, threadId: 7, args: ["0x9"] })).toBe(true);
  expect(append(4, { phase: "leave", probeId: "jump", function: "Game!Jump", timestamp: 115, threadId: 7, durationMs: 5, returnValue: "0x0" })).toBe(true);

  const stopped = await store.stop(metadata.id, "requested", { ok: true, emitted: 4 });
  expect(stopped).toMatchObject({ status: "completed", eventCount: 4, dropped: 0 });
  expect(store.list()[0]).toMatchObject({ id: metadata.id, eventsPath: expect.stringContaining("artifacts/records/") });

  const page = await store.read(metadata.id, 0, 2);
  expect(page.events).toHaveLength(2);
  expect(page.nextCursor).toBe(2);
  expect(page.eof).toBe(false);

  const summary = await store.summary(metadata.id);
  expect(summary.functions).toMatchObject([
    { probeId: "input", enters: 1, leaves: 1, durationMs: { average: 2 }, argumentSamples: [["0x1", "0x2"]], returnSamples: ["0x1"] },
    { probeId: "jump", enters: 1, leaves: 1, durationMs: { average: 5 } },
  ]);
  expect(summary.transitions).toContainEqual({ from: "input", to: "jump", count: 1 });
});

test("Record plans reject unbounded or ambiguous hooks before attach", () => {
  expect(() => normalizeAnalysisRecordPlan([], {})).toThrow("1..64");
  expect(() => normalizeAnalysisRecordPlan([{ id: "same", address: "0x1" }, { id: "same", address: "0x2" }], {})).toThrow("unique");
  expect(() => normalizeAnalysisRecordPlan([{ id: "fn", address: "not-a-pointer" }], {})).toThrow("hexadecimal");
  expect(() => normalizeAnalysisRecordPlan([{ id: "fn", address: "0x1" }], { maxEvents: 100_001 })).toThrow("maxEvents");
});

test("Record summaries do not invent transitions between unrelated threads", async () => {
  const store = new AnalysisRecordStore({ root: root() });
  const metadata = store.start(
    "parallel calls",
    { target: "_probe", process: "Fixture", pid: 43, device },
    [{ id: "a", address: "0x1000" }, { id: "b", address: "0x2000" }],
    { maxEvents: 10 },
  );
  for (const [sequence, probeId, threadId] of [[1, "a", 1], [2, "b", 2]] as const) {
    expect(store.append({
      type: "flab.record.event",
      schema: "flab.record.event.v1",
      recordId: metadata.id,
      sequence,
      event: { phase: "enter", probeId, timestamp: sequence, threadId, args: [] },
    })).toBe(true);
  }
  await store.stop(metadata.id, "requested");
  expect((await store.summary(metadata.id)).transitions).toEqual([]);
});

test("every saved and newly scaffolded Instrument exposes the common Record surface", () => {
  const root = repoRoot();
  for (const [name, target] of Object.entries(loadManifest(root).targets)) {
    const source = readFileSync(join(root, target.entry), "utf8");
    expect(source, `${name} declarative Record surface`).toContain("recordingInstrumentActions()");
    expect(source, `${name} single Instrument declaration`).toContain("defineInstrument({");
  }
  const scaffold = targetTemplate("record-ready");
  expect(scaffold).toContain("recordingInstrumentActions()");
  expect(scaffold).toContain("defineInstrument({");
});
