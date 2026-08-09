import { expect, test } from "bun:test";
import {
  ActionService,
  handleMachineRequest,
  machineCapabilities,
  parseMachineRequestLine,
  type GameSession,
  type RpcDescriptor,
} from "../src/core/index.js";

const descriptor: RpcDescriptor = {
  name: "rows",
  args: [{ name: "query", type: "string" }],
  capabilities: ["instrument", "analysis"],
  effect: "read",
  returns: "table",
};

const session: GameSession = {
  target: "fixture",
  process: "fixture",
  pid: 1,
  device: {
    id: "local",
    name: "Local System",
    type: "local",
    platform: "darwin",
    arch: "arm64",
    selector: { kind: "local" },
  },
  call: async (name, args) => name === "rows" ? [{ query: args[0] }] : null,
  eval: async () => null,
  rpcNames: () => ["rows"],
  describe: async () => [descriptor],
  close: async () => {},
};

test("machine request parsing is exact, bounded, and typed", () => {
  expect(parseMachineRequestLine('{"id":"a","op":"ping"}')).toEqual({
    ok: true,
    request: { id: "a", op: "ping" },
  });
  expect(parseMachineRequestLine('{"id":2,"op":"action","mode":"analysis","action":"rows","args":["x"],"offset":0}')).toEqual({
    ok: true,
    request: { id: 2, op: "action", mode: "analysis", action: "rows", args: ["x"], offset: 0 },
  });
  expect(parseMachineRequestLine("not-json")).toMatchObject({ ok: false, code: "invalid-json" });
  expect(parseMachineRequestLine('{"id":"a","op":"ping","extra":true}')).toMatchObject({ ok: false, code: "unknown-field" });
  expect(parseMachineRequestLine('{"id":"a","op":"action","mode":"instrument","action":"rows","args":[1]}')).toMatchObject({ ok: false, code: "invalid-args" });
});

test("machine actions use the same live authorization and normalized receipts as TUI", async () => {
  const actions = new ActionService();
  const response = await handleMachineRequest(session, actions, {
    id: "read-1",
    op: "action",
    mode: "analysis",
    action: "rows",
    args: ["fixture"],
  });
  expect(response).toMatchObject({
    type: "response",
    id: "read-1",
    ok: true,
    receipt: { status: "passed", action: "rows", result: { totalRows: 1 } },
  });
});

test("machine capabilities expose the complete managed lifecycle", () => {
  expect(machineCapabilities()).toMatchObject({
    protocol: "flab.ndjson.v1",
    globalControl: {
      acp: expect.stringContaining("flab acp"),
      mcp: expect.stringContaining("flab mcp"),
      scope: expect.stringContaining("Record-assisted"),
    },
    instrumentLifecycle: {
      create: expect.stringContaining("instrumentStart"),
      inspect: expect.stringContaining("instrumentStatus"),
      edit: expect.stringContaining("instrumentUpdate"),
      stop: expect.stringContaining("instrumentStopAll"),
      delete: expect.stringContaining("instrumentDelete"),
    },
    analysisRecord: { flow: expect.arrayContaining(["record.plan", "record.summary"]) },
  });
});
