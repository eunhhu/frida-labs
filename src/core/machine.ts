import {
  ActionService,
  type ActionMode,
  type ActionReceipt,
} from "./actions.js";
import type { GameSession, RpcDescriptor } from "./session.js";

export const MACHINE_PROTOCOL = "flab.ndjson.v1";
export const MACHINE_LINE_MAX_BYTES = 64 * 1024;

export type MachineRequest =
  | { id: string | number; op: "ping" }
  | { id: string | number; op: "describe" }
  | { id: string | number; op: "action"; mode: ActionMode; action: string; args: string[]; offset?: number }
  | { id: string | number; op: "close" };

export type MachineResponse =
  | { type: "response"; id: string | number; ok: true; result: { protocol: string } | RpcDescriptor[] | { closed: true } }
  | { type: "response"; id: string | number; ok: boolean; receipt: ActionReceipt }
  | { type: "response"; id: string | number | null; ok: false; error: { code: string; message: string } };

type ParseResult = { ok: true; request: MachineRequest } | { ok: false; id: string | number | null; code: string; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestId(value: unknown): string | number | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(value).find((key) => !allowed.includes(key)) ?? null;
}

export function parseMachineRequestLine(line: string): ParseResult {
  if (new TextEncoder().encode(line).byteLength > MACHINE_LINE_MAX_BYTES) {
    return { ok: false, id: null, code: "line-too-large", message: `request line exceeds ${MACHINE_LINE_MAX_BYTES} bytes` };
  }
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { return { ok: false, id: null, code: "invalid-json", message: "request must be one JSON object per line" }; }
  if (!record(value)) return { ok: false, id: null, code: "invalid-request", message: "request must be a JSON object" };
  const id = requestId(value.id);
  if (id === null) return { ok: false, id: null, code: "invalid-id", message: "id must be a non-empty string or safe integer" };

  if (value.op === "ping" || value.op === "describe" || value.op === "close") {
    const unknown = exactKeys(value, ["id", "op"]);
    if (unknown) return { ok: false, id, code: "unknown-field", message: `unsupported request field ${JSON.stringify(unknown)}` };
    return { ok: true, request: { id, op: value.op } };
  }
  if (value.op !== "action") return { ok: false, id, code: "unknown-operation", message: "op must be ping, describe, action, or close" };

  const unknown = exactKeys(value, ["id", "op", "mode", "action", "args", "offset"]);
  if (unknown) return { ok: false, id, code: "unknown-field", message: `unsupported request field ${JSON.stringify(unknown)}` };
  if (value.mode !== "instrument" && value.mode !== "debug" && value.mode !== "analysis") {
    return { ok: false, id, code: "invalid-mode", message: "mode must be instrument, debug, or analysis" };
  }
  if (typeof value.action !== "string" || value.action.length === 0 || value.action.length > 256) {
    return { ok: false, id, code: "invalid-action", message: "action must be a non-empty string up to 256 characters" };
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    return { ok: false, id, code: "invalid-args", message: "args must be an array of raw strings" };
  }
  if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0)) {
    return { ok: false, id, code: "invalid-offset", message: "offset must be a nonnegative safe integer" };
  }
  return {
    ok: true,
    request: {
      id,
      op: "action",
      mode: value.mode,
      action: value.action,
      args: value.args as string[],
      ...(value.offset === undefined ? {} : { offset: value.offset as number }),
    },
  };
}

export async function handleMachineRequest(
  session: GameSession,
  actions: ActionService,
  request: Exclude<MachineRequest, { op: "close" }>,
): Promise<MachineResponse> {
  if (request.op === "ping") {
    return { type: "response", id: request.id, ok: true, result: { protocol: MACHINE_PROTOCOL } };
  }
  if (request.op === "describe") {
    try {
      return { type: "response", id: request.id, ok: true, result: await session.describe() };
    } catch (error) {
      return {
        type: "response",
        id: request.id,
        ok: false,
        error: { code: "describe-failed", message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  const receipt = await actions.invoke(session, {
    sessionId: 0,
    mode: request.mode,
    action: request.action,
    rawArgs: request.args,
    ...(request.offset === undefined ? {} : { offset: request.offset }),
  });
  return { type: "response", id: request.id, ok: receipt.status === "passed", receipt };
}

export function machineCapabilities(): Record<string, unknown> {
  return {
    protocol: MACHINE_PROTOCOL,
    transport: "newline-delimited JSON on stdin/stdout; diagnostics on stderr",
    launch: [
      "flab probe --pid <pid> --session --json",
      "flab probe <process> --device usb --session --json",
      "flab run <target> --device <device-id> --session --json",
      "flab run <target> --host <host:port> --session --json",
    ],
    devices: {
      discover: "flab devices --json",
      selectors: ["local", "usb", "remote", "<device-id>"],
      endpoint: "--host <host:port>",
      invariant: "process discovery, PID/name attach, spawn, reconnect, and ready identity use one selected device",
    },
    requests: {
      ping: { id: "request-id", op: "ping" },
      describe: { id: "request-id", op: "describe" },
      action: { id: "request-id", op: "action", mode: "analysis|instrument|debug", action: "descriptor name", args: ["raw", "strings"], offset: 0 },
      close: { id: "request-id", op: "close" },
    },
    instrumentLifecycle: {
      create: "instrumentStart(kind, address, options?)",
      inspect: "instrumentList(state?) / instrumentStatus(id)",
      edit: "instrumentUpdate(id, patch)",
      stop: "instrumentStop(id) / instrumentStopAll()",
      delete: "instrumentDelete(id)",
      kinds: {
        trace: { args: 0, backtrace: false, log: false, label: "trace" },
        watch: { type: "u32", label: "watch" },
        freeze: { type: "u32", value: 100, intervalMs: 10, label: "freeze" },
      },
    },
  };
}
