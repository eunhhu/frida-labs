// Session engine — attach/spawn + inject + hot-reload + rpc. Shared by the
// CLI frontend and the TUI frontend; contains no UI code.

import frida from "frida";
import { join } from "node:path";
import { getTarget, repoRoot } from "./manifest.js";
import { compileEntry, watchEntry } from "./compile.js";
import { enableChildGating, enableSpawnGating, watchLifecycle, type LifecycleEvents } from "./lifecycle.js";
import { normalizeRpcDescriptors, type RpcDescriptor } from "./actions.js";
import {
  describeDevice,
  deviceSelectorLabel,
  normalizeDeviceSelector,
  resolveDevice,
  type DeviceInfo,
  type DeviceSelector,
} from "./devices.js";
export type { RpcDescriptor } from "./actions.js";

const PROBE_ENTRY = "agent/targets/_probe/index.ts";

type DeviceLaunch = { device?: DeviceSelector };

export type ProbeLaunch = (
  | { kind: "probe-attach-name"; process: string; childGating?: boolean }
  | { kind: "probe-attach-pid"; pid: number; display?: string; childGating?: boolean }
  | { kind: "probe-spawn"; executable: string }
) & DeviceLaunch;

export interface TargetLaunch {
  kind: "target";
  target: string;
  processOverride?: string;
  spawnGating?: boolean;
  childGating?: boolean;
  device?: DeviceSelector;
}

export type LaunchRequest = ProbeLaunch | TargetLaunch;

export interface LaunchResolution {
  options: SessionOptions;
  initialDisplay: string;
}

export interface SessionOptions {
  /** Manifest target name, or a path to an agent entry file. */
  target: string;
  /** Explicit process name — overrides the manifest `process`. */
  processOverride?: string;
  spawn?: boolean;
  /** Numeric attach target. Mutually exclusive with processOverride and spawn. */
  attachPid?: number;
  /** Stable label used while a numeric attach target's live name is resolved. */
  processDisplay?: string;
  /** Disable watch + hot-reload (one-shot eval mode). */
  noWatch?: boolean;
  /** Enable Device spawn gating during setup (pairs with onSpawn* events). */
  spawnGating?: boolean;
  /** Enable Session child gating after attach (pairs with onChild* events). */
  childGating?: boolean;
  /** Local, USB/mobile, known device id, or explicit remote endpoint. */
  device?: DeviceSelector;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unsupported launch field "${key}"`);
  }
}

function requireNonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(value: Record<string, unknown>, field: string): boolean | undefined {
  if (!hasOwn(value, field)) return undefined;
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "boolean") throw new Error(`${field} must be a boolean`);
  return candidate;
}

function optionalDevice(value: Record<string, unknown>): DeviceSelector | undefined {
  return hasOwn(value, "device") && value.device !== undefined
    ? normalizeDeviceSelector(value.device)
    : undefined;
}

/**
 * Validate a launch request without consulting the manifest, compiling,
 * or touching Frida, then adapt it to the compatibility SessionOptions API.
 */
export function resolveLaunchRequest(request: unknown): LaunchResolution {
  if (!isRecord(request) || !hasOwn(request, "kind")) {
    throw new Error("launch request must be an object with a kind");
  }

  switch (request.kind) {
    case "probe-attach-name": {
      requireExactKeys(request, ["kind", "process", "childGating", "device"]);
      const process = requireNonempty(hasOwn(request, "process") ? request.process : undefined, "process");
      const childGating = optionalBoolean(request, "childGating");
      const device = optionalDevice(request);
      return {
        options: {
          target: PROBE_ENTRY,
          processOverride: process,
          ...(childGating === undefined ? {} : { childGating }),
          ...(device === undefined ? {} : { device }),
        },
        initialDisplay: process,
      };
    }
    case "probe-attach-pid": {
      requireExactKeys(request, ["kind", "pid", "display", "childGating", "device"]);
      const pid = hasOwn(request, "pid") ? request.pid : undefined;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("pid must be a positive safe integer");
      }
      const initialDisplay = !hasOwn(request, "display") || request.display === undefined
        ? `pid:${pid}`
        : requireNonempty(request.display, "display");
      const childGating = optionalBoolean(request, "childGating");
      const device = optionalDevice(request);
      return {
        options: {
          target: PROBE_ENTRY,
          attachPid: pid,
          processDisplay: initialDisplay,
          ...(childGating === undefined ? {} : { childGating }),
          ...(device === undefined ? {} : { device }),
        },
        initialDisplay,
      };
    }
    case "probe-spawn": {
      requireExactKeys(request, ["kind", "executable", "device"]);
      const executable = requireNonempty(hasOwn(request, "executable") ? request.executable : undefined, "executable");
      const device = optionalDevice(request);
      return {
        options: { target: PROBE_ENTRY, processOverride: executable, spawn: true, ...(device ? { device } : {}) },
        initialDisplay: executable,
      };
    }
    case "target": {
      requireExactKeys(request, ["kind", "target", "processOverride", "spawnGating", "childGating", "device"]);
      const target = requireNonempty(hasOwn(request, "target") ? request.target : undefined, "target");
      const processOverride = !hasOwn(request, "processOverride") || request.processOverride === undefined
        ? undefined
        : requireNonempty(request.processOverride, "processOverride");
      const spawnGating = optionalBoolean(request, "spawnGating");
      const childGating = optionalBoolean(request, "childGating");
      const device = optionalDevice(request);
      return {
        options: {
          target,
          ...(processOverride === undefined ? {} : { processOverride }),
          ...(spawnGating === undefined ? {} : { spawnGating }),
          ...(childGating === undefined ? {} : { childGating }),
          ...(device === undefined ? {} : { device }),
        },
        initialDisplay: processOverride ?? target,
      };
    }
    default:
      throw new Error("unsupported launch kind");
  }
}

export interface SessionEvents extends LifecycleEvents {
  onLog(line: string): void;
  onError(line: string): void;
  onClose(reason: string): void;
  /** Structured agent payloads (`send({type, …})`) before they are flattened
   *  to log text — frontends that render level/tag/crash views subscribe
   *  here; plain-text frontends keep using onLog/onError only. */
  onEvent?(payload: Record<string, unknown>): void;
  /** Frida script exception/error message before plain-text flattening. */
  onAgentError?(detail: string): void;
}

/** Structured rpc export description, as returned by GameSession.describe(). */

export interface GameSession {
  readonly target: string;
  readonly process: string;
  readonly pid: number;
  readonly device: DeviceInfo;
  call(name: string, args: unknown[]): Promise<unknown>;
  /** Evaluate a JS snippet with rpc.exports + script/session/device in scope. */
  eval(src: string): Promise<unknown>;
  /** Names of the agent's rpc exports seen so far (best-effort). */
  rpcNames(): string[];
  /** Structured rpc surface reported by the agent's required `__describe()`. */
  describe(): Promise<RpcDescriptor[]>;
  close(): Promise<void>;
}

interface Resolved {
  entry: string;
  process: string;
  spawn: boolean;
  attachPid?: number;
}

function resolve(opts: SessionOptions, platform: string = process.platform): Resolved {
  if (typeof opts.target !== "string" || opts.target.trim().length === 0) {
    throw new Error("target must be a non-empty string");
  }
  const isProbe = opts.target === PROBE_ENTRY;
  if (isProbe && opts.spawnGating) {
    throw new Error("probe launches do not support spawn gating");
  }
  if (isProbe && opts.spawn && opts.childGating) {
    throw new Error("probe spawn cannot be combined with child gating");
  }
  if (opts.attachPid !== undefined) {
    if (!Number.isSafeInteger(opts.attachPid) || opts.attachPid <= 0) {
      throw new Error("attachPid must be a positive safe integer");
    }
    if (opts.spawn || opts.spawnGating) {
      throw new Error("numeric attach cannot be combined with spawn or spawn gating");
    }
    if (opts.processDisplay !== undefined && (typeof opts.processDisplay !== "string" || opts.processDisplay.trim().length === 0)) {
      throw new Error("processDisplay must be a non-empty string");
    }
    if (opts.processOverride !== undefined) {
      throw new Error("numeric attach cannot be combined with processOverride");
    }
  } else if (opts.processDisplay !== undefined) {
    throw new Error("processDisplay requires attachPid");
  }

  // A target containing a path separator or ending in .ts is an entry file,
  // not a manifest name — process must come from processOverride unless this
  // is a numeric attach.
  if (opts.target.includes("/") || opts.target.endsWith(".ts")) {
    if (opts.attachPid !== undefined) {
      return {
        entry: join(repoRoot(), opts.target),
        process: opts.processDisplay ?? `pid:${opts.attachPid}`,
        spawn: false,
        attachPid: opts.attachPid,
      };
    }
    if (!opts.processOverride) throw new Error("entry-file targets need --proc <process name>");
    return { entry: join(repoRoot(), opts.target), process: opts.processOverride, spawn: !!opts.spawn };
  }
  const cfg = getTarget(opts.target, undefined, platform);
  if (opts.attachPid !== undefined) {
    return {
      entry: join(repoRoot(), cfg.entry),
      process: opts.processDisplay ?? `pid:${opts.attachPid}`,
      spawn: false,
      attachPid: opts.attachPid,
    };
  }
  return {
    entry: join(repoRoot(), cfg.entry),
    process: opts.processOverride ?? cfg.process,
    spawn: opts.spawn || cfg.mode === "spawn",
  };
}

function configuredDevice(opts: SessionOptions): DeviceSelector {
  if (opts.device !== undefined) return normalizeDeviceSelector(opts.device);
  if (opts.target.includes("/") || opts.target.endsWith(".ts")) return { kind: "local" };
  return normalizeDeviceSelector(getTarget(opts.target, undefined, null).device);
}

/**
 * The configured name may be any of: the Frida process name (`Terraria`),
 * the Windows binary (`Terraria.exe`), or the macOS binary (`Terraria.bin.osx`).
 * Try the configured name, then a `.exe`/`.bin.*`-stripped variant,
 * case-insensitively, against the live process list.
 */
async function resolveProcess(device: frida.Device, configured: string): Promise<string> {
  if (!configured) throw new Error("no process name — pass --proc");
  const candidates = [configured];
  const stripped = configured.replace(/\.(exe|bin\.[a-z]+)$/i, "");
  if (stripped !== configured) candidates.push(stripped);
  try {
    const running = await device.enumerateProcesses();
    for (const c of candidates) {
      const hit = running.find((p) => p.name.toLowerCase() === c.toLowerCase());
      if (hit) return hit.name;
    }
  } catch { /* enumeration unsupported — fall through */ }
  return candidates[0]!;
}

/** Attach with an actionable error. On macOS, attaching to a hardened-runtime
 *  process without get-task-allow fails with a bare "unable to access process"
 *  unless Developer Mode is on or flab runs as root — say so. */
async function attach(device: frida.Device, target: string | number): Promise<frida.Session> {
  try {
    return await device.attach(target);
  } catch (e) {
    const msg = (e as Error).message;
    if (device.type === frida.DeviceType.Local && process.platform === "darwin" && /unable to access process/i.test(msg)) {
      throw new Error(
        `${msg} — macOS AMFI denied task_for_pid. Hardened-runtime target without get-task-allow: ` +
        `sudo /usr/sbin/DevToolsSecurity -enable, then REBOOT — Apple Silicon arms the AMFI policy at boot ` +
        `(sudo alone does not bypass it). Non-hardened targets attach as soon as Developer Mode is on.`,
      );
    }
    throw e;
  }
}
export async function startLaunch(request: LaunchRequest, ev: SessionEvents): Promise<GameSession> {
  return startSession(resolveLaunchRequest(request).options, ev);
}

export async function startSession(opts: SessionOptions, ev: SessionEvents): Promise<GameSession> {
  // Validate target/process before waiting for a device, then use the selected
  // device's platform for manifest processByPlatform resolution.
  resolve(opts);
  const selector = configuredDevice(opts);
  ev.onLog(`connecting device ${deviceSelectorLabel(selector)} …`);
  const device = await resolveDevice(selector);
  const deviceInfo = await describeDevice(device, selector);
  const { entry, process: configured, spawn: wantSpawn, attachPid } = resolve(
    opts,
    deviceInfo.platform ?? process.platform,
  );

  ev.onLog(`compiling ${opts.target} …`);
  let bundle = await compileEntry(entry);

  const gating = !!opts.spawnGating;
  let gatingEnabled = false;
  let unwatchLifecycle: () => void = () => {};
  let deviceLostConnected = false;
  let lifecycleReleased = false;
  let terminalSignaled = false;
  const notifyClosed = (reason: string): void => {
    if (terminalSignaled) return;
    terminalSignaled = true;
    ev.onClose(reason);
  };
  const onDeviceLost = (): void => notifyClosed("device-lost");
  // Device-global state (spawn gating) and signal subscriptions must always
  // be released — on close AND on any failure after they were taken.
  const releaseLifecycle = async (): Promise<void> => {
    if (lifecycleReleased) return;
    lifecycleReleased = true;
    if (deviceLostConnected) {
      try { device.lost.disconnect(onDeviceLost); } catch { /* best-effort */ }
      deviceLostConnected = false;
    }
    try { unwatchLifecycle(); } catch { /* best-effort */ }
    if (gatingEnabled) {
      try { await device.disableSpawnGating(); } catch { /* best-effort */ }
      gatingEnabled = false;
    }
  };

  let proc = "";
  let pid = 0;
  let spawned = false;
  let session!: frida.Session;
  let script!: frida.Script;
  let stopWatch: (() => void) | null = null;
  let closed = false;
  let reloadChain: Promise<void> = Promise.resolve();
  let describedExportNames: Set<string> | null = null;

  const onMessage = (m: frida.Message): void => {
    if (m.type === frida.MessageType.Send) {
      const p = m.payload as { type?: string; line?: string } | null;
      if (p && typeof p === "object") ev.onEvent?.(p as Record<string, unknown>);
      ev.onLog(p && p.type === "log" ? `[agent] ${p.line}` : `[send] ${JSON.stringify(p)}`);
    } else if (m.type === frida.MessageType.Error) {
      const detail = m.stack ?? m.description ?? "agent error";
      ev.onAgentError?.(detail);
      ev.onError(detail);
    }
  };

  const inject = async (src?: string): Promise<frida.Script> => {
    const s = await session.createScript(src ?? bundle);
    s.message.connect(onMessage);
    // Agent console.* bypasses `message` and hits frida's default logHandler,
    // which writes straight to host stdout — route it through ev so --json
    // stdout stays pure.
    s.logHandler = (level, text) => {
      const line = `[agent] ${text}`;
      if (level === frida.LogLevel.Error) ev.onError(line);
      else ev.onLog(line);
    };
    await s.load();
    return s;
  };

  const stopManagedInstruments = async (owner: frida.Script | undefined): Promise<void> => {
    if (!owner) return;
    try {
      const fn = (owner.exports as Record<string, unknown>).instrumentStopAll;
      if (typeof fn !== "function") return;
      const result = await (fn as () => Promise<unknown>)();
      if (result && typeof result === "object" && (result as { ok?: unknown }).ok === false) {
        ev.onError(`[instrument cleanup] ${JSON.stringify(result)}`);
      }
    } catch (error) {
      ev.onError(`[instrument cleanup failed] ${(error as Error).message}`);
    }
  };


  try {
    // Everything after device-global state was taken stays inside this
    // boundary so the catch can unwind all of it.
    if (gating) {
      await enableSpawnGating(device);
      gatingEnabled = true;
    }
    unwatchLifecycle = watchLifecycle(device, ev);
    device.lost.connect(onDeviceLost);
    deviceLostConnected = true;

    if (attachPid !== undefined) {
      pid = attachPid;
      proc = configured;
      ev.onLog(`attaching to ${proc} …`);
      session = await attach(device, pid);
      pid = session.pid;
      try {
        const live = await device.getProcessByPid(pid);
        if (live.name) proc = live.name;
      } catch { /* retain the stable PID display when lookup is unavailable */ }
    } else {
      proc = await resolveProcess(device, configured);
      if (wantSpawn) {
        ev.onLog(`spawning ${proc} …`);
        pid = await device.spawn(proc);
        spawned = true;
        session = await attach(device, pid);
      } else {
        ev.onLog(`attaching to ${proc} …`);
        session = await attach(device, proc);
        pid = session.pid;
      }
    }

    // Session-level child gating (frida 17): queue the target's children and
    // surface them via Device's childAdded signal. Released on close.
    if (opts.childGating) {
      await enableChildGating(session);
      ev.onLog("[+] child gating enabled");
    }
    script = await inject();
    if (wantSpawn) await device.resume(pid);
    ev.onLog(`[+] agent live in ${proc} (pid ${pid}) on ${deviceInfo.name} [${deviceInfo.id}]`);

    if (!opts.noWatch) {
      stopWatch = await watchEntry(
        entry,
        (next) => {
          // The watcher fires once with the initial build — identical source,
          // nothing to do.
          if (next === bundle) return;
          // Serialize reloads: an overlapping reload would leak the loser
          // script and could install a stale bundle last. The task captures
          // its own bundle; `bundle` is only the fallback for close-time
          // state. closed is re-checked after inject() because close() may
          // interleave while we await.
          reloadChain = reloadChain.then(async () => {
            if (closed) return;
            try {
              const s = await inject(next);
              if (closed) {
                await stopManagedInstruments(s);
                try { await s.unload(); } catch { /* */ }
                return;
              }
              try {
                await stopManagedInstruments(script);
                await script.unload();
              } catch (e) {
                // Old script would not die: keep it as the live agent and
                // discard the new one so exactly one agent stays loaded.
                try { await s.unload(); } catch { /* */ }
                ev.onError(`[old script unload failed — keeping previous agent] ${(e as Error).message}`);
                return;
              }
              bundle = next;
              script = s;
              describedExportNames = null;
              ev.onLog("[hot-reloaded]");
            } catch (e) { ev.onError(`[reload failed] ${(e as Error).message}`); }
          });
        },
        (msg) => ev.onError(`[compile] ${msg.trim()}`),
      ).catch((e: Error) => { ev.onError(`[watch disabled] ${e.message}`); return null; });
    }

    session.detached.connect((reason) => { if (!closed) notifyClosed(String(reason)); });
  } catch (e) {
    // Failure after device-global state was taken: unwind in reverse order.
    stopWatch?.();
    await stopManagedInstruments(script);
    try { await script?.unload(); } catch { /* */ }
    try { await session?.detach(); } catch { /* */ }
    // A process we spawned but never resumed would stay suspended forever —
    // kill it (attach mode never sets spawned, so this cannot kill a user's
    // already-running game).
    if (spawned && pid) { try { await device.kill(pid); } catch { /* */ } }
    await releaseLifecycle();
    throw e;
  }

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;

  const seenExports: string[] = [];

  const self: GameSession = {
    target: opts.target,
    process: proc,
    pid,
    device: deviceInfo,
    async call(name, args) {
      const fn = (script.exports as Record<string, unknown>)[name];
      if (typeof fn !== "function") throw new Error(`no rpc export "${name}" (have: ${self.rpcNames().join(", ")})`);
      if (!seenExports.includes(name)) seenExports.push(name);
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    async eval(src) {
      // Frida's exports Proxy reports arbitrary names through `in`, so using
      // it directly as a `with` scope shadows globals such as Promise and
      // setTimeout. Build an allowlist from __describe() first: RPC names stay
      // convenient while normal JavaScript globals keep their real values.
      if (describedExportNames === null) await self.describe();
      const allowed = describedExportNames ?? new Set<string>();
      const host = { script, session, device, frida };
      const ctx = new Proxy(script.exports as Record<string, unknown>, {
        has: (_target, key) => key in host || (typeof key === "string" && allowed.has(key)),
        get: (target, key) => key in host
          ? (host as Record<string | symbol, unknown>)[key]
          : typeof key === "string" && allowed.has(key)
            ? target[key]
            : undefined,
      });
      return new AsyncFunction("ctx", `with (ctx) { return (${src}); }`)(ctx);
    },
    rpcNames() {
      return [...new Set([...(describedExportNames ?? []), ...seenExports])];
    },
    async describe() {
      const fn = (script.exports as Record<string, unknown>).__describe;
      if (typeof fn !== "function") {
        throw new Error('agent does not expose the required rpc export "__describe"');
      }
      const raw = await (fn as () => Promise<unknown>)();
      if (!Array.isArray(raw)) {
        throw new Error('rpc export "__describe" returned a non-array descriptor inventory');
      }
      describedExportNames = new Set(raw.flatMap((entry) =>
        entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
          ? [(entry as { name: string }).name]
          : []));
      const normalized = normalizeRpcDescriptors(raw);
      for (const warning of normalized.warnings) ev.onError(`[descriptor] ${warning}`);
      return normalized.descriptors.map((descriptor): RpcDescriptor => ({
        name: descriptor.name,
        args: descriptor.args.map((arg) => ({ ...arg })),
        ...(descriptor.doc ? { doc: descriptor.doc } : {}),
        capabilities: [...descriptor.capabilities],
        effect: descriptor.effect,
        returns: descriptor.returns,
        ...(descriptor.statusAction ? { statusAction: descriptor.statusAction } : {}),
      }));
    },
    async close() {
      closed = true;
      stopWatch?.();
      // Join any in-flight reload before tearing down: it re-checks closed
      // and unloads its own script, so after this await no reload can still
      // touch the session.
      await reloadChain;
      await releaseLifecycle();
      await stopManagedInstruments(script);
      try { await script.unload(); } catch { /* */ }
      if (opts.childGating) { try { await session.disableChildGating(); } catch { /* */ } }
      try { await session.detach(); } catch { /* */ }
    },
  };
  return self;
}

/**
 * Programmatic one-shot: compile, attach, inject, evaluate `src`, close.
 * Shared by `flab run --eval` and `flab probe` so neither reaches through the
 * other's command implementation. Lifecycle/log lines go to `ev` when given.
 */
export async function evalOnce(
  opts: SessionOptions,
  src: string,
  ev?: Partial<SessionEvents>,
): Promise<unknown> {
  // Forward every caller-provided handler; only onClose is suppressed (the
  // one-shot initiates the close itself, so it is never an external event).
  const quiet: SessionEvents = {
    ...ev,
    onLog: (l) => ev?.onLog?.(l),
    onError: (l) => ev?.onError?.(l),
    onClose: () => { /* one-shot: close is initiated by us */ },
  };
  const session = await startSession({ ...opts, noWatch: true }, quiet);
  try {
    return await session.eval(src);
  } finally {
    await session.close();
  }
}
