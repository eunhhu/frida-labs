import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  augmentAcpClientMessage,
  augmentAcpInitializeResponse,
  detectAcpAgents,
  flabMcpCommand,
  selectAcpAgent,
} from "../src/core/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("ACP auto-detection finds installed native agents without executing them", () => {
  const root = mkdtempSync(join(tmpdir(), "flab-acp-"));
  roots.push(root);
  const executable = join(root, "opencode");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const env = { PATH: [root, "/missing"].join(delimiter) };
  const detected = detectAcpAgents(env).filter((candidate) => candidate.detected);
  expect(detected).toMatchObject([{ id: "opencode", args: ["acp"], executable }]);
  expect(selectAcpAgent(undefined, env)).toMatchObject({ id: "opencode", command: executable, args: ["acp"] });
});

test("ACP session setup receives exactly one flab MCP bridge", () => {
  const request = {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/workspace", mcpServers: [{ name: "existing", command: "x", args: [], env: [] }] },
  };
  const once = augmentAcpClientMessage(request) as typeof request;
  const twice = augmentAcpClientMessage(once) as typeof request;
  expect(once.params.mcpServers.map((server) => server.name)).toEqual(["existing", "flab"]);
  expect(twice.params.mcpServers.map((server) => server.name)).toEqual(["existing", "flab"]);
  expect((once.params as unknown as { _meta: { flab: { gateway: string } } })._meta.flab.gateway).toBe("flab.acp.v1");
});

test("ACP initialize preserves upstream capabilities and identifies the gateway", () => {
  const response = augmentAcpInitializeResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "upstream", title: "Upstream Agent", version: "1" },
      authMethods: [{ id: "login", name: "Login", description: "Login" }],
    },
  }, {
    id: "opencode",
    label: "OpenCode ACP",
    command: "/bin/opencode",
    args: ["acp"],
    detected: true,
    executable: "/bin/opencode",
    source: "path",
  }) as { result: Record<string, unknown> };
  expect(response.result).toMatchObject({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "upstream", title: "flab · Upstream Agent" },
    _meta: { flab: { gateway: "flab.acp.v1", upstream: "opencode", autoDetected: true } },
  });
});

test("MCP launch command follows source and compiled runtimes", () => {
  expect(flabMcpCommand(["bun", "/repo/src/bin.ts", "acp"], "/bin/bun")).toEqual({
    command: "/bin/bun",
    args: [resolve("/repo/src/bin.ts"), "mcp"],
  });
  expect(flabMcpCommand(["bun", "src/bin.ts", "acp"], "/bin/bun")).toEqual({
    command: "/bin/bun",
    args: [join(process.cwd(), "src/bin.ts"), "mcp"],
  });
  expect(flabMcpCommand(["/bin/flab", "acp"], "/bin/flab")).toEqual({ command: "/bin/flab", args: ["mcp"] });
});

test("flab ACP gateway completes a real handshake and injects MCP before session creation", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url));
  const upstream = JSON.stringify([process.execPath, fixture]);
  const child = Bun.spawn([process.execPath, "src/bin.ts", "acp", "--upstream", upstream], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test-client", version: "1" } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: process.cwd(), mcpServers: [] },
  })}\n`);
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(messages[0]).toMatchObject({
    id: 1,
    result: { agentInfo: { title: "flab · Fixture ACP" }, _meta: { flab: { gateway: "flab.acp.v1" } } },
  });
  expect(messages[1]).toMatchObject({ id: 2, result: { _meta: { mcpNames: ["flab"] } } });
  expect(stderr).toContain("client test-client 1");
});
