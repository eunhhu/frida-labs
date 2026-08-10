import { expect, test } from "bun:test";

class LineReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async next(): Promise<Record<string, unknown>> {
    while (!this.buffer.includes("\n")) {
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error(`MCP stream closed before a response: ${this.buffer}`);
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
    const newline = this.buffer.indexOf("\n");
    const line = this.buffer.slice(0, newline).replace(/\r$/, "");
    this.buffer = this.buffer.slice(newline + 1);
    return JSON.parse(line) as Record<string, unknown>;
  }
}

test("flab MCP exposes two low-noise tools over a real stdio handshake", async () => {
  const child = Bun.spawn([process.execPath, "src/bin.ts", "mcp"], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = new LineReader(child.stdout);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "flab-test", version: "1.0.0" },
    },
  })}\n`);
  const initialized = await reader.next();
  expect(initialized).toMatchObject({
    id: 1,
    result: { serverInfo: { name: "flab-mcp", version: "1.0.0" }, capabilities: { tools: {}, resources: {}, prompts: {} } },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const tools = await reader.next();
  expect((tools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
    "flab_control",
    "flab_events",
  ]);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "flab_control", arguments: { op: "capabilities" } },
  })}\n`);
  const called = await reader.next();
  expect(called).toMatchObject({
    id: 3,
    result: { isError: false, structuredContent: { ok: true, result: {
      protocol: "flab.control.v1",
      descriptorUi: { controls: ["input", "checkbox", "slider", "select"] },
    } } },
  });
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toContain("flab-mcp ready on stdio");
});
