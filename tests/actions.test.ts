import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { targetTemplate } from "../src/core/projects.js";
import {
  ActionService,
  DEBUG_EVENT_MAX_BYTES,
  DEBUG_EVENTS_MAX,
  DEBUG_EVENTS_MAX_BYTES,
  RECEIPTS_MAX,
  RECEIPTS_MAX_BYTES,
  RESULT_PAGE_MAX_BYTES,
  RESULT_ROW_MAX_BYTES,
  RESULT_ROWS_MAX,
  RESULT_SUMMARY_MAX_BYTES,
  VERIFICATION_DETAIL_MAX_BYTES,
  authorizeAction,
  coerceActionArgs,
  invokeAction,
  normalizeResultPage,
  normalizeRpcDescriptors,
  normalizeVerification,
  serializedUtf8Bytes,
  stableSerialize,
  utf8ByteLength,
  type ActionReceipt,
  type ActionSession,
  type CanonicalRpcDescriptor,
  type DebugEventInput,
} from "../src/core/actions.js";

function session(
  describe: () => unknown | Promise<unknown>,
  call: (name: string, args: unknown[]) => unknown | Promise<unknown> = () => null,
): ActionSession {
  return {
    describe: async () => await describe() as never,
    call: async (name, args) => await call(name, args),
  };
}

function explicit(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    capabilities: ["instrument"],
    effect: "control",
    returns: "json",
    ...overrides,
  };
}

function retainedReceipt(action: string, result: unknown): ActionReceipt {
  return {
    sessionId: 1,
    action,
    mode: "instrument",
    status: "passed",
    startedAt: 1,
    completedAt: 2,
    result: normalizeResultPage(result),
    warnings: [],
  };
}

test("descriptor normalization is additive for legacy metadata and fail-closed for malformed metadata", () => {
  const normalized = normalizeRpcDescriptors([
    { name: "legacy", args: [{ name: "exact", type: "string?", optional: false }] },
    { name: "legacyUnknown", args: [{ name: "options", type: "object" }] },
    explicit("status", { label: "Live status", category: "System", capabilities: ["analysis", "instrument"], effect: "read" }),
    explicit("install", { capabilities: ["instrument", "debug"], effect: "hook", returns: "verification", statusAction: "status" }),
    explicit("controls", { args: [
      { name: "enabled", type: "boolean", ui: { control: "checkbox", label: "Enabled" } },
      { name: "speed", type: "number", ui: { control: "slider", min: 0.25, max: 3, step: 0.25, default: 1 } },
      { name: "profile", type: "string", ui: { control: "select", options: [{ label: "Safe", value: "safe" }, { label: "Fast", value: "fast" }] } },
    ] }),
    explicit("badUi", { args: [{ name: "enabled", type: "boolean", ui: { control: "slider", min: 0, max: 1, step: 1 } }] }),
    explicit("badStatus", { statusAction: "missing" }),
    explicit("partial", { returns: undefined }),
    explicit("badCapability", { capabilities: ["instrument", "root"] }),
    explicit("badEffect", { effect: "execute" }),
    explicit("badReturn", { returns: "stream" }),
    explicit("badLabel", { label: "" }),
    explicit("badCategory", { category: 7 }),
    explicit("badArgs", { args: [{ name: "maybe", type: "string?" }, { name: "required", type: "string" }] }),
    explicit("duplicate"),
    explicit("duplicate", { effect: "read" }),
    { name: "__describe", doc: "internal" },
    null,
  ]);

  expect(normalized.descriptors.map((descriptor) => descriptor.name)).toEqual([
    "legacy",
    "legacyUnknown",
    "status",
    "install",
    "controls",
  ]);
  expect(normalized.descriptors[0]).toMatchObject({
    capabilities: ["instrument"],
    effect: "control",
    returns: "json",
    args: [{ name: "exact", type: "string", optional: false }],
  });
  expect(normalized.descriptors[1]).toMatchObject({
    capabilities: ["instrument"],
    args: [{ name: "options", type: "string", optional: false }],
  });
  expect(normalized.descriptors.find((descriptor) => descriptor.name === "install")?.statusAction).toBe("status");
  expect(normalized.descriptors.find((descriptor) => descriptor.name === "status")).toMatchObject({
    label: "Live status",
    category: "System",
  });
  expect(normalized.descriptors.find((descriptor) => descriptor.name === "controls")?.args).toMatchObject([
    { ui: { control: "checkbox", label: "Enabled" } },
    { ui: { control: "slider", min: 0.25, max: 3, step: 0.25, default: 1 } },
    { ui: { control: "select", default: "safe", options: [{ label: "Safe", value: "safe" }, { label: "Fast", value: "fast" }] } },
  ]);
  expect(normalized.warnings.length).toBeGreaterThanOrEqual(8);
  expect(normalized.warnings.join("\n")).toContain("unknown type");
  expect(normalized.warnings.join("\n")).toContain("Duplicate descriptor");
  expect(normalized.warnings.join("\n")).toContain("invalid status action");
});

test("normalization drops all duplicates and status links whose targets are not explicit Analysis reads", () => {
  const normalized = normalizeRpcDescriptors([
    explicit("writeStatus", { capabilities: ["analysis"], effect: "write" }),
    explicit("nonAnalysisStatus", { capabilities: ["instrument"], effect: "read" }),
    explicit("badWriteLink", { statusAction: "writeStatus" }),
    explicit("badCapabilityLink", { statusAction: "nonAnalysisStatus" }),
    explicit("dupe"),
    explicit("dupe"),
  ]);

  expect(normalized.descriptors.map((descriptor) => descriptor.name)).toEqual(["writeStatus", "nonAnalysisStatus"]);
  expect(normalized.descriptors.some((descriptor) => descriptor.name === "dupe")).toBe(false);
});

test("invokeAction ignores a forged cached descriptor and re-authorizes the changed live surface", async () => {
  const cached = [explicit("read", { capabilities: ["analysis"], effect: "read" })];
  const changed = [explicit("read", { capabilities: ["analysis"], effect: "control" })];
  let describeCalls = 0;
  let callCount = 0;
  const target = session(
    () => ++describeCalls === 1 ? cached : changed,
    () => { callCount++; return "should not run"; },
  );

  await target.describe();
  const receipt = await invokeAction(target, {
    mode: "analysis",
    sessionId: 7,
    action: "read",
    rawArgs: [],
    offset: 200,
  }, { now: () => 10 });

  expect(describeCalls).toBe(2);
  expect(callCount).toBe(0);
  expect(receipt.status).toBe("failed");
  expect(receipt.error?.code).toBe("policy-denied");
});

test("invokeAction reports missing, throwing, and non-array live descriptor failures without invoking stale actions", async () => {
  let callCount = 0;
  const failures = [
    'agent does not expose the required rpc export "__describe"',
    'rpc export "__describe" threw: agent exploded',
    'rpc export "__describe" returned a non-array descriptor inventory',
  ];

  for (const failure of failures) {
    const receipt = await invokeAction(
      session(
        () => { throw new Error(failure); },
        () => { callCount++; return "stale"; },
      ),
      { mode: "analysis", sessionId: 7, action: "read", rawArgs: [], offset: 200 },
      { now: () => 11 },
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.error?.code).toBe("describe-failed");
    expect(receipt.error?.message).toContain(failure);
  }
  expect(callCount).toBe(0);
});

test("strict coercion, arity, mode policies, canonical call name, and status links are enforced", async () => {
  const descriptors = [
    explicit("typed", {
      capabilities: ["instrument", "analysis"],
      effect: "read",
      args: [
        { name: "text", type: "string" },
        { name: "number", type: "number" },
        { name: "integer", type: "integer" },
        { name: "boolean", type: "boolean" },
        { name: "json", type: "json" },
        { name: "address", type: "address" },
        { name: "pattern", type: "pattern" },
        { name: "optional", type: "string?" },
      ],
    }),
    explicit("status", { capabilities: ["analysis", "instrument"], effect: "read" }),
    explicit("hook", {
      capabilities: ["instrument", "debug"],
      effect: "hook",
      returns: "verification",
      statusAction: "status",
    }),
    explicit("debugWrite", { capabilities: ["debug"], effect: "write" }),
    explicit("analysisControl", { capabilities: ["analysis"], effect: "control" }),
    { name: "legacy" },
  ];
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const target = session(
    () => descriptors,
    (name, args) => {
      calls.push({ name, args });
      return name === "hook" ? { fired: 0, fake: true } : { ok: true };
    },
  );

  const passed = await invokeAction(target, {
    mode: "analysis",
    sessionId: 1,
    action: "typed",
    rawArgs: [" exact ", "1.5", "2", "false", "{\"z\":1}", "0xBEEF", "13 37 ?? ff"],
  });
  expect(passed.status).toBe("passed");
  expect(calls[0]).toEqual({
    name: "typed",
    args: [" exact ", 1.5, 2, false, { z: 1 }, "0xBEEF", "13 37 ?? ff"],
  });

  const arity = await invokeAction(target, { mode: "instrument", sessionId: 1, action: "typed", rawArgs: [] });
  expect(arity.error?.code).toBe("arity");
  const badBoolean = await invokeAction(target, {
    mode: "instrument",
    sessionId: 1,
    action: "typed",
    rawArgs: ["x", "1", "2", "TRUE", "null", "0x1", "??"],
  });
  expect(badBoolean.error?.code).toBe("argument");

  const analysisDenied = await invokeAction(target, { mode: "analysis", sessionId: 1, action: "analysisControl", rawArgs: [] });
  const debugDenied = await invokeAction(target, { mode: "debug", sessionId: 1, action: "debugWrite", rawArgs: [] });
  expect(analysisDenied.error?.code).toBe("policy-denied");
  expect(debugDenied.error?.code).toBe("policy-denied");

  const legacy = await invokeAction(target, { mode: "instrument", sessionId: 1, action: "legacy", rawArgs: [] });
  expect(legacy.status).toBe("passed");
  const hook = await invokeAction(target, { mode: "debug", sessionId: 1, action: "hook", rawArgs: [] });
  expect(hook.status).toBe("passed");
  expect(hook.statusAction).toBe("status");
  expect(hook.verification).toMatchObject({ state: "unverified", fired: 0, verified: false });
});

test("pure authorization and coercion helpers deny unsafe modes and strict invalid values", () => {
  const descriptor: CanonicalRpcDescriptor = {
    name: "write",
    args: [{ name: "n", type: "integer", optional: false, ui: { control: "input" } }],
    capabilities: ["instrument", "debug", "analysis"],
    effect: "write",
    returns: "scalar",
  };
  expect(authorizeAction([descriptor], "instrument", "write").ok).toBe(true);
  expect(authorizeAction([descriptor], "analysis", "write").ok).toBe(false);
  expect(authorizeAction([descriptor], "debug", "write").ok).toBe(false);
  expect(coerceActionArgs(descriptor, ["NaN"]).ok).toBe(false);
  expect(coerceActionArgs(descriptor, ["2.5"]).ok).toBe(false);
  expect(coerceActionArgs(descriptor, ["3"])).toEqual({ ok: true, args: [3] });
});

test("structured agent operation failures become failed receipts", async () => {
  const target = session(
    () => [explicit("stop")],
    () => ({ ok: false, error: { code: "stop-failed", message: "watchpoint still armed" } }),
  );
  const receipt = await invokeAction(target, {
    mode: "instrument",
    sessionId: 9,
    action: "stop",
    rawArgs: [],
  });
  expect(receipt).toMatchObject({ status: "failed", error: { code: "action-rejected" } });
  expect(receipt.error?.message).toContain("stop-failed");
});

test("result pages use stable keys and exact UTF-8 summary, row, page, and count budgets", () => {
  const stable = normalizeResultPage([{ z: 1, a: { y: 2, b: 3 } }]);
  expect(stable.rows[0]).toBe('{"a":{"b":3,"y":2},"z":1}');
  expect(stableSerialize({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');

  const multibyte = normalizeResultPage({
    summary: "界".repeat(10_000),
    rows: [{ text: "😀".repeat(20_000) }],
    totalRows: 1,
  });
  expect(utf8ByteLength(multibyte.summary)).toBeLessThanOrEqual(RESULT_SUMMARY_MAX_BYTES);
  expect(utf8ByteLength(multibyte.rows[0] ?? "")).toBeLessThanOrEqual(RESULT_ROW_MAX_BYTES);
  expect(serializedUtf8Bytes(multibyte)).toBeLessThanOrEqual(RESULT_PAGE_MAX_BYTES);
  expect(multibyte.truncated).toBe(true);

  const many = normalizeResultPage(Array.from({ length: 250 }, (_, index) => ({ index })));
  expect(many.rows).toHaveLength(RESULT_ROWS_MAX);
  expect(many.totalRows).toBe(250);
  expect(many.nextOffset).toBe(RESULT_ROWS_MAX);
  expect(many.truncated).toBe(true);
  expect(serializedUtf8Bytes(many)).toBeLessThanOrEqual(RESULT_PAGE_MAX_BYTES);

  const huge = normalizeResultPage(["é".repeat(100_000)]);
  expect(huge.totalRows).toBe(1);
  expect(huge.rows).toHaveLength(1);
  expect(utf8ByteLength(huge.rows[0]!)).toBeLessThanOrEqual(RESULT_ROW_MAX_BYTES);
  expect(huge.nextOffset).toBeUndefined();
  expect(huge.truncated).toBe(true);
});

test("Analysis read pages 0, 200, and 400 each live-authorize and re-invoke without retaining raw rows", async () => {
  const rows = Array.from({ length: 450 }, (_, index) => index);
  let describeCalls = 0;
  let callCount = 0;
  const target = session(
    () => {
      describeCalls++;
      return [explicit("paged", { capabilities: ["analysis"], effect: "read", returns: "table" })];
    },
    () => {
      callCount++;
      return rows;
    },
  );
  const service = new ActionService({ now: () => 20 });

  const pages = [];
  for (const offset of [0, 200, 400]) {
    const receipt = await service.invoke(target, {
      mode: "analysis",
      sessionId: 18,
      action: "paged",
      rawArgs: [],
      offset,
    });
    pages.push(receipt.result);
  }

  expect(describeCalls).toBe(3);
  expect(callCount).toBe(3);
  expect(pages.map((page) => page.rows[0])).toEqual(["0", "200", "400"]);
  expect(pages.map((page) => page.rows.length)).toEqual([200, 200, 50]);
  expect(pages.map((page) => page.nextOffset)).toEqual([200, 400, undefined]);
  expect(pages.every((page) => page.totalRows === 450)).toBe(true);
  expect(service.receiptHistory(18).receipts.map((receipt) => receipt.result.nextOffset))
    .toEqual([200, 400, undefined]);
});

test("offsets must be safe nonnegative integers and positive offsets are Analysis-read only", async () => {
  let describeCalls = 0;
  let callCount = 0;
  const target = session(
    () => {
      describeCalls++;
      return [explicit("read", {
        capabilities: ["instrument", "debug", "analysis"],
        effect: "read",
        returns: "table",
      })];
    },
    () => {
      callCount++;
      return Array.from({ length: 2 }, (_, index) => index);
    },
  );

  const invalidOffsets = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  for (const offset of invalidOffsets) {
    const receipt = await invokeAction(target, {
      mode: "analysis",
      sessionId: 19,
      action: "read",
      rawArgs: [],
      offset,
    });
    expect(receipt.error?.code).toBe("invalid-request");
  }
  const stringOffset = await invokeAction(target, {
    mode: "analysis",
    sessionId: 19,
    action: "read",
    rawArgs: [],
    offset: "1" as unknown as number,
  });
  expect(stringOffset.error?.code).toBe("invalid-request");
  expect(describeCalls).toBe(0);
  expect(callCount).toBe(0);

  const instrument = await invokeAction(target, {
    mode: "instrument",
    sessionId: 19,
    action: "read",
    rawArgs: [],
    offset: 1,
  });
  const debug = await invokeAction(target, {
    mode: "debug",
    sessionId: 19,
    action: "read",
    rawArgs: [],
    offset: 1,
  });
  expect(instrument.error?.code).toBe("policy-denied");
  expect(debug.error?.code).toBe("policy-denied");
  expect(callCount).toBe(0);

  const zero = await invokeAction(target, {
    mode: "instrument",
    sessionId: 19,
    action: "read",
    rawArgs: [],
    offset: 0,
  });
  expect(zero.status).toBe("passed");
  expect(callCount).toBe(1);
});

test("ActionService exposes one running receipt and replaces it with the completed receipt", async () => {
  let release!: (value: unknown) => void;
  const described = new Promise<unknown>((resolve) => { release = resolve; });
  const service = new ActionService({ now: () => 4 });
  const pending = service.invoke(
    session(() => described, () => "done"),
    { mode: "instrument", sessionId: 9, action: "work", rawArgs: [] },
  );

  expect(service.receiptHistory(9).receipts).toMatchObject([{ action: "work", status: "running" }]);
  release([{ name: "work" }]);
  const completed = await pending;

  expect(completed.status).toBe("passed");
  expect(service.receiptHistory(9).receipts).toHaveLength(1);
  expect(service.receiptHistory(9).receipts[0]?.status).toBe("passed");
});

test("removeSession invalidates completion racing both describe and call without resurrecting history", async () => {
  let releaseDescribe!: (value: unknown) => void;
  const pendingDescribe = new Promise<unknown>((resolve) => { releaseDescribe = resolve; });
  const describeService = new ActionService({ now: () => 30 });
  describeService.recordDebugEvent(21, { kind: "hook-receipt", summary: "before removal" });
  const describeInvocation = describeService.invoke(
    session(() => pendingDescribe, () => "late describe result"),
    { mode: "instrument", sessionId: 21, action: "work", rawArgs: [] },
  );

  describeService.removeSession(21);
  releaseDescribe([explicit("work")]);
  expect((await describeInvocation).status).toBe("passed");
  expect(describeService.receiptHistory(21).receipts).toEqual([]);
  expect(describeService.debugHistory(21).events).toEqual([]);

  let releaseCall!: (value: unknown) => void;
  let markCallStarted!: () => void;
  const pendingCall = new Promise<unknown>((resolve) => { releaseCall = resolve; });
  const callStarted = new Promise<void>((resolve) => { markCallStarted = resolve; });
  const callService = new ActionService({ now: () => 31 });
  callService.recordDebugEvent(22, { kind: "hook-receipt", summary: "before removal" });
  const callInvocation = callService.invoke(
    session(
      () => [explicit("work")],
      () => {
        markCallStarted();
        return pendingCall;
      },
    ),
    { mode: "instrument", sessionId: 22, action: "work", rawArgs: [] },
  );

  await callStarted;
  callService.removeSession(22);
  callService.recordDebugEvent(22, { kind: "hook-receipt", summary: "replacement session" });
  const replacement = await callService.invoke(
    session(() => [explicit("fresh")], () => "fresh result"),
    { mode: "instrument", sessionId: 22, action: "fresh", rawArgs: [] },
  );
  releaseCall("late call result");
  expect(replacement.status).toBe("passed");
  expect((await callInvocation).status).toBe("passed");
  expect(callService.receiptHistory(22).receipts).toMatchObject([{ action: "fresh", status: "passed" }]);
  expect(callService.debugHistory(22).events).toMatchObject([{ summary: "replacement session" }]);
});

test("receipt history evicts FIFO by count and exact serialized byte budget", () => {
  const countService = new ActionService({ now: () => 1 });
  for (let index = 0; index <= RECEIPTS_MAX; index++) {
    countService.recordReceipt(1, retainedReceipt(`count-${index}`, index));
  }
  const countHistory = countService.receiptHistory(1);
  expect(countHistory.receipts).toHaveLength(RECEIPTS_MAX);
  expect(countHistory.receipts[0]?.action).toBe("count-1");
  expect(countHistory.droppedReceipts).toBe(1);
  expect(countHistory.bytes).toBe(serializedUtf8Bytes(countHistory.receipts));

  const byteService = new ActionService({ now: () => 1 });
  const largeResult = Array.from({ length: 20 }, (_, index) => ({ index, text: "x".repeat(4_000) }));
  for (let index = 0; index < 80; index++) {
    byteService.recordReceipt(2, retainedReceipt(`byte-${index}`, largeResult));
  }
  const byteHistory = byteService.receiptHistory(2);
  expect(byteHistory.bytes).toBeLessThanOrEqual(RECEIPTS_MAX_BYTES);
  expect(byteHistory.bytes).toBe(serializedUtf8Bytes(byteHistory.receipts));
  expect(byteHistory.droppedReceipts).toBeGreaterThan(0);
  expect(byteHistory.receipts[0]?.action).not.toBe("byte-0");

  const rejected = byteService.recordReceipt(3, {
    ...retainedReceipt("oversized", null),
    action: "x".repeat(RECEIPTS_MAX_BYTES),
  });
  expect(rejected.status).toBe("failed");
  expect(rejected.error?.code).toBe("retention-limit");
  expect(serializedUtf8Bytes(rejected)).toBeLessThan(RECEIPTS_MAX_BYTES);
});

test("debug history normalizes near-limit reports and evicts FIFO by count and byte budget", () => {
  const countService = new ActionService({ now: () => 5 });
  for (let index = 0; index <= DEBUG_EVENTS_MAX; index++) {
    countService.recordDebugEvent(1, { kind: "child", summary: `event-${index}` });
  }
  const countHistory = countService.debugHistory(1);
  expect(countHistory.events).toHaveLength(DEBUG_EVENTS_MAX);
  expect(countHistory.events[0]?.summary).toBe("event-1");
  expect(countHistory.droppedDebugEvents).toBe(1);

  const byteService = new ActionService({ now: () => 5 });
  const report = Array.from({ length: 20 }, (_, index) => ({ index, text: "界".repeat(1_300) }));
  for (let index = 0; index < 80; index++) {
    const input: DebugEventInput = {
      kind: "process-crash",
      summary: `crash-${index}`,
      detail: "d".repeat(32 * 1024),
      report,
    };
    const event = byteService.recordDebugEvent(2, input);
    expect(serializedUtf8Bytes(event)).toBeLessThanOrEqual(DEBUG_EVENT_MAX_BYTES);
    expect(event.report && serializedUtf8Bytes(event.report)).toBeLessThanOrEqual(RESULT_PAGE_MAX_BYTES);
  }
  const byteHistory = byteService.debugHistory(2);
  expect(byteHistory.bytes).toBeLessThanOrEqual(DEBUG_EVENTS_MAX_BYTES);
  expect(byteHistory.bytes).toBe(serializedUtf8Bytes(byteHistory.events));
  expect(byteHistory.droppedDebugEvents).toBeGreaterThan(0);
  expect(byteHistory.events[0]?.summary).not.toBe("crash-0");

  byteService.removeSession(2);
  expect(byteService.receiptHistory(2).droppedReceipts).toBe(0);
  expect(byteService.debugHistory(2)).toMatchObject({ events: [], bytes: 2, droppedDebugEvents: 0 });
});

test("verification precedence handles native, replace-demo, booleans, failures, zero, malformed fired, and conflicts", () => {
  const native = normalizeVerification({
    state: "verified",
    fired: 2,
    verified: true,
    detail: "界".repeat(10_000),
  });
  expect(native.verification).toMatchObject({ state: "verified", fired: 2, verified: true });
  expect(utf8ByteLength(native.verification?.detail ?? "")).toBeLessThanOrEqual(VERIFICATION_DETAIL_MAX_BYTES);

  expect(normalizeVerification({ fired: 3, fake: true }).verification).toEqual({
    state: "verified",
    fired: 3,
    verified: true,
  });
  expect(normalizeVerification({ verified: true }).verification).toEqual({
    state: "verified",
    fired: 0,
    verified: true,
  });
  expect(normalizeVerification({ failed: true, fired: 4 }).verification).toEqual({
    state: "failed",
    fired: 4,
    verified: false,
  });
  expect(normalizeVerification({ fired: 0 }).verification).toEqual({
    state: "unverified",
    fired: 0,
    verified: false,
  });
  expect(normalizeVerification({ fired: -1 }).verification).toEqual({
    state: "unverified",
    fired: 0,
    verified: false,
  });
  expect(normalizeVerification({ fired: Number.NaN }).verification).toEqual({
    state: "unverified",
    fired: 0,
    verified: false,
  });
  expect(normalizeVerification({ other: true }).verification).toBeUndefined();
  expect(normalizeVerification({ ok: true, instrument: { state: "active", fired: 5, verified: true } }).verification).toEqual({
    state: "verified",
    fired: 5,
    verified: true,
  });

  const conflict = normalizeVerification({ state: "unverified", fired: 9, verified: true, failed: true });
  expect(conflict.verification).toEqual({ state: "unverified", fired: 9, verified: false });
  expect(conflict.warnings).toHaveLength(1);
});

type DescriptorExpectation = {
  source: keyof typeof descriptorSources;
  name: string;
  capabilities: string[];
  effect: string;
  returns: string;
  statusAction?: string;
};

const descriptorSources = {
  probe: readFileSync(new URL("../agent/targets/_probe/index.ts", import.meta.url), "utf8"),
  adofai: readFileSync(new URL("../agent/targets/adofai/index.ts", import.meta.url), "utf8"),
  terraria: readFileSync(new URL("../agent/targets/terraria/index.ts", import.meta.url), "utf8"),
  piu: readFileSync(new URL("../agent/targets/piu/index.ts", import.meta.url), "utf8"),
  meccha: readFileSync(new URL("../agent/targets/mecchachameleon/index.ts", import.meta.url), "utf8"),
  scaffold: targetTemplate("snapshot"),
};

function entries(
  source: DescriptorExpectation["source"],
  capabilities: string[],
  effect: string,
  returns: string,
  names: string[],
): DescriptorExpectation[] {
  return names.map((name) => ({ source, name, capabilities, effect, returns }));
}

function recordingEntries(source: DescriptorExpectation["source"]): DescriptorExpectation[] {
  return [
    { source, name: "recordPlan", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
    { source, name: "recordStart", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "recordStatus" },
    { source, name: "recordStatus", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
    { source, name: "recordStop", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "recordStatus" },
  ];
}

function descriptorInventory(): DescriptorExpectation[] {
  const inventory: DescriptorExpectation[] = [];
  const descriptor = /\{ name: "([^"]+)".*?capabilities: \[([^\]]*)\], effect: "([^"]+)", returns: "([^"]+)"(?:, statusAction: "([^"]+)")? \}/g;
  for (const [source, text] of Object.entries(descriptorSources) as Array<
    [DescriptorExpectation["source"], string]
  >) {
    for (const line of text.split("\n")) {
      descriptor.lastIndex = 0;
      for (const match of line.matchAll(descriptor)) {
        inventory.push({
          source,
          name: match[1]!,
          capabilities: [...match[2]!.matchAll(/"([^"]+)"/g)].map((capability) => capability[1]!),
          effect: match[3]!,
          returns: match[4]!,
          ...(match[5] ? { statusAction: match[5] } : {}),
        });
      }
    }
    if (/(?:recording\.)?recordingDescriptors\(\)/.test(text)) inventory.push(...recordingEntries(source));
  }
  return inventory;
}

test("all target and scaffold descriptors match the approved capability/effect inventory", () => {
  const expectations: DescriptorExpectation[] = [
    ...entries("probe", ["instrument", "analysis"], "read", "table", ["engines", "modules", "exports", "imports", "symbols", "scan", "strings", "memoryDiff", "memorySnapshotList", "monoAssemblies", "monoClasses", "monoMethods", "cocosSymbols"]),
    ...entries("probe", ["instrument", "analysis"], "read", "hex", ["hexdump"]),
    ...entries("probe", ["instrument", "analysis"], "read", "scalar", ["peek"]),
    ...entries("probe", ["instrument", "analysis"], "read", "json", ["demoSym", "demoObjcGate", "demoJavaGate"]),
    { source: "probe", name: "memorySnapshot", capabilities: ["instrument", "analysis"], effect: "read", returns: "json", statusAction: "memorySnapshotList" },
    { source: "probe", name: "memorySnapshotDelete", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "memorySnapshotList" },
    ...recordingEntries("probe"),
    ...entries("probe", ["instrument"], "write", "scalar", ["poke", "freeze"]),
    ...entries("probe", ["instrument"], "control", "scalar", ["unfreeze", "detachAll"]),
    ...entries("probe", ["instrument"], "hook", "scalar", ["watch", "trace", "monoTrace"]),
    { source: "probe", name: "instrumentStart", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "instrumentStatus" },
    ...entries("probe", ["instrument", "analysis"], "read", "table", ["instrumentList"]),
    ...entries("probe", ["instrument", "analysis"], "read", "verification", ["instrumentStatus"]),
    { source: "probe", name: "instrumentUpdate", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "instrumentStatus" },
    { source: "probe", name: "instrumentStop", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "instrumentStatus" },
    ...entries("probe", ["instrument"], "control", "scalar", ["instrumentDelete"]),
    ...entries("probe", ["instrument"], "control", "table", ["instrumentStopAll"]),
    ...entries("probe", ["instrument", "debug"], "hook", "verification", ["demoStalker", "demoMam", "demoHookVerified", "demoReplace"]),
    ...entries("probe", ["debug"], "control", "json", ["demoExcrashInstall"]),
    ...entries("adofai", ["instrument", "analysis"], "read", "json", ["modInfo", "modState", "info", "classes"]),
    ...entries("adofai", ["instrument", "analysis"], "read", "table", ["assemblies", "methods", "fields"]),
    ...entries("adofai", ["instrument", "analysis"], "read", "scalar", ["address"]),
    ...entries("adofai", ["instrument", "analysis"], "read", "json", ["assistRead"]),
    { source: "adofai", name: "assistApply", capabilities: ["instrument"], effect: "write", returns: "verification", statusAction: "assistRead" },
    { source: "adofai", name: "assistEnforce", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "assistRead" },
    { source: "adofai", name: "assistReset", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "assistRead" },
    { source: "adofai", name: "trace", capabilities: ["instrument", "debug"], effect: "hook", returns: "verification", statusAction: "modState" },
    { source: "adofai", name: "resetAll", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    { source: "adofai", name: "dispose", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    ...recordingEntries("adofai"),
    ...entries("terraria", ["instrument", "analysis"], "read", "json", ["modInfo", "modState", "playerSnapshot"]),
    ...entries("terraria", ["instrument"], "control", "scalar", ["cmd"]),
    { source: "terraria", name: "set", capabilities: ["instrument"], effect: "control", returns: "scalar", statusAction: "modState" },
    { source: "terraria", name: "resetAll", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    { source: "terraria", name: "dispose", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    ...recordingEntries("terraria"),
    ...entries("piu", ["instrument", "analysis"], "read", "json", ["modInfo", "modState", "judgmentStats"]),
    { source: "piu", name: "toggle", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    { source: "piu", name: "resetAll", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    { source: "piu", name: "dispose", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    ...recordingEntries("piu"),
    ...entries("meccha", ["instrument", "analysis"], "read", "json", ["modInfo", "modState", "info", "espStatus", "moveRead", "moveStatus"]),
    ...entries("meccha", ["analysis"], "read", "json", ["moveProbe"]),
    ...entries("meccha", ["instrument", "analysis"], "read", "table", ["classes", "espSnapshot"]),
    { source: "meccha", name: "espInstall", capabilities: ["instrument", "debug"], effect: "hook", returns: "scalar", statusAction: "espStatus" },
    { source: "meccha", name: "espRemove", capabilities: ["instrument", "debug"], effect: "control", returns: "scalar", statusAction: "espStatus" },
    { source: "meccha", name: "espTest", capabilities: ["instrument", "debug"], effect: "control", returns: "scalar", statusAction: "espStatus" },
    { source: "meccha", name: "moveApply", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "moveStatus" },
    { source: "meccha", name: "moveEnforce", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "moveStatus" },
    { source: "meccha", name: "moveReset", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "moveStatus" },
    { source: "meccha", name: "resetAll", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    { source: "meccha", name: "dispose", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
    ...recordingEntries("meccha"),
    ...entries("scaffold", ["instrument", "analysis"], "read", "scalar", ["ping"]),
    ...recordingEntries("scaffold"),
  ];

  const actual = descriptorInventory();
  const bySourceAndName = (left: DescriptorExpectation, right: DescriptorExpectation): number =>
    `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`);
  expect(actual.sort(bySourceAndName)).toEqual(expectations.sort(bySourceAndName));
  expect(actual.filter((descriptor) => descriptor.statusAction !== undefined).every((descriptor) =>
    actual.some((candidate) =>
      candidate.source === descriptor.source &&
      candidate.name === descriptor.statusAction &&
      candidate.effect === "read")))
    .toBe(true);
  expect(actual.some((descriptor) => descriptor.name === "__describe")).toBe(false);

  expect(descriptorSources.probe).toContain('{ name: "pattern", type: "pattern" }');
  expect(descriptorSources.probe).toContain('{ name: "addr", type: "address" }');
  expect(descriptorSources.meccha).toContain('{ name: "opts", type: "json", ui: { control: "input"');
});
