// MCP bridge for agent harnesses. ACP transports the conversation; MCP is the
// tool channel injected by the flab ACP gateway. Two low-noise tools expose the
// complete ControlService and a bounded event cursor.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  CONTROL_PROTOCOL,
  controlCapabilities,
  createControlService,
  type ControlEvent,
  type ControlService,
} from "./control.js";

export const FLAB_MCP_SERVER = "flab-mcp";
export const FLAB_MCP_VERSION = "1.0.0";

interface SequencedEvent {
  cursor: number;
  event: ControlEvent;
}

export class ControlEventRing {
  private events: SequencedEvent[] = [];
  private nextCursor = 1;
  private dropped = 0;

  constructor(private readonly limit = 2_000) {}

  push(event: ControlEvent): void {
    this.events.push({ cursor: this.nextCursor++, event });
    const overflow = this.events.length - this.limit;
    if (overflow > 0) {
      this.events.splice(0, overflow);
      this.dropped += overflow;
    }
  }

  read(after = 0, limit = 100): { events: SequencedEvent[]; nextCursor: number; dropped: number } {
    const events = this.events.filter((entry) => entry.cursor > after).slice(0, limit);
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
      dropped: this.dropped,
    };
  }
}

export interface FlabMcpServerOptions {
  control?: ControlService;
  events?: ControlEventRing;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Create one stateful MCP server instance for one agent connection. */
export function createFlabMcpServer(options: FlabMcpServerOptions = {}): {
  server: McpServer;
  control: ControlService;
  events: ControlEventRing;
} {
  const events = options.events ?? new ControlEventRing();
  const control = options.control ?? createControlService({ onEvent: (event) => events.push(event) });
  const server = new McpServer(
    { name: FLAB_MCP_SERVER, version: FLAB_MCP_VERSION },
    {
      instructions: [
        `flab exposes ${CONTROL_PROTOCOL}.`,
        "Call flab_control with capabilities, then authorize a concrete owned-offline or fully owned/consenting/isolated private-lab profile before device, mutation, live, or Record operations.",
        "Use record.plan → record.start, ask the human to play one controlled scenario, then record.stop → record.summary before writing an Instrument.",
        "Never use public matchmaking, production economies, third-party accounts, or anti-cheat bypass.",
      ].join(" "),
    },
  );

  server.registerResource(
    "flab-capabilities",
    "flab://capabilities",
    {
      title: "flab Agent capabilities",
      description: "Current Control API operations, authorization boundary, and interface map.",
      mimeType: "application/json",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: jsonText(controlCapabilities()) }] }),
  );

  server.registerPrompt(
    "build-instrument",
    {
      title: "Analyze a game and build an Instrument",
      description: "Start a controlled Record-assisted Instrument workflow.",
      argsSchema: z.object({
        game: z.string().min(1).max(200),
        process: z.string().min(1).max(500),
        device: z.string().min(1).max(500).default("local"),
        features: z.string().min(1).max(2_000),
      }),
    },
    ({ game, process, device, features }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Analyze my authorized game ${game} (${process}) on ${device}.`,
            `Priorities: ${features}.`,
            "Use flab MCP only after an explicit authorization profile.",
            "Prefer Record-assisted controlled experiments: plan bounded hooks, record one natural human-play action, summarize timing/arguments/returns, implement descriptor UI controls and linked state, build, verify, clean up, reattach, and package.",
          ].join(" "),
        },
      }],
    }),
  );

  let requestId = 1;
  server.registerTool(
    "flab_control",
    {
      title: "flab Control API",
      description: "Invoke one typed flab.control.v1 operation. The request object contains operation fields but never id/op. Supports discovery, authorization, source/module authoring, build/package, live session actions, and analysis Record operations.",
      inputSchema: z.object({
        op: z.string().min(1).max(128),
        request: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ op, request }) => {
      if (request && (Object.hasOwn(request, "id") || Object.hasOwn(request, "op"))) {
        const problem = { ok: false, error: { code: "invalid-request", message: "request must not contain id or op" } };
        return { isError: true, content: [{ type: "text" as const, text: jsonText(problem) }] };
      }
      const response = await control.handle({ id: `mcp-${requestId++}`, op, ...(request ?? {}) });
      return {
        isError: !response.ok,
        content: [{ type: "text" as const, text: jsonText(response) }],
        structuredContent: response as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "flab_events",
    {
      title: "Read flab live events",
      description: "Read bounded session log/error/detach/payload events after a cursor. Poll after live actions; Record data itself is stored and queried through record.status/read/summary.",
      inputSchema: z.object({
        after: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ after, limit }) => {
      const result = events.read(after ?? 0, limit ?? 100);
      return {
        content: [{ type: "text" as const, text: jsonText(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return { server, control, events };
}

/** Serve MCP until stdin closes; stdout remains protocol-only. */
export async function runFlabMcpStdio(): Promise<number> {
  const controls = new Set<ControlService>();
  const handle = serveStdio(() => {
    const instance = createFlabMcpServer();
    controls.add(instance.control);
    return instance.server;
  }, { onerror: (error) => process.stderr.write(`[flab mcp] ${error.message}\n`) });
  process.stderr.write(`[flab mcp] ${FLAB_MCP_SERVER} ready on stdio\n`);
  await new Promise<void>((resolve) => {
    if (process.stdin.readableEnded) return resolve();
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await handle.close();
  await Promise.allSettled([...controls].map((control) => control.close()));
  return 0;
}
