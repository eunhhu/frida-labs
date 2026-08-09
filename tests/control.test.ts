import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnalysisRecordStore,
  CONTROL_PROTOCOL,
  createControlService,
  parseControlRequestLine,
  RecordingCoordinator,
  type ControlAuthorizationProfile,
  type GameSession,
  type ProjectService,
  type RpcDescriptor,
} from "../src/core/index.js";

const profile: ControlAuthorizationProfile = {
  purpose: "mod-development",
  objective: "Build and verify an Instrument for an owned test game",
  environment: "private-lab",
  ownership: {
    clientOwned: true,
    serverOwned: true,
    operatorApproved: true,
    participantsConsented: true,
  },
  isolation: {
    publicMatchmaking: false,
    publicLeaderboard: false,
    productionEconomy: false,
    thirdPartyAccounts: false,
  },
  antiCheat: "officially-disabled",
};

const descriptor: RpcDescriptor = {
  name: "entities",
  args: [],
  capabilities: ["analysis", "instrument"],
  effect: "read",
  returns: "table",
};

function fixtureSession(): GameSession {
  return {
    target: "fixture",
    process: "Fixture.exe",
    pid: 42,
    device: {
      id: "local",
      name: "Local System",
      type: "local",
      platform: "darwin",
      arch: "arm64",
      selector: { kind: "local" },
    },
    call: async () => [{ id: 1, x: 10, y: 20 }],
    eval: async () => null,
    rpcNames: () => ["entities"],
    describe: async () => [descriptor],
    close: async () => {},
  };
}

function fixtureProjects(): ProjectService {
  return {
    root: "/fixture",
    list: () => [{ name: "fixture", config: { process: "Fixture.exe", mode: "attach", entry: "agent/targets/fixture/index.ts" } }],
    create: async (draft) => ({ operation: "create", name: draft.name, entry: `agent/targets/${draft.name}/index.ts`, config: { process: draft.process, mode: draft.mode, entry: `agent/targets/${draft.name}/index.ts` }, warnings: [] }),
    update: async (name) => ({ operation: "update", name, entry: "agent/targets/fixture/index.ts", config: { process: "Fixture.exe", mode: "attach", entry: "agent/targets/fixture/index.ts" }, warnings: [] }),
    rename: async (_name, nextName) => ({ operation: "rename", name: nextName, entry: `agent/targets/${nextName}/index.ts`, config: { process: "Fixture.exe", mode: "attach", entry: `agent/targets/${nextName}/index.ts` }, warnings: [] }),
    remove: async (request) => ({ operation: request.policy === "unregister" ? "unregister" : "delete", name: request.name, entry: "agent/targets/fixture/index.ts", config: { process: "Fixture.exe", mode: "attach", entry: "agent/targets/fixture/index.ts" }, warnings: [] }),
  };
}

function service() {
  const before = "a".repeat(64);
  const after = "b".repeat(64);
  let source = {
    instrument: "fixture",
    path: "agent/targets/fixture/index.ts",
    text: "rpc.exports = {};\n",
    bytes: 18,
    sha256: before,
  };
  return createControlService({
    dependencies: {
      projects: fixtureProjects(),
      compile: async () => "compiled-bundle",
      modules: () => [],
      verify: () => ({ scanned: 4, violations: [] }),
      launch: async () => fixtureSession(),
      sourceRead: () => source,
      sourceWrite: (_name, text, expected) => {
        if (expected !== source.sha256) throw new Error("instrument source changed");
        source = { ...source, text, bytes: text.length, sha256: after };
        return source;
      },
      moduleLink: (_name, module) => ({ ...source, module, alias: "flab_assist", import: 'import * as flab_assist from "../../lib/assist.js";', alreadyLinked: false }),
    },
  });
}

test("Control protocol parser is bounded and preserves typed envelopes", () => {
  expect(parseControlRequestLine('{"id":"one","op":"ping"}')).toEqual({
    ok: true,
    request: { id: "one", op: "ping" },
  });
  expect(parseControlRequestLine("not-json")).toMatchObject({ ok: false, code: "invalid-json" });
  expect(parseControlRequestLine('{"id":"","op":"ping"}')).toMatchObject({ ok: false, code: "invalid-id" });
});

test("Control mutations and live sessions require a concrete authorization profile", async () => {
  const control = service();
  expect(await control.handle({ id: 1, op: "instrument.build", name: "fixture" })).toMatchObject({
    ok: false,
    error: { code: "authorization-required" },
  });

  expect(await control.handle({ id: 2, op: "authorize", profile })).toMatchObject({
    ok: true,
    result: { authorized: true, profile: { environment: "private-lab" } },
  });
  expect(await control.handle({ id: 3, op: "instrument.build", name: "fixture" })).toMatchObject({
    ok: true,
    result: { instrument: "fixture", bytes: 15 },
  });
  expect(await control.handle({ id: 4, op: "verify.static" })).toMatchObject({
    ok: true,
    result: { passed: true, scanned: 4, violations: [] },
  });
  expect(await control.handle({ id: 5, op: "instrument.source.read", name: "fixture" })).toMatchObject({
    ok: true,
    result: { path: "agent/targets/fixture/index.ts", sha256: "a".repeat(64) },
  });
  expect(await control.handle({ id: 6, op: "instrument.source.write", name: "fixture", text: "next", expectedSha256: "a".repeat(64) })).toMatchObject({
    ok: true,
    result: { text: "next", sha256: "b".repeat(64) },
  });
  expect(await control.handle({ id: 7, op: "module.link", name: "fixture", module: "assist", expectedSha256: "b".repeat(64) })).toMatchObject({
    ok: true,
    result: { module: "assist", alias: "flab_assist" },
  });
  expect(await control.handle({ id: 8, op: "instrument.source.write", name: "fixture", text: "unsafe overwrite" })).toMatchObject({
    ok: false,
    error: { code: "invalid-request", message: expect.stringContaining("expectedSha256") },
  });
});

test("Control API covers connect, analyze, Instrument action, and cleanup without TUI scraping", async () => {
  const control = service();
  await control.handle({ id: "auth", op: "authorize", profile });
  expect(await control.handle({ id: "open", op: "session.open", launch: { kind: "target", target: "fixture" } })).toMatchObject({
    ok: true,
    result: { sessionId: 1, target: "fixture", pid: 42, actions: [{ name: "entities" }] },
  });
  expect(await control.handle({ id: "analyze", op: "session.action", mode: "analysis", action: "entities", args: [] })).toMatchObject({
    ok: true,
    result: { status: "passed", action: "entities", result: { totalRows: 1 } },
  });
  expect(await control.handle({ id: "denied", op: "session.action", mode: "debug", action: "entities", args: [] })).toMatchObject({
    ok: false,
    error: { code: "policy-denied" },
    receipt: { status: "failed", action: "entities" },
  });
  expect(await control.handle({ id: "close", op: "session.close" })).toEqual({
    type: "response",
    id: "close",
    ok: true,
    result: { closed: true },
  });
});

test("a failed live describe closes the partially opened session", async () => {
  let closed = false;
  const broken = fixtureSession();
  broken.describe = async () => { throw new Error("descriptor unavailable"); };
  broken.close = async () => { closed = true; };
  const control = createControlService({
    dependencies: {
      projects: fixtureProjects(),
      launch: async () => broken,
    },
  });
  await control.handle({ id: "auth", op: "authorize", profile });
  expect(await control.handle({ id: "open", op: "session.open", launch: { kind: "target", target: "fixture" } })).toMatchObject({
    ok: false,
    error: { code: "operation-failed", message: "descriptor unavailable" },
  });
  expect(closed).toBe(true);
  expect(await control.handle({ id: "describe", op: "session.describe" })).toMatchObject({
    ok: false,
    error: { code: "session-required" },
  });
});

test("Control authorization rejects labels that imply bypass instead of an isolated test setup", async () => {
  const control = service();
  const unsafe = { ...profile, antiCheat: "bypassed" };
  expect(await control.handle({ id: "unsafe", op: "authorize", profile: unsafe })).toMatchObject({
    ok: false,
    error: { code: "authorization-denied", message: expect.stringContaining("bypass") },
  });
  expect(await control.handle({ id: "ping", op: "ping" })).toMatchObject({
    ok: true,
    result: { protocol: CONTROL_PROTOCOL },
  });
});

test("Control API turns one human-play trace into a persistent Record summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "flab-control-record-"));
  const recordings = new RecordingCoordinator(new AnalysisRecordStore({ root }));
  let activeRecordId: string | null = null;
  const live = fixtureSession();
  live.call = async (name, args) => {
    if (name === "recordPlan") return {
      query: args[0],
      module: null,
      candidates: [{ id: "jump", name: "Fixture!Jump", address: "0x1000", source: "export", module: "Fixture" }],
      matched: 1,
      truncated: false,
    };
    if (name === "recordStart") {
      activeRecordId = args[0] as string;
      return { ok: true, active: true, recordId: activeRecordId };
    }
    if (name === "recordStatus") return { ok: true, active: true, recordId: activeRecordId, emitted: 2, dropped: 0 };
    if (name === "recordStop") return { ok: true, active: false, recordId: activeRecordId, emitted: 2, dropped: 0 };
    return [];
  };
  const control = createControlService({
    recordings,
    dependencies: { projects: fixtureProjects(), launch: async () => live },
  });
  try {
    await control.handle({ id: "auth", op: "authorize", profile });
    await control.handle({ id: "open", op: "session.open", launch: { kind: "target", target: "fixture" } });
    const planned = await control.handle({ id: "plan", op: "record.plan", query: "jump", limit: 3 });
    expect(planned).toMatchObject({ ok: true, result: { candidates: [{ id: "jump", address: "0x1000" }] } });
    const probes = planned.ok ? (planned.result as { candidates: unknown[] }).candidates : [];
    const started = await control.handle({ id: "start", op: "record.start", label: "human jump", probes });
    expect(started).toMatchObject({ ok: true, result: { status: "active", label: "human jump" } });
    const recordId = started.ok ? (started.result as { id: string }).id : "";
    recordings.capture({
      type: "flab.record.event",
      schema: "flab.record.event.v1",
      recordId,
      sequence: 1,
      event: { phase: "enter", probeId: "jump", function: "Fixture!Jump", timestamp: 10, threadId: 1, args: ["0x1"] },
    });
    recordings.capture({
      type: "flab.record.event",
      schema: "flab.record.event.v1",
      recordId,
      sequence: 2,
      event: { phase: "leave", probeId: "jump", function: "Fixture!Jump", timestamp: 12, threadId: 1, durationMs: 2, returnValue: "0x0" },
    });
    expect(await control.handle({ id: "status", op: "record.status" })).toMatchObject({
      ok: true,
      result: { record: { id: recordId, eventCount: 2 }, agent: { emitted: 2 } },
    });
    expect(await control.handle({ id: "stop", op: "record.stop" })).toMatchObject({
      ok: true,
      result: { record: { id: recordId, status: "completed", eventCount: 2 } },
    });
    expect(await control.handle({ id: "summary", op: "record.summary", recordId })).toMatchObject({
      ok: true,
      result: { functions: [{ probeId: "jump", enters: 1, leaves: 1, durationMs: { average: 2 } }] },
    });
  } finally {
    await control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
