// Session engine — attach/spawn + inject + hot-reload + rpc. Shared by the
// CLI frontend and the TUI frontend; contains no UI code.

import frida from "frida";
import { join } from "node:path";
import { getTarget, repoRoot } from "./manifest.js";
import { compileEntry, watchEntry } from "./compile.js";
import { enableSpawnGating, watchLifecycle, type LifecycleEvents } from "./lifecycle.js";

export interface SessionOptions {
  /** Manifest target name, or a path to an agent entry file. */
  target: string;
  /** Explicit process name — overrides the manifest `process`. */
  processOverride?: string;
  spawn?: boolean;
  /** Disable watch + hot-reload (one-shot eval mode). */
  noWatch?: boolean;
  /** Enable Device spawn gating during setup (pairs with onSpawn* events). */
  spawnGating?: boolean;
}

export interface SessionEvents extends LifecycleEvents {
  onLog(line: string): void;
  onError(line: string): void;
  onClose(reason: string): void;
}

/** Structured rpc export description, as returned by GameSession.describe(). */
export interface RpcDescriptor {
  name: string;
  args?: Array<{ name: string; type?: string }>;
  doc?: string;
}

export interface GameSession {
  readonly target: string;
  readonly process: string;
  readonly pid: number;
  call(name: string, args: unknown[]): Promise<unknown>;
  /** Evaluate a JS snippet with rpc.exports + script/session/device in scope. */
  eval(src: string): Promise<unknown>;
  /** Names of the agent's rpc exports seen so far (best-effort). */
  rpcNames(): string[];
  /** Structured rpc surface: the agent's `__describe()` normalized to
   *  RpcDescriptor[] — falls back to seen export names when the target does
   *  not implement __describe or it fails. */
  describe(): Promise<RpcDescriptor[]>;
  close(): Promise<void>;
}

interface Resolved {
  entry: string;
  process: string;
  spawn: boolean;
}

function resolve(opts: SessionOptions): Resolved {
  // A target containing a path separator or ending in .ts is an entry file,
  // not a manifest name — process must come from processOverride.
  if (opts.target.includes("/") || opts.target.endsWith(".ts")) {
    if (!opts.processOverride) throw new Error("entry-file targets need --proc <process name>");
    return { entry: join(repoRoot(), opts.target), process: opts.processOverride, spawn: !!opts.spawn };
  }
  const cfg = getTarget(opts.target);
  return {
    entry: join(repoRoot(), cfg.entry),
    process: opts.processOverride ?? cfg.process,
    spawn: opts.spawn || cfg.mode === "spawn",
  };
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
    if (process.platform === "darwin" && /unable to access process/i.test(msg)) {
      throw new Error(
        `${msg} — macOS AMFI denied task_for_pid. Hardened-runtime target without get-task-allow: ` +
        `sudo /usr/sbin/DevToolsSecurity -enable, then REBOOT — Apple Silicon arms the AMFI policy at boot ` +
        `(sudo alone does not bypass it). Non-hardened targets attach as soon as Developer Mode is on.`,
      );
    }
    throw e;
  }
}
export async function startSession(opts: SessionOptions, ev: SessionEvents): Promise<GameSession> {
  const { entry, process: configured, spawn: wantSpawn } = resolve(opts);

  ev.onLog(`compiling ${opts.target} …`);
  let bundle = await compileEntry(entry);

  const device = await frida.getLocalDevice();
  const gating = !!opts.spawnGating;
  if (gating) await enableSpawnGating(device);
  const unwatchLifecycle = watchLifecycle(device, ev);
  let lifecycleReleased = false;
  // Device-global state (spawn gating) and signal subscriptions must always
  // be released — on close AND on any failure after they were taken.
  const releaseLifecycle = async (): Promise<void> => {
    if (lifecycleReleased) return;
    lifecycleReleased = true;
    unwatchLifecycle();
    if (gating) {
      try { await device.disableSpawnGating(); } catch { /* best-effort */ }
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

  const onMessage = (m: frida.Message): void => {
    if (m.type === frida.MessageType.Send) {
      const p = m.payload as { type?: string; line?: string } | null;
      ev.onLog(p && p.type === "log" ? `[agent] ${p.line}` : `[send] ${JSON.stringify(p)}`);
    } else if (m.type === frida.MessageType.Error) {
      ev.onError(m.stack ?? m.description ?? "agent error");
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

  try {
    // Everything after device-global state was taken stays inside this
    // boundary so the catch can unwind all of it.
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

    script = await inject();
    if (wantSpawn) await device.resume(pid);
    ev.onLog(`[+] agent live in ${proc} (pid ${pid})`);

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
              if (closed) { try { await s.unload(); } catch { /* */ } return; }
              try {
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
              ev.onLog("[hot-reloaded]");
            } catch (e) { ev.onError(`[reload failed] ${(e as Error).message}`); }
          });
        },
        (msg) => ev.onError(`[compile] ${msg.trim()}`),
      ).catch((e: Error) => { ev.onError(`[watch disabled] ${e.message}`); return null; });
    }

    session.detached.connect((reason) => { if (!closed) ev.onClose(String(reason)); });
  } catch (e) {
    // Failure after device-global state was taken: unwind in reverse order.
    stopWatch?.();
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
    async call(name, args) {
      const fn = (script.exports as Record<string, unknown>)[name];
      if (typeof fn !== "function") throw new Error(`no rpc export "${name}" (have: ${self.rpcNames().join(", ")})`);
      if (!seenExports.includes(name)) seenExports.push(name);
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    async eval(src) {
      // script.exports is a Proxy with no enumerable own keys, so spread and
      // Object.keys see nothing — but its `has`/`get` traps work, which is
      // all `with` needs. Layer it under the host-side extras so rpc names
      // resolve bare (`await cmd("heal")`).
      const host = { script, session, device, frida };
      const ctx = new Proxy(script.exports as Record<string, unknown>, {
        has: (t, k) => k in t || k in host,
        get: (t, k) => (k in host ? (host as Record<string | symbol, unknown>)[k] : t[k as keyof typeof t]),
      });
      return new AsyncFunction("ctx", `with (ctx) { return (${src}); }`)(ctx);
    },
    rpcNames() {
      // Frida can't enumerate a script's exports host-side; the convention is
      // that targets expose `__describe()` listing their rpc surface.
      // Synchronously we can only report what we've seen called.
      return seenExports;
    },
    async describe() {
      // Fallback (seen export names) applies only when the target does not
      // implement __describe at all or it fails — a valid array, even an
      // empty one, is authoritative.
      const fallback = seenExports.map((name) => ({ name }));
      try {
        const fn = (script.exports as Record<string, unknown>).__describe;
        if (typeof fn !== "function") return fallback;
        const raw = await (fn as () => Promise<unknown>)();
        if (!Array.isArray(raw)) return fallback;
        const out: RpcDescriptor[] = [];
        for (const item of raw as unknown[]) {
          if (typeof item === "string" && item) {
            out.push({ name: item });
          } else if (item && typeof item === "object" && typeof (item as RpcDescriptor).name === "string" && (item as RpcDescriptor).name) {
            const d = item as RpcDescriptor;
            // args must satisfy RpcDescriptor's contract element-wise;
            // a malformed args array is dropped, never passed through.
            const argsOk = Array.isArray(d.args) && d.args.every(
              (a) => a && typeof a === "object"
                && typeof (a as { name?: unknown }).name === "string"
                && ((a as { name: string }).name).length > 0
                && ((a as { type?: unknown }).type === undefined
                  || typeof (a as { type?: unknown }).type === "string"),
            );
            out.push({
              name: d.name,
              ...(argsOk ? { args: d.args } : {}),
              ...(typeof d.doc === "string" ? { doc: d.doc } : {}),
            });
          }
          // malformed entries are dropped, never thrown
        }
        return out;
      } catch {
        return fallback;
      }
    },
    async close() {
      closed = true;
      stopWatch?.();
      // Join any in-flight reload before tearing down: it re-checks closed
      // and unloads its own script, so after this await no reload can still
      // touch the session.
      await reloadChain;
      await releaseLifecycle();
      try { await script.unload(); } catch { /* */ }
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
