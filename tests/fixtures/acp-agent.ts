import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, terminal: false });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> };
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "fixture-acp", title: "Fixture ACP", version: "1.0.0" },
        authMethods: [{ id: "fixture", name: "Fixture", description: "Test-only fixture" }],
      },
    })}\n`);
  } else if (request.method === "session/new") {
    const servers = Array.isArray(request.params?.mcpServers) ? request.params.mcpServers : [];
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: "fixture-session",
        _meta: { mcpNames: servers.flatMap((server) => server && typeof server === "object" && "name" in server ? [String(server.name)] : []) },
      },
    })}\n`);
  }
}
