// ACP gateway. ACP connects an editor/client to a coding-agent process; flab
// stays protocol-neutral by proxying any installed ACP agent and injecting the
// flab MCP tool bridge into every session. The bridge delegates to the same
// ControlService used by the CLI and TUI.

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export const ACP_PROTOCOL_VERSION = 1;
export const FLAB_ACP_GATEWAY = "flab.acp.v1";
export const ACP_LINE_MAX_BYTES = 8 * 1024 * 1024;

export interface AcpCommand {
  command: string;
  args: string[];
}

export interface AcpCandidate extends AcpCommand {
  id: string;
  label: string;
  detected: boolean;
  executable: string | null;
  source: "environment" | "path";
}

interface KnownAgent {
  id: string;
  label: string;
  executable: string;
  args: string[];
}

const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: "codex-acp", label: "Codex ACP", executable: "codex-acp", args: [] },
  { id: "claude-agent-acp", label: "Claude Agent ACP", executable: "claude-agent-acp", args: [] },
  { id: "opencode", label: "OpenCode ACP", executable: "opencode", args: ["acp"] },
  { id: "gemini", label: "Gemini CLI ACP", executable: "gemini", args: ["--acp"] },
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function commandArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 ||
      value.some((part) => typeof part !== "string" || !part || part.length > 4096)) {
    throw new Error(`${field} must be a JSON array of 1..32 non-empty command strings`);
  }
  return value as string[];
}

function executableNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32" || extname(command)) return [command];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  return [...extensions.map((extension) => `${command}${extension}`), command];
}

function findExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = isAbsolute(command)
    ? executableNames(command, env)
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => executableNames(join(directory, command), env));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* keep searching */ }
  }
  return null;
}

/** Detect installed ACP-native agent commands without executing them. */
export function detectAcpAgents(env: NodeJS.ProcessEnv = process.env): AcpCandidate[] {
  const candidates: AcpCandidate[] = [];
  if (env.FLAB_ACP_UPSTREAM) {
    try {
      const command = commandArray(JSON.parse(env.FLAB_ACP_UPSTREAM), "FLAB_ACP_UPSTREAM");
      const executable = findExecutable(command[0]!, env);
      candidates.push({
        id: "environment",
        label: "Configured ACP agent",
        command: executable ?? command[0]!,
        args: command.slice(1),
        detected: executable !== null,
        executable,
        source: "environment",
      });
    } catch {
      candidates.push({
        id: "environment",
        label: "Invalid FLAB_ACP_UPSTREAM",
        command: "",
        args: [],
        detected: false,
        executable: null,
        source: "environment",
      });
    }
  }
  for (const known of KNOWN_AGENTS) {
    const executable = findExecutable(known.executable, env);
    candidates.push({
      id: known.id,
      label: known.label,
      command: executable ?? known.executable,
      args: [...known.args],
      detected: executable !== null,
      executable,
      source: "path",
    });
  }
  return candidates;
}

/** Resolve explicit JSON command/id, or auto-select the only detected agent. */
export function selectAcpAgent(selector?: string, env: NodeJS.ProcessEnv = process.env): AcpCandidate {
  const candidates = detectAcpAgents(env);
  if (selector?.trim().startsWith("[")) {
    const command = commandArray(JSON.parse(selector), "--upstream");
    const executable = findExecutable(command[0]!, env);
    if (!executable) throw new Error(`ACP upstream executable not found: ${command[0]}`);
    return {
      id: "explicit",
      label: "Explicit ACP agent",
      command: executable,
      args: command.slice(1),
      detected: true,
      executable,
      source: "environment",
    };
  }
  if (selector) {
    const selected = candidates.find((candidate) => candidate.id === selector);
    if (!selected) throw new Error(`unknown ACP upstream ${JSON.stringify(selector)}`);
    if (!selected.detected) throw new Error(`${selected.label} is not installed or not on PATH`);
    return selected;
  }
  const configured = candidates.find((candidate) => candidate.id === "environment" && candidate.detected);
  if (configured) return configured;
  const detected = candidates.filter((candidate) => candidate.source === "path" && candidate.detected);
  if (detected.length === 1) return detected[0]!;
  if (detected.length === 0) {
    throw new Error("no ACP agent detected; install codex-acp/claude-agent-acp, or use opencode acp/gemini --acp, then run flab acp detect");
  }
  throw new Error(`multiple ACP agents detected (${detected.map((candidate) => candidate.id).join(", ")}); choose one with --upstream <id>`);
}

/** Command injected as an ACP session MCP server. Works in Bun source and compiled binaries. */
export function flabMcpCommand(argv = process.argv, execPath = process.execPath): AcpCommand {
  const entry = argv.slice(1).find((value) => /(?:^|[\\/])src[\\/]bin\.(?:ts|js)$/.test(value));
  return entry
    ? { command: execPath, args: [resolve(entry), "mcp"] }
    : { command: execPath, args: ["mcp"] };
}

function mcpServer(cwd: string | undefined): Record<string, unknown> {
  const launch = flabMcpCommand();
  return {
    name: "flab",
    command: launch.command,
    args: launch.args,
    env: cwd ? [{ name: "FLAB_WORKSPACE", value: cwd }] : [],
  };
}

/** Add flab tools to ACP session setup while preserving every upstream field. */
export function augmentAcpClientMessage(value: unknown): unknown {
  if (!record(value) || value.jsonrpc !== "2.0" ||
      (value.method !== "session/new" && value.method !== "session/load" && value.method !== "session/resume")) {
    return value;
  }
  const params = record(value.params) ? value.params : {};
  const current = Array.isArray(params.mcpServers) ? params.mcpServers : [];
  const alreadyPresent = current.some((server) => record(server) && server.name === "flab");
  return {
    ...value,
    params: {
      ...params,
      mcpServers: alreadyPresent ? current : [...current, mcpServer(typeof params.cwd === "string" ? params.cwd : undefined)],
      _meta: {
        ...(record(params._meta) ? params._meta : {}),
        flab: { gateway: FLAB_ACP_GATEWAY, controlProtocol: "flab.control.v1", tools: "mcp" },
      },
    },
  };
}

/** Mark initialize responses so clients can show the active upstream + flab bridge. */
export function augmentAcpInitializeResponse(value: unknown, upstream: AcpCandidate): unknown {
  if (!record(value) || !record(value.result)) return value;
  const result = value.result;
  const info = record(result.agentInfo) ? result.agentInfo : {};
  const title = typeof info.title === "string" ? info.title : typeof info.name === "string" ? info.name : upstream.label;
  return {
    ...value,
    result: {
      ...result,
      agentInfo: { ...info, title: `flab · ${title}` },
      _meta: {
        ...(record(result._meta) ? result._meta : {}),
        flab: { gateway: FLAB_ACP_GATEWAY, upstream: upstream.id, autoDetected: upstream.id !== "explicit" },
      },
    },
  };
}

function messageId(value: unknown): string | null {
  if (!record(value) || (typeof value.id !== "string" && typeof value.id !== "number")) return null;
  return `${typeof value.id}:${String(value.id)}`;
}

function parseLine(line: string): unknown {
  if (Buffer.byteLength(line) > ACP_LINE_MAX_BYTES) throw new Error(`ACP line exceeds ${ACP_LINE_MAX_BYTES} bytes`);
  return JSON.parse(line) as unknown;
}

export interface AcpGatewayOptions {
  upstream: AcpCandidate;
  input?: Readable;
  output?: Writable;
  error?: Writable;
  cwd?: string;
}

/** Transparent NDJSON proxy. Unknown ACP methods pass through unchanged. */
export async function runAcpGateway(options: AcpGatewayOptions): Promise<number> {
  const input: Readable = options.input ?? process.stdin;
  const output: Writable = options.output ?? process.stdout;
  const error: Writable = options.error ?? process.stderr;
  const child = spawn(options.upstream.command, options.upstream.args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const initializeIds = new Set<string>();
  const clientLines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  const agentLines = createInterface({ input: child.stdout, terminal: false, crlfDelay: Infinity });

  error.write(`[flab acp] ${options.upstream.label} (${options.upstream.command} ${options.upstream.args.join(" ")})\n`);
  child.stderr.pipe(error, { end: false });
  child.stdin.on("error", (problem) => {
    if (child.exitCode === null) error.write(`[flab acp] upstream input failed: ${problem.message}\n`);
  });

  clientLines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const parsed = parseLine(line);
      if (record(parsed) && parsed.method === "initialize") {
        const id = messageId(parsed);
        if (id) initializeIds.add(id);
        const clientInfo = record(parsed.params) && record(parsed.params.clientInfo) ? parsed.params.clientInfo : null;
        if (clientInfo) error.write(`[flab acp] client ${String(clientInfo.name ?? "unknown")} ${String(clientInfo.version ?? "")}\n`);
      }
      if (!child.stdin.destroyed && !child.stdin.write(`${JSON.stringify(augmentAcpClientMessage(parsed))}\n`)) {
        clientLines.pause();
        child.stdin.once("drain", () => clientLines.resume());
      }
    } catch (problem) {
      error.write(`[flab acp] rejected client line: ${(problem as Error).message}\n`);
      child.kill();
    }
  });
  clientLines.once("close", () => { if (!child.stdin.destroyed) child.stdin.end(); });

  agentLines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const parsed = parseLine(line);
      const id = messageId(parsed);
      const next = id && initializeIds.delete(id)
        ? augmentAcpInitializeResponse(parsed, options.upstream)
        : parsed;
      if (!output.write(`${JSON.stringify(next)}\n`)) {
        agentLines.pause();
        output.once("drain", () => agentLines.resume());
      }
    } catch (problem) {
      error.write(`[flab acp] rejected upstream line: ${(problem as Error).message}\n`);
      child.kill();
    }
  });

  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clientLines.close();
      agentLines.close();
      if (signal) error.write(`[flab acp] upstream stopped by ${signal}\n`);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
