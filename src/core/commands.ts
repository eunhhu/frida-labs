// Command registry — the single source of truth for the CLI surface.

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { AGENT_OUT, compileAgent } from "./compile.js";
import { depcheck } from "./depcheck.js";
import { libReference, renderLibText } from "./libref.js";
import { loadManifest, repoRoot, type TargetConfig } from "./manifest.js";
import { discoverProcessSnapshot } from "./processes.js";
import {
  describeDevice,
  deviceSelectorLabel,
  deviceSelectorFromFlags,
  discoverDevices,
  normalizeDeviceSelector,
  resolveDevice,
  type DeviceSelector,
} from "./devices.js";
import { ActionService } from "./actions.js";
import {
  MACHINE_PROTOCOL,
  handleMachineRequest,
  machineCapabilities,
  parseMachineRequestLine,
  type MachineResponse,
} from "./machine.js";
import {
  currentProjectService,
  ProjectError,
  type ProjectResult,
  type ProjectService,
  type TargetPatch,
} from "./projects.js";
import {
  targetMutationFailure,
  targetMutationSuccess,
  type TargetMutationOperation,
} from "./protocol.js";
import { scaffold } from "./scaffold.js";
import { evalOnce, startSession, type RpcDescriptor, type SessionOptions } from "./session.js";

export interface CmdCtx {
  json: boolean;
  out(line: string): void;
  err(line: string): void;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  allowedFlags: readonly string[];
  detail?: string;
  run(args: string[], flags: Record<string, string | boolean>, ctx: CmdCtx): Promise<number>;
}

const PROBE_ENTRY = "agent/targets/_probe/index.ts";
const DEVICE_FLAGS = ["device", "host", "device-timeout"] as const;

function json(ctx: CmdCtx, value: unknown): void {
  ctx.out(JSON.stringify(value));
}

function commandFailure(
  ctx: CmdCtx,
  message: string,
  exit: 1 | 2,
): number {
  if (ctx.json) json(ctx, { error: message });
  else ctx.err(message);
  return exit;
}

function mutationFailure(
  ctx: CmdCtx,
  operation: TargetMutationOperation,
  code: string,
  message: string,
  exit: 1 | 2,
  residue?: string,
): number {
  if (ctx.json) json(ctx, targetMutationFailure(operation, code, message, residue));
  else ctx.err(message);
  return exit;
}

function asProjectError(error: unknown): ProjectError {
  if (error instanceof ProjectError) return error;
  return new ProjectError("io", error instanceof Error ? error.message : String(error));
}

function rejectFlags(
  flags: Record<string, string | boolean>,
  allowed: readonly string[],
): string | undefined {
  const unexpected = Object.keys(flags).find((flag) => !allowed.includes(flag));
  return unexpected ? `--${unexpected} is not valid for this operation` : undefined;
}

function positiveInteger(value: string | boolean | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) throw new Error("limit must be an integer from 1 to 10000");
  return parsed;
}

function selectedDevice(flags: Record<string, string | boolean>): DeviceSelector | undefined {
  return deviceSelectorFromFlags(flags.device, flags.host, flags["device-timeout"]);
}

function parsePlatforms(value: string | boolean | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("--platforms requires a JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--platforms must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.entries(parsed).some(([platform, processName]) => !platform || typeof processName !== "string" || !processName.trim())) {
    throw new Error("--platforms must be a JSON object of non-empty platform/process strings");
  }
  return parsed as Record<string, string>;
}

function targetRow(name: string, config: TargetConfig): Record<string, unknown> {
  return {
    name,
    ...config,
    entryExists: existsSync(join(repoRoot(), config.entry)),
  };
}

function humanProject(result: ProjectResult): string {
  return `[+] ${result.operation} ${result.name} (${result.entry})${result.warnings.length ? ` — ${result.warnings.join("; ")}` : ""}`;
}


async function startHumanSession(options: SessionOptions, label: string, ctx: CmdCtx): Promise<number> {
  const session = await startSession(options, {
    onLog: (line) => ctx.out(line),
    onError: (line) => ctx.err(line),
    onClose: (reason) => { ctx.out(`[detached: ${reason}]`); process.exit(0); },
  });
  ctx.out(`REPL ready — rpc exports: ${(await session.describe()).map((item) => item.name).join(", ") || "(none)"} · .exit to quit`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${label}> ` });
  rl.prompt();
  rl.on("line", async (line) => {
    const source = line.trim();
    if (source === ".exit" || source === ".quit") return void rl.close();
    if (source) {
      try {
        const result = await session.eval(source);
        if (result !== undefined) ctx.out(inspect(result, { colors: true, depth: 6 }));
      } catch (error) { ctx.err((error as Error).message); }
    }
    rl.prompt();
  });
  rl.on("close", async () => { await session.close(); process.exit(0); });
  return 0;
}

async function startMachineSession(options: SessionOptions, ctx: CmdCtx): Promise<number> {
  let input: ReturnType<typeof createInterface> | null = null;
  let closing = false;
  let detachedReason: string | null = null;
  const session = await startSession(options, {
    onLog: (line) => ctx.err(line),
    onError: (line) => ctx.err(line),
    onClose: (reason) => {
      detachedReason = reason;
      if (!closing) json(ctx, { type: "event", event: "detached", reason });
      input?.close();
    },
  });
  let descriptors: RpcDescriptor[];
  try {
    descriptors = await session.describe();
  } catch (error) {
    await session.close();
    throw error;
  }
  json(ctx, {
    type: "ready",
    protocol: MACHINE_PROTOCOL,
    target: session.target,
    process: session.process,
    pid: session.pid,
    device: session.device,
    actions: descriptors,
  });

  const actions = new ActionService();
  input = createInterface({ input: process.stdin, terminal: false });
  if (detachedReason !== null) input.close();
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const parsed = parseMachineRequestLine(line);
      if (!parsed.ok) {
        const response: MachineResponse = {
          type: "response",
          id: parsed.id,
          ok: false,
          error: { code: parsed.code, message: parsed.message },
        };
        json(ctx, response);
        continue;
      }
      if (parsed.request.op === "close") {
        closing = true;
        json(ctx, { type: "response", id: parsed.request.id, ok: true, result: { closed: true } });
        break;
      }
      json(ctx, await handleMachineRequest(session, actions, parsed.request));
    }
  } finally {
    closing = true;
    input.close();
    await session.close();
  }
  return detachedReason === null ? 0 : 1;
}


async function runProjectOperation(
  operation: string,
  args: string[],
  flags: Record<string, string | boolean>,
  ctx: CmdCtx,
): Promise<number> {
  const usage = "usage: flab target <set|rename|unregister|delete> ...";
  if (
    operation !== "set" &&
    operation !== "rename" &&
    operation !== "unregister" &&
    operation !== "delete"
  ) {
    return commandFailure(ctx, `unknown target operation "${operation}". ${usage}`, 2);
  }

  const mutationOperation = operation;
  const targetFlags: Record<TargetMutationOperation, readonly string[]> = {
    set: ["json", "proc", "mode", "entry", "platforms", ...DEVICE_FLAGS],
    rename: ["json", "registry-only"],
    unregister: ["json"],
    delete: ["json", "confirm"],
  };
  const invalidFlag = rejectFlags(flags, targetFlags[mutationOperation]);
  if (invalidFlag) {
    return mutationFailure(ctx, mutationOperation, "unknown-flag", invalidFlag, 2);
  }

  const name = args[1];
  if (!name) {
    return mutationFailure(ctx, mutationOperation, "usage", usage, 2);
  }

  let projects: ProjectService;
  try {
    projects = currentProjectService();
  } catch (error) {
    const problem = asProjectError(error);
    return mutationFailure(ctx, mutationOperation, problem.code, problem.message, 1, problem.residue);
  }

  let mutate: () => Promise<ProjectResult>;
  if (mutationOperation === "set") {
    if (args.length !== 2) {
      return mutationFailure(ctx, mutationOperation, "usage", "usage: flab target set <name> [flags]", 2);
    }
    const patch: TargetPatch = {};
    if (typeof flags.proc === "string") patch.process = flags.proc;
    if (typeof flags.entry === "string") patch.entry = flags.entry;
    if (flags.mode !== undefined) {
      if (flags.mode !== "attach" && flags.mode !== "spawn") {
        return mutationFailure(ctx, mutationOperation, "validation", "--mode must be attach or spawn", 1);
      }
      patch.mode = flags.mode;
    }
    if (flags.platforms !== undefined) {
      try {
        patch.processByPlatform = parsePlatforms(flags.platforms);
      } catch (error) {
        return mutationFailure(ctx, mutationOperation, "validation", (error as Error).message, 1);
      }
    }
    if (flags.device !== undefined || flags.host !== undefined || flags["device-timeout"] !== undefined) {
      try {
        patch.device = selectedDevice(flags)!;
      } catch (error) {
        return mutationFailure(ctx, mutationOperation, "validation", (error as Error).message, 1);
      }
    }
    if (!Object.keys(patch).length) {
      return mutationFailure(ctx, mutationOperation, "usage", "target set requires --proc, --mode, --entry, --platforms, --device, or --host", 2);
    }
    mutate = () => projects.update(name, patch);
  } else if (mutationOperation === "rename") {
    if (args.length !== 3) {
      return mutationFailure(ctx, mutationOperation, "usage", "usage: flab target rename <old> <new> [--registry-only]", 2);
    }
    mutate = () => projects.rename(name, args[2]!, { moveConventionalSources: !flags["registry-only"] });
  } else if (mutationOperation === "unregister") {
    if (args.length !== 2) {
      return mutationFailure(ctx, mutationOperation, "usage", "usage: flab target unregister <name>", 2);
    }
    mutate = () => projects.remove({ name, policy: "unregister" });
  } else {
    if (args.length !== 2) {
      return mutationFailure(ctx, mutationOperation, "usage", "usage: flab target delete <name> --confirm <name>", 2);
    }
    const confirmation = typeof flags.confirm === "string" ? flags.confirm : undefined;
    if (confirmation !== name) {
      return mutationFailure(ctx, mutationOperation, "confirmation", `delete confirmation must exactly match "${name}"`, 2);
    }
    mutate = () => projects.remove({ name, policy: "delete-sources", confirmation });
  }

  try {
    const result = await mutate();
    if (ctx.json) json(ctx, targetMutationSuccess(mutationOperation, result));
    else ctx.out(humanProject(result));
    return 0;
  } catch (error) {
    const problem = asProjectError(error);
    return mutationFailure(
      ctx,
      mutationOperation,
      problem.code,
      problem.message,
      problem.code === "confirmation" ? 2 : 1,
      problem.residue,
    );
  }
}

export const commands: Command[] = [
  {
    name: "devices",
    usage: "flab devices [--device local|usb|remote|ID | --host HOST] [--device-timeout MS] [--json]",
    summary: "List Frida devices and verify an optional local/USB/remote selection.",
    allowedFlags: ["json", ...DEVICE_FLAGS],
    async run(args, flags, ctx) {
      if (args.length) return commandFailure(ctx, "usage: flab devices [--device DEVICE | --host HOST]", 2);
      let selector: DeviceSelector | undefined;
      try { selector = selectedDevice(flags); }
      catch (error) { return commandFailure(ctx, (error as Error).message, 1); }
      const selected = selector ? await describeDevice(await resolveDevice(selector), selector) : null;
      const choices = await discoverDevices();
      const devices = choices.map((choice) => choice.info);
      if (selected && !devices.some((device) => device.id === selected.id)) devices.push(selected);
      if (ctx.json) json(ctx, { devices, selected });
      else {
        for (const device of devices) {
          const marker = selected?.id === device.id ? "*" : " ";
          ctx.out(`${marker} ${device.type.padEnd(6)} ${device.id.padEnd(24)} ${device.name}${device.platform ? ` · ${device.platform}/${device.arch ?? "?"}` : ""}`);
        }
      }
      return 0;
    },
  },
  {
    name: "processes",
    usage: "flab processes [query] [--device DEVICE | --host HOST] [--limit N] [--json]",
    summary: "Discover live processes and show matching targets.",
    allowedFlags: ["json", "limit", "query", ...DEVICE_FLAGS],
    async run(args, flags, ctx) {
      if (args.length > 1) return commandFailure(ctx, "usage: flab processes [query] [--limit N]", 2);
      const query = args[0] ?? (typeof flags.query === "string" ? flags.query : undefined);
      let limit: number;
      try {
        limit = positiveInteger(flags.limit, ctx.json ? 5000 : 80);
      } catch (error) {
        return commandFailure(ctx, (error as Error).message, 1);
      }
      let device: DeviceSelector | undefined;
      try { device = selectedDevice(flags); }
      catch (error) { return commandFailure(ctx, (error as Error).message, 1); }
      const snapshot = await discoverProcessSnapshot({ query, limit, device });
      const rows = snapshot.processes;
      if (ctx.json) json(ctx, { device: snapshot.device, processes: rows, query: query ?? null });
      else {
        ctx.out(`device: ${snapshot.device.name} [${snapshot.device.id}] · ${snapshot.device.type}${snapshot.device.platform ? ` · ${snapshot.device.platform}/${snapshot.device.arch ?? "?"}` : ""}`);
        for (const row of rows) ctx.out(`${String(row.pid).padStart(7)}  ${row.name.padEnd(40)} ${row.matchedTargets.length ? `target: ${row.matchedTargets.join(",")}` : "probe"}`);
        if (!rows.length) ctx.out("no matching processes");
      }
      return 0;
    },
  },
  {
    name: "targets",
    usage: "flab targets [--json]",
    summary: "List registered targets and source readiness.",
    allowedFlags: ["json"],
    async run(args, _flags, ctx) {
      if (args.length) return commandFailure(ctx, "usage: flab targets", 2);
      const rows = Object.entries(loadManifest().targets)
        .filter(([name]) => name !== "_probe")
        .map(([name, config]) => targetRow(name, config));
      if (ctx.json) json(ctx, { targets: rows });
      else for (const row of rows) {
        const device = row.device === undefined ? "local" : deviceSelectorLabel(normalizeDeviceSelector(row.device));
        ctx.out(`${String(row.name).padEnd(20)} ${String(row.process).padEnd(32)} ${String(row.mode).padEnd(7)} ${device.padEnd(18)} ${row.entry}${row.entryExists ? "" : " [missing]"}`);
      }
      return 0;
    },
  },
  {
    name: "new",
    usage: "flab new <name> [\"Game.exe\"] [--proc \"Game.exe\"] [--device DEVICE | --host HOST] [--json]",
    summary: "Scaffold a new target and register it in frida-labs.json.",
    allowedFlags: ["json", "proc", ...DEVICE_FLAGS],
    detail: "Creates agent/targets/<name>/index.ts and adds a manifest entry.",
    async run(args, flags, ctx) {
      const name = args[0];
      if (!name || args.length > 2) {
        return commandFailure(ctx, "usage: flab new <name> [\"Game.exe\"] [--proc \"Game.exe\"]", 2);
      }
      let device: DeviceSelector | undefined;
      try { device = selectedDevice(flags); }
      catch (error) { return commandFailure(ctx, (error as Error).message, 1); }
      const result = await scaffold(name, args[1] ?? (typeof flags.proc === "string" ? flags.proc : undefined), device);
      if (ctx.json) json(ctx, result);
      else ctx.out(`[+] ${result.entry} (process: ${result.process}, device: ${result.device ? deviceSelectorLabel(result.device) : "local"})`);
      return 0;
    },
  },
  {
    name: "target",
    usage: "flab target <set|rename|unregister|delete> ... [--json]",
    summary: "Update, rename, unregister, or delete registered targets.",
    allowedFlags: ["json", "proc", "mode", "entry", "platforms", "registry-only", "confirm", ...DEVICE_FLAGS],
    detail: [
      "set <name> [--proc P] [--mode attach|spawn] [--entry E] [--platforms JSON] [--device DEVICE | --host HOST]",
      "rename <old> <new> [--registry-only]",
      "unregister <name>",
      "delete <name> --confirm <name>",
    ].join("\n"),
    async run(args, flags, ctx) {
      const operation = args[0];
      if (!operation) {
        return commandFailure(ctx, "usage: flab target <set|rename|unregister|delete> ...", 2);
      }
      return runProjectOperation(operation, args, flags, ctx);
    },
  },
  {
    name: "build",
    usage: "flab build <target> [--out file] [--json]",
    summary: "Compile a target agent bundle without injecting.",
    allowedFlags: ["json", "out"],
    async run(args, flags, ctx) {
      const target = args[0];
      if (!target || args.length !== 1) {
        return commandFailure(ctx, "usage: flab build <target> [--out file]", 2);
      }
      const bundle = await compileAgent(target);
      const out = typeof flags.out === "string" ? flags.out : AGENT_OUT;
      const outPath = join(repoRoot(), out);
      const previous = existsSync(outPath) ? statSync(outPath).size : null;
      writeFileSync(outPath, bundle);
      if (ctx.json) json(ctx, { target, out, bytes: bundle.length, prevBytes: previous });
      else {
        const diff = previous === null ? "new" : `${bundle.length >= previous ? "+" : "−"}${Math.abs(bundle.length - previous)} B`;
        ctx.out(`[+] built ${out} (${bundle.length} bytes, ${diff})`);
      }
      return 0;
    },
  },
  {
    name: "run",
    usage: "flab run <target> [--device DEVICE | --host HOST] [--proc P] [--spawn] [--eval \"code\" | --session --json] [--no-watch]",
    summary: "Compile, attach, inject, then REPL or run a one-shot evaluation.",
    allowedFlags: ["json", "proc", "spawn", "eval", "no-watch", "session", ...DEVICE_FLAGS],
    detail: "One-shot JSON mode: flab run <target> --no-watch --eval 'await ping()' --json",
    async run(args, flags, ctx) {
      const target = args[0];
      if (!target || args.length !== 1) {
        return commandFailure(ctx, "usage: flab run <target> [--eval code]", 2);
      }
      const oneShot = typeof flags.eval === "string";
      const machine = flags.session === true;
      if (machine && oneShot) return commandFailure(ctx, "--session cannot be combined with --eval", 2);
      if (machine && !ctx.json) return commandFailure(ctx, "--session requires --json", 2);
      let device: DeviceSelector | undefined;
      try { device = selectedDevice(flags); }
      catch (error) { return commandFailure(ctx, (error as Error).message, 1); }
      const options: SessionOptions = {
        target,
        processOverride: typeof flags.proc === "string" ? flags.proc : undefined,
        spawn: !!flags.spawn,
        noWatch: !!flags["no-watch"] || oneShot,
        ...(device ? { device } : {}),
      };
      if (oneShot) {
        const result = await evalOnce(options, flags.eval as string, {
          onLog: (line) => (ctx.json ? ctx.err(line) : ctx.out(line)),
          onError: (line) => ctx.err(line),
        });
        if (ctx.json) json(ctx, { result });
        else ctx.out(inspect(result, { colors: false, depth: 6 }));
        return 0;
      }
      if (machine) return startMachineSession(options, ctx);
      return startHumanSession(options, target, ctx);
    },
  },
  {
    name: "probe",
    usage: "flab probe (<process> | --pid <pid>) [--device DEVICE | --host HOST] [--spawn] [--eval \"code\" | --session --json]",
    summary: "Inject the engine-agnostic probe agent into a process or PID.",
    allowedFlags: ["json", "pid", "spawn", "eval", "session", ...DEVICE_FLAGS],
    async run(args, flags, ctx) {
      const processName = args[0];
      const pidValue = typeof flags.pid === "string" ? flags.pid : undefined;
      if (args.length > 1 || (processName && pidValue) || (!processName && !pidValue)) {
        return commandFailure(ctx, "usage: flab probe (<process> | --pid <pid>) [--eval code]", 2);
      }

      let device: DeviceSelector | undefined;
      try { device = selectedDevice(flags); }
      catch (error) { return commandFailure(ctx, (error as Error).message, 1); }
      let options: SessionOptions;
      if (pidValue !== undefined) {
        if (!/^\d+$/.test(pidValue)) {
          return commandFailure(ctx, "--pid must be a positive safe integer", 1);
        }
        const pid = Number(pidValue);
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          return commandFailure(ctx, "--pid must be a positive safe integer", 1);
        }
        if (flags.spawn) {
          return commandFailure(ctx, "--pid cannot be combined with --spawn", 1);
        }
        options = { target: PROBE_ENTRY, attachPid: pid, processDisplay: `pid:${pid}`, ...(device ? { device } : {}) };
      } else {
        options = { target: PROBE_ENTRY, processOverride: processName!, spawn: !!flags.spawn, ...(device ? { device } : {}) };
      }

      const machine = flags.session === true;
      if (machine && typeof flags.eval === "string") return commandFailure(ctx, "--session cannot be combined with --eval", 2);
      if (machine && !ctx.json) return commandFailure(ctx, "--session requires --json", 2);
      if (machine) return startMachineSession(options, ctx);

      const expression = typeof flags.eval === "string" ? flags.eval : "await engines()";
      const result = await evalOnce(options, expression, {
        onLog: (line) => (ctx.json ? ctx.err(line) : ctx.out(line)),
        onError: (line) => ctx.err(line),
      });
      if (ctx.json) json(ctx, { result });
      else ctx.out(inspect(result, { colors: false, depth: 6 }));
      return 0;
    },
  },
  {
    name: "capabilities",
    usage: "flab capabilities [--json]",
    summary: "Describe the stable AI-agent protocol and managed instrument lifecycle.",
    allowedFlags: ["json"],
    async run(args, _flags, ctx) {
      if (args.length) return commandFailure(ctx, "usage: flab capabilities", 2);
      const capabilities = machineCapabilities();
      if (ctx.json) json(ctx, capabilities);
      else ctx.out(inspect(capabilities, { colors: false, depth: 8 }));
      return 0;
    },
  },
  {
    name: "lib",
    usage: "flab lib [--json]",
    summary: "Print the agent/lib API surface extracted from source.",
    allowedFlags: ["json"],
    async run(args, _flags, ctx) {
      if (args.length) return commandFailure(ctx, "usage: flab lib", 2);
      const modules = libReference();
      if (ctx.json) json(ctx, modules);
      else ctx.out(renderLibText(modules));
      return 0;
    },
  },
  {
    name: "depcheck",
    usage: "flab depcheck [--json]",
    summary: "Fail when a target imports outside agent/lib.",
    allowedFlags: ["json"],
    detail: "Targets must depend only on agent/lib. Violations exit 1.",
    async run(args, _flags, ctx) {
      if (args.length) return commandFailure(ctx, "usage: flab depcheck", 2);
      const result = depcheck();
      if (ctx.json) json(ctx, result);
      else {
        ctx.out(`scanned ${result.scanned} import edge(s) across agent/targets`);
        for (const violation of result.violations) {
          ctx.out(`✗ violation  ${violation.file}:${violation.line}  "${violation.specifier}"  — targets may only import agent/lib`);
        }
      }
      return result.violations.length ? 1 : 0;
    },
  },
  {
    name: "doctor",
    usage: "flab doctor [--device DEVICE | --host HOST] [--device-timeout MS] [--json]",
    summary: "Check runtime, Frida API/device, process visibility, and manifest.",
    allowedFlags: ["json", ...DEVICE_FLAGS],
    async run(args, flags, ctx) {
      if (args.length) return commandFailure(ctx, "usage: flab doctor", 2);
      let selector: DeviceSelector;
      try { selector = selectedDevice(flags) ?? { kind: "local" }; }
      catch (error) { return commandFailure(ctx, (error as Error).message, 1); }
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [
        { name: "runtime", ok: true, detail: `${process.version} (${process.platform}/${process.arch})` },
      ];
      try {
        const device = await resolveDevice(selector);
        const info = await describeDevice(device, selector);
        const params = await device.querySystemParameters().catch(() => null);
        const version = (params as { version?: string } | null)?.version ?? "unknown";
        checks.push({ name: "frida", ok: true, detail: `server ${version}` });
        const processes = await device.enumerateProcesses();
        checks.push({ name: "device", ok: true, detail: `${info.name} [${info.id}] ${info.type} reachable, ${processes.length} processes visible` });
      } catch (error) {
        checks.push({ name: "frida", ok: false, detail: (error as Error).message });
      }
      try {
        checks.push({ name: "manifest", ok: true, detail: `${Object.keys(loadManifest().targets).length} targets` });
      } catch (error) {
        checks.push({ name: "manifest", ok: false, detail: (error as Error).message });
      }
      if (ctx.json) json(ctx, checks);
      else for (const check of checks) ctx.out(`${check.ok ? "✓" : "✗"} ${check.name.padEnd(10)} ${check.detail}`);
      return checks.every((check) => check.ok) ? 0 : 1;
    },
  },
];

export function renderHelp(): string {
  const byName = new Map(commands.map((command) => [command.name, command]));
  const group = (title: string, names: readonly string[], lines: string[]): void => {
    lines.push(title);
    for (const name of names) {
      const command = byName.get(name)!;
      lines.push(`  ${name.padEnd(14)} ${command.summary}`);
    }
    lines.push("");
  };
  const lines = [
    "flab — connect, inspect, and mod an authorized offline/single-player game",
    "",
    "start here:",
    "  flab                  open the guided Connect → Mods → Inspect TUI",
    "  flab doctor           verify Frida and the selected device",
    "  flab --help           show this page",
    "",
  ];
  group("connect and use:", ["devices", "processes", "run", "probe"], lines);
  group("saved games:", ["targets", "new", "target", "build"], lines);
  group("agent and developer tools:", ["capabilities", "lib", "depcheck", "doctor"], lines);
  lines.push("details:");
  lines.push("  flab <command> --help  command usage and options");
  lines.push("  flab tui [target]      open the TUI; optionally connect a saved game");
  lines.push("  flab <command> --json  stable machine-readable output");
  lines.push("  device selectors       --device local|usb|remote|ID or --host HOST:PORT");
  return lines.join("\n");
}

export function renderCommandHelp(command: Command): string {
  const lines = [command.usage, "", command.summary];
  if (command.detail) lines.push("", command.detail);
  if (command.allowedFlags.includes("json")) {
    lines.push("", "Add --json for stable machine-readable output.");
  }
  return lines.join("\n");
}
