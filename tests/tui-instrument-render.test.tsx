import { expect, test } from "bun:test";
import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import type { GameSession } from "../src/core/index.js";
import { InstrumentPanel } from "../src/tui/instrument.js";
import type { SessionState } from "../src/tui/store.js";
import { workbench } from "../src/tui/workbench.js";

class TerminalOutput extends Writable {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  text = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    done();
  }
}

function terminalInput(): NodeJS.ReadStream & { write(value: string): boolean } {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode(mode: boolean): typeof stream;
    ref(): typeof stream;
    unref(): typeof stream;
  };
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

function plain(value: string): string {
  return value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

test("Instrument panel renders real input, checkbox, slider, and select widgets", async () => {
  const session: SessionState = {
    id: 77,
    target: "fixture",
    process: "fixture",
    pid: 77,
    deviceLabel: "local",
    device: null,
    status: "live",
    detail: "fixture",
    logs: [],
    dropped: 0,
    receipts: [{
      sessionId: 77,
      action: "configure",
      mode: "instrument",
      status: "passed",
      startedAt: 1,
      completedAt: 2,
      result: { summary: "{\"ok\":true}", rows: [], totalRows: 0, truncated: false },
      warnings: [],
    }],
    droppedReceipts: 0,
    debugEvents: [],
    droppedDebugEvents: 0,
    frozen: false,
    describe: [{
      name: "configure",
      label: "Assist controls",
      category: "Assist",
      args: [
        { name: "query", type: "string", ui: { control: "input", label: "Target", placeholder: "player" } },
        { name: "enabled", type: "boolean", ui: { control: "checkbox", label: "Enabled" } },
        { name: "speed", type: "number", ui: { control: "slider", label: "Speed", min: 0.25, max: 3, step: 0.25, default: 1 } },
      ],
      capabilities: ["instrument"],
      effect: "control",
      returns: "json",
      statusAction: "status",
    }, {
      name: "profile",
      label: "Assist profile",
      category: "Assist",
      args: [
        { name: "value", type: "string", ui: { control: "select", label: "Profile", options: [{ label: "Safe", value: "safe" }, { label: "Fast", value: "fast" }] } },
      ],
      capabilities: ["instrument"],
      effect: "control",
      returns: "json",
      statusAction: "status",
    }, {
      name: "status",
      label: "Assist state",
      category: "System",
      capabilities: ["instrument", "analysis"],
      effect: "read",
      returns: "json",
    }],
    crashes: [],
    history: [],
    lastResult: null,
  };
  const stdout = new TerminalOutput();
  const stdin = terminalInput();
  const handle: GameSession = {
    target: "fixture",
    process: "fixture",
    pid: 77,
    device: {
      id: "local",
      name: "Local System",
      type: "local",
      platform: "darwin",
      arch: "arm64",
      selector: { kind: "local" },
    },
    call: async (name) => name === "status" ? { enabled: false, profile: "safe", speed: 1 } : { ok: true },
    eval: async () => undefined,
    rpcNames: () => ["configure", "profile", "status"],
    describe: async () => session.describe!,
    close: async () => {},
  };
  const internals = workbench as unknown as { handles: Map<number, GameSession> };
  internals.handles.set(session.id, handle);
  const instance = render(
    <InstrumentPanel session={session} focused onCaptureChange={() => {}} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin,
      debug: true,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  let firstFrame = "";
  let finalFrame = "";
  try {
    await instance.waitUntilRenderFlush();
    await Bun.sleep(60);
    await instance.waitUntilRenderFlush();
    const rendered = plain(stdout.text);
    const frames = rendered.split("Instrument dashboard");
    firstFrame = `Instrument dashboard${frames[frames.length - 1] ?? ""}`;
    stdin.write("\r");
    await Bun.sleep(40);
    stdin.write("player");
    await Bun.sleep(20);
    stdin.write("\r");
    await Bun.sleep(80);
    await instance.waitUntilRenderFlush();
    const renderedFinal = plain(stdout.text);
    const finalFrames = renderedFinal.split("Instrument dashboard");
    finalFrame = `Instrument dashboard${finalFrames[finalFrames.length - 1] ?? ""}`;
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    workbench.dropSession(session.id);
  }

  const output = plain(stdout.text);
  expect(firstFrame).toContain("Instrument dashboard");
  expect(firstFrame).toContain("Live status · s refresh");
  expect(firstFrame).toMatch(/Target\s+> player/);
  expect(firstFrame).toMatch(/Enabled\s+\[ \] off/);
  expect(firstFrame).toMatch(/Speed\s+◀/);
  expect(firstFrame).toMatch(/Assist profile\s+◀ Safe ▶/);
  expect(firstFrame.match(/\[(?:Assist|System)\]/g)?.length).toBe(3);
  expect(firstFrame.split("\n").length).toBeLessThanOrEqual(24);
  expect(output).toContain("status · 3 result field(s)");
  expect(output).toContain("enabled: false");
  expect(finalFrame).toContain("Last · PASSED · Assist controls");
  expect(finalFrame.split("\n").length).toBeLessThanOrEqual(24);
});
