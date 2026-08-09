// Opt-in real Frida integration test. It compiles and owns a tiny native
// process, then exercises the same SessionEngine + ActionService path as TUI.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ActionService, startLaunch, type ActionMode, type ActionReceipt, type GameSession } from "../src/core/index.js";
import { compileNativeFixture } from "./fixture-compiler.js";

interface FixtureInfo {
  pid: number;
  counter: string;
  frozen: string;
  watched: string;
  tick: string;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return output.split("\n", 1)[0] ?? "";
}

class LineReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async next(): Promise<string> {
    while (!this.buffer.includes("\n")) {
      const chunk = await this.reader.read();
      if (chunk.done) {
        const final = this.buffer;
        this.buffer = "";
        return final;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
    const newline = this.buffer.indexOf("\n");
    const line = this.buffer.slice(0, newline).replace(/\r$/, "");
    this.buffer = this.buffer.slice(newline + 1);
    return line;
  }
}

async function nextJson(reader: LineReader): Promise<Record<string, unknown>> {
  const line = await reader.next();
  const value = JSON.parse(line) as unknown;
  check(value !== null && typeof value === "object" && !Array.isArray(value), `machine emitted non-object JSON: ${line}`);
  return value as Record<string, unknown>;
}

function parsedSummary(receipt: ActionReceipt): Record<string, unknown> {
  check(receipt.status === "passed", `${receipt.action} failed: ${receipt.error?.message ?? receipt.result.summary}`);
  const parsed = JSON.parse(receipt.result.summary) as unknown;
  check(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `${receipt.action} returned no JSON object`);
  return parsed as Record<string, unknown>;
}

function instrumentId(receipt: ActionReceipt): string {
  const result = parsedSummary(receipt);
  const instrument = result.instrument;
  check(instrument !== null && typeof instrument === "object" && !Array.isArray(instrument), "instrument result missing");
  const id = (instrument as { id?: unknown }).id;
  check(typeof id === "string" && id.length > 0, "instrument id missing");
  return id;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const artifacts = join(root, "artifacts");
  const executable = join(artifacts, process.platform === "win32" ? "flab-runtime-target.exe" : "flab-runtime-target");
  mkdirSync(artifacts, { recursive: true });
  await compileNativeFixture(root, "tests/fixtures/runtime_target.c", executable);

  const fixture = Bun.spawn([executable], { cwd: root, stdout: "pipe", stderr: "pipe" });
  let session: GameSession | null = null;
  const logs: string[] = [];
  try {
    const info = JSON.parse(await readLine(fixture.stdout)) as FixtureInfo;
    check(Number.isSafeInteger(info.pid) && info.pid > 0, "fixture PID missing");
    check(info.counter.startsWith("0x") && info.frozen.startsWith("0x") && info.watched.startsWith("0x") && info.tick.startsWith("0x"), "fixture addresses missing");

    session = await startLaunch(
      { kind: "probe-attach-pid", pid: info.pid, display: "flab-runtime-target", device: { kind: "local" } },
      {
        onLog: (line) => logs.push(line),
        onError: (line) => logs.push(`ERROR ${line}`),
        onClose: (reason) => logs.push(`CLOSE ${reason}`),
      },
    );
    const descriptors = await session.describe();
    for (const required of ["engines", "modules", "exports", "peek", "instrumentStart", "instrumentList", "instrumentStatus", "instrumentUpdate", "instrumentStop", "instrumentDelete", "instrumentStopAll"]) {
      check(descriptors.some((descriptor) => descriptor.name === required), `descriptor ${required} missing`);
    }

    const actions = new ActionService();
    const invoke = (mode: ActionMode, action: string, rawArgs: string[] = []): Promise<ActionReceipt> =>
      actions.invoke(session!, { sessionId: 1, mode, action, rawArgs });

    check((await invoke("analysis", "engines")).status === "passed", "engine detection failed");
    check((await invoke("analysis", "modules", ["flab-runtime"])).result.totalRows >= 1, "fixture module not found");
    check((await invoke("analysis", "exports", ["flab_"])).result.totalRows >= 3, "fixture exports not found");
    check((await invoke("analysis", "peek", [info.counter, "u32"])).status === "passed", "fixture memory read failed");

    const traceId = instrumentId(await invoke("instrument", "instrumentStart", [
      "trace", info.tick, JSON.stringify({ label: "fixture tick", args: 1 }),
    ]));
    await Bun.sleep(40);
    const traceStatus = await invoke("analysis", "instrumentStatus", [traceId]);
    check(traceStatus.verification?.verified === true && (traceStatus.verification.fired ?? 0) > 0, "trace never fired");
    check((await invoke("instrument", "instrumentUpdate", [traceId, JSON.stringify({ label: "fixture tick edited", args: 0 })])).status === "passed", "trace update failed");
    check((await invoke("instrument", "instrumentStop", [traceId])).status === "passed", "trace stop failed");
    check((await invoke("instrument", "instrumentDelete", [traceId])).status === "passed", "trace delete failed");

    const freezeId = instrumentId(await invoke("instrument", "instrumentStart", [
      "freeze", info.frozen, JSON.stringify({ label: "fixture value", type: "u32", value: 123, intervalMs: 2 }),
    ]));
    await Bun.sleep(30);
    check((await invoke("analysis", "peek", [info.frozen, "u32"])).result.summary === "123", "freeze did not write 123");
    check((await invoke("instrument", "instrumentUpdate", [freezeId, JSON.stringify({ value: 321 })])).status === "passed", "freeze update failed");
    await Bun.sleep(30);
    check((await invoke("analysis", "peek", [info.frozen, "u32"])).result.summary === "321", "updated freeze did not write 321");
    check((await invoke("instrument", "instrumentStop", [freezeId])).status === "passed", "freeze stop failed");
    check((await invoke("instrument", "poke", [info.frozen, "7", "u32"])).status === "passed", "fixture value restore failed");
    check((await invoke("instrument", "instrumentDelete", [freezeId])).status === "passed", "freeze delete failed");

    let watchOutcome: "verified" | "unverified" | "unsupported" = "unsupported";
    const watchStart = await invoke("instrument", "instrumentStart", [
      "watch", info.watched, JSON.stringify({ label: "fixture watched", type: "u32" }),
    ]);
    if (watchStart.status === "passed") {
      const watchId = instrumentId(watchStart);
      await Bun.sleep(process.platform === "win32" ? 1_500 : 350);
      const watchStatus = await invoke("analysis", "instrumentStatus", [watchId]);
      watchOutcome = watchStatus.verification?.verified ? "verified" : "unverified";
      check((await invoke("instrument", "instrumentStop", [watchId])).status === "passed", "watch stop failed");
      check((await invoke("instrument", "instrumentDelete", [watchId])).status === "passed", "watch delete failed");
    } else {
      check(watchStart.error?.code === "action-rejected", "unsupported watch did not fail explicitly");
    }

    const rejected = await invoke("instrument", "instrumentStart", ["freeze", info.frozen, JSON.stringify({ type: "u32" })]);
    check(rejected.status === "failed" && rejected.error?.code === "action-rejected", "invalid instrument was not rejected");

    const closeCleanupId = instrumentId(await invoke("instrument", "instrumentStart", [
      "freeze", info.counter, JSON.stringify({ label: "detach cleanup", type: "u32", value: 9999, intervalMs: 1 }),
    ]));
    check(closeCleanupId.length > 0, "cleanup instrument missing");
    await Bun.sleep(20);
    await session.close();
    session = null;
    await Bun.sleep(20);

    // Reattach proves the owned fixture survived detach and its counter is no
    // longer frozen by the previous script.
    session = await startLaunch(
      { kind: "probe-attach-pid", pid: info.pid, display: "flab-runtime-target", device: { kind: "local" } },
      { onLog: (line) => logs.push(line), onError: (line) => logs.push(`ERROR ${line}`), onClose: () => {} },
    );
    const counterAfterDetach = Number(await session.call("peek", [info.counter, "u32"]));
    check(counterAfterDetach > 9999, `detach cleanup left counter frozen (${counterAfterDetach})`);
    const empty = parsedSummary(await invoke("analysis", "instrumentList"));
    check(Array.isArray(empty.instruments) && empty.instruments.length === 0, "fresh agent inherited instrument state");
    await session.close();
    session = null;

    // Exercise the public AI-agent transport itself, not only the underlying
    // classes. Every stdout line must remain parseable NDJSON while diagnostics
    // are drained separately from stderr.
    const machine = Bun.spawn([
      "bun", "src/bin.ts", "probe", "--pid", String(info.pid), "--device", "local", "--session", "--json",
    ], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const machineReader = new LineReader(machine.stdout);
    const machineStderr = new Response(machine.stderr).text();
    const send = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
      machine.stdin.write(`${JSON.stringify(request)}\n`);
      await machine.stdin.flush();
      return nextJson(machineReader);
    };

    const ready = await nextJson(machineReader);
    const readyDevice = ready.device as { id?: unknown; type?: unknown } | undefined;
    check(
      ready.type === "ready" && ready.protocol === "flab.ndjson.v1" && ready.pid === info.pid &&
      readyDevice?.id === "local" && readyDevice.type === "local",
      "machine ready envelope invalid",
    );
    check((await send({ id: "ping", op: "ping" })).ok === true, "machine ping failed");
    check((await send({ id: "modules", op: "action", mode: "analysis", action: "modules", args: ["flab-runtime"] })).ok === true, "machine analysis failed");
    const machineStart = await send({
      id: "start",
      op: "action",
      mode: "instrument",
      action: "instrumentStart",
      args: ["trace", info.tick, JSON.stringify({ label: "machine tick", args: 0 })],
    });
    check(machineStart.ok === true && machineStart.receipt && typeof machineStart.receipt === "object", "machine trace start failed");
    const machineStartReceipt = machineStart.receipt as { result?: { summary?: string } };
    const machineStartResult = JSON.parse(machineStartReceipt.result?.summary ?? "null") as { instrument?: { id?: string } };
    const machineInstrumentId = machineStartResult.instrument?.id;
    check(typeof machineInstrumentId === "string", "machine instrument id missing");
    await Bun.sleep(40);
    const machineStatus = await send({ id: "status", op: "action", mode: "analysis", action: "instrumentStatus", args: [machineInstrumentId] });
    const statusReceipt = machineStatus.receipt as { verification?: { verified?: boolean; fired?: number } } | undefined;
    check(machineStatus.ok === true && statusReceipt?.verification?.verified === true && (statusReceipt.verification.fired ?? 0) > 0, "machine trace did not verify");
    check((await send({ id: "update", op: "action", mode: "instrument", action: "instrumentUpdate", args: [machineInstrumentId, JSON.stringify({ label: "machine edited", args: 1 })] })).ok === true, "machine update failed");
    check((await send({ id: "stop", op: "action", mode: "instrument", action: "instrumentStop", args: [machineInstrumentId] })).ok === true, "machine stop failed");
    check((await send({ id: "delete", op: "action", mode: "instrument", action: "instrumentDelete", args: [machineInstrumentId] })).ok === true, "machine delete failed");
    check((await send({ id: "close", op: "close" })).ok === true, "machine close failed");
    machine.stdin.end();
    check(await machine.exited === 0, `machine session exited nonzero: ${await machineStderr}`);

    // Exercise the global authoring/control transport against the same owned
    // fixture. This proves flab.control.v1 can open and drive a live session;
    // unit tests cover its workspace mutation and packaging services.
    const control = Bun.spawn(
      ["bun", "src/bin.ts", "agent", "--json"],
      { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const controlReader = new LineReader(control.stdout);
    const controlStderr = new Response(control.stderr).text();
    const controlSend = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
      control.stdin.write(`${JSON.stringify(request)}\n`);
      await control.stdin.flush();
      for (;;) {
        const envelope = await nextJson(controlReader);
        if (envelope.type === "response" && envelope.id === request.id) return envelope;
        check(envelope.type === "event", `unexpected control envelope: ${JSON.stringify(envelope)}`);
      }
    };
    const controlReady = await nextJson(controlReader);
    check(controlReady.type === "ready" && controlReady.protocol === "flab.control.v1", "control ready envelope invalid");
    check((await controlSend({
      id: "authorize",
      op: "authorize",
      profile: {
        purpose: "qa",
        objective: "Exercise the global Agent Control API against the owned native fixture",
        environment: "owned-offline",
        ownership: { clientOwned: true, operatorApproved: true },
        isolation: {
          publicMatchmaking: false,
          publicLeaderboard: false,
          productionEconomy: false,
          thirdPartyAccounts: false,
        },
        antiCheat: "absent",
      },
    })).ok === true, "control authorization failed");
    check((await controlSend({ id: "verify", op: "verify.static" })).ok === true, "control static verification failed");
    const controlOpen = await controlSend({
      id: "open",
      op: "session.open",
      launch: { kind: "probe-attach-pid", pid: info.pid, display: "flab-runtime-target", device: { kind: "local" } },
    });
    const controlOpenResult = controlOpen.result as { pid?: unknown; device?: { id?: unknown } } | undefined;
    check(
      controlOpen.ok === true && controlOpenResult?.pid === info.pid && controlOpenResult.device?.id === "local",
      `control live open failed: ${JSON.stringify(controlOpen)}`,
    );
    check((await controlSend({ id: "analyze", op: "session.action", mode: "analysis", action: "modules", args: ["flab-runtime"] })).ok === true, "control analysis failed");
    const controlRecordStart = await controlSend({
      id: "record-start",
      op: "record.start",
      label: "runtime fixture human-play loop",
      probes: [{ id: "tick", name: "flab_tick", address: info.tick, args: 1, captureReturn: true }],
      options: { maxEvents: 1_000, perProbeLimit: 500, sampleEvery: 1, maxDurationMs: 30_000 },
    });
    const controlRecordMetadata = controlRecordStart.result as { id?: unknown } | undefined;
    const controlRecordId = controlRecordMetadata?.id;
    check(controlRecordStart.ok === true && typeof controlRecordId === "string", `control Record start failed: ${JSON.stringify(controlRecordStart)}`);
    await Bun.sleep(40);
    const controlRecordStatus = await controlSend({ id: "record-status", op: "record.status" });
    const controlRecordStatusValue = controlRecordStatus.result as { record?: { eventCount?: unknown }; agent?: { emitted?: unknown } } | undefined;
    check(
      controlRecordStatus.ok === true && typeof controlRecordStatusValue?.record?.eventCount === "number" &&
      controlRecordStatusValue.record.eventCount > 0 && typeof controlRecordStatusValue.agent?.emitted === "number" &&
      controlRecordStatusValue.agent.emitted > 0,
      `control Record captured no calls: ${JSON.stringify(controlRecordStatus)}`,
    );
    const controlRecordStop = await controlSend({ id: "record-stop", op: "record.stop" });
    check(controlRecordStop.ok === true, `control Record stop failed: ${JSON.stringify(controlRecordStop)}`);
    const controlRecordSummary = await controlSend({ id: "record-summary", op: "record.summary", recordId: controlRecordId });
    const controlRecordSummaryValue = controlRecordSummary.result as { functions?: Array<{ probeId?: unknown; enters?: unknown; leaves?: unknown }> } | undefined;
    const tickSummary = controlRecordSummaryValue?.functions?.find((entry) => entry.probeId === "tick");
    check(
      controlRecordSummary.ok === true && typeof tickSummary?.enters === "number" && tickSummary.enters > 0 &&
      typeof tickSummary.leaves === "number" && tickSummary.leaves > 0,
      `control Record summary invalid: ${JSON.stringify(controlRecordSummary)}`,
    );
    const controlRecordRead = await controlSend({ id: "record-read", op: "record.read", recordId: controlRecordId, cursor: 0, limit: 3 });
    const controlRecordReadValue = controlRecordRead.result as { events?: unknown[] } | undefined;
    check(controlRecordRead.ok === true && (controlRecordReadValue?.events?.length ?? 0) > 0, "control Record paging failed");

    const limitedRecordStart = await controlSend({
      id: "record-limit-start",
      op: "record.start",
      label: "runtime fixture automatic event limit",
      probes: [{ id: "tick-limit", name: "flab_tick", address: info.tick, args: 1, captureReturn: true }],
      options: { maxEvents: 4, perProbeLimit: 100, sampleEvery: 1, maxDurationMs: 30_000 },
    });
    const limitedRecordId = (limitedRecordStart.result as { id?: unknown } | undefined)?.id;
    check(limitedRecordStart.ok === true && typeof limitedRecordId === "string", `limited Record start failed: ${JSON.stringify(limitedRecordStart)}`);
    let limitedCompleted: { id?: unknown; status?: unknown; reason?: unknown; eventCount?: unknown } | null = null;
    for (let attempt = 0; attempt < 100 && !limitedCompleted; attempt++) {
      const status = await controlSend({ id: `record-limit-status-${attempt}`, op: "record.status" });
      const completed = (status.result as { completed?: typeof limitedCompleted } | undefined)?.completed;
      if (completed?.id === limitedRecordId) limitedCompleted = completed;
      else await Bun.sleep(10);
    }
    check(
      limitedCompleted?.status === "completed" && limitedCompleted.reason === "event-limit" && limitedCompleted.eventCount === 4,
      `Record event limit did not finalize cleanly: ${JSON.stringify(limitedCompleted)}`,
    );
    const controlStart = await controlSend({
      id: "trace",
      op: "session.action",
      mode: "instrument",
      action: "instrumentStart",
      args: ["trace", info.tick, JSON.stringify({ label: "control tick", args: 0 })],
    });
    const controlStartReceipt = controlStart.result as { result?: { summary?: string } } | undefined;
    const controlStartValue = JSON.parse(controlStartReceipt?.result?.summary ?? "null") as { instrument?: { id?: string } };
    const controlInstrumentId = controlStartValue.instrument?.id;
    check(controlStart.ok === true && typeof controlInstrumentId === "string", "control trace start failed");
    await Bun.sleep(40);
    const controlStatus = await controlSend({ id: "status", op: "session.action", mode: "analysis", action: "instrumentStatus", args: [controlInstrumentId] });
    const controlStatusReceipt = controlStatus.result as { verification?: { verified?: boolean; fired?: number } } | undefined;
    check(controlStatus.ok === true && controlStatusReceipt?.verification?.verified === true && (controlStatusReceipt.verification.fired ?? 0) > 0, "control trace did not verify");
    check((await controlSend({ id: "stop", op: "session.action", mode: "instrument", action: "instrumentStop", args: [controlInstrumentId] })).ok === true, "control stop failed");
    check((await controlSend({ id: "delete", op: "session.action", mode: "instrument", action: "instrumentDelete", args: [controlInstrumentId] })).ok === true, "control delete failed");
    check((await controlSend({ id: "session-close", op: "session.close" })).ok === true, "control session close failed");
    check((await controlSend({ id: "close", op: "close" })).ok === true, "control close failed");
    control.stdin.end();
    check(await control.exited === 0, `control session exited nonzero: ${await controlStderr}`);
    rmSync(join(root, "artifacts", "records", `${controlRecordId}.json`), { force: true });
    rmSync(join(root, "artifacts", "records", `${controlRecordId}.jsonl`), { force: true });
    rmSync(join(root, "artifacts", "records", `${limitedRecordId}.json`), { force: true });
    rmSync(join(root, "artifacts", "records", `${limitedRecordId}.jsonl`), { force: true });

    console.log(JSON.stringify({
      ok: true,
      pid: info.pid,
      checks: [
        "attach", "describe", "engine-detect", "module-analysis", "export-analysis", "memory-read",
        "trace-create", "trace-fired", "trace-update", "trace-stop", "trace-delete",
        "freeze-create", "freeze-write", "freeze-update", "freeze-stop", "freeze-delete",
        "invalid-config-rejected", "detach-cleanup", "reattach",
        "machine-ready", "machine-analysis", "machine-create", "machine-status", "machine-update", "machine-stop", "machine-delete", "machine-close",
        "control-ready", "control-authorize", "control-verify", "control-open", "control-analysis",
        "record-start", "record-live-events", "record-stop", "record-summary", "record-page", "record-event-limit",
        "control-create", "control-status", "control-stop", "control-delete", "control-session-close", "control-close",
      ],
      logLines: logs.length,
      watch: watchOutcome,
    }));
  } finally {
    if (session) await session.close().catch(() => {});
    fixture.kill("SIGTERM");
    await fixture.exited;
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
