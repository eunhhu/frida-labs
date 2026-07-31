// The one and only runtime — everything goes through the Frida core TS backend
// (the `frida` npm module). This single process:
//   1. compiles the chosen target's agent to _agent.js (frida-compile, one-shot)
//   2. attaches or spawns the process via frida-node and injects the agent
//   3. watch-recompiles on source edits and hot-reloads the script in place
//   4. gives you a REPL where the agent's rpc.exports are callable by bare name
//
//   bun run start                 # default target
//   bun run start mecchachameleon # explicit
//   bun run start piu --spawn     # spawn instead of attach
//   bun run build meccha          # compile only, no inject (via `--build`)

import * as frida from "frida";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFile, watch } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { targets, DEFAULT_TARGET, AGENT_OUT, type TargetName } from "./config.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const name = (positional[0] ?? process.env.TARGET ?? DEFAULT_TARGET) as TargetName;
const cfg = targets[name];
if (!cfg) {
  console.error(c.red(`unknown target "${name}". known: ${Object.keys(targets).join(", ")}`));
  process.exit(1);
}
const buildOnly = flags.has("--build");
const noWatch = flags.has("--no-watch") || buildOnly;
const spawnTarget = flags.has("--spawn") || (cfg.mode as string) === "spawn";

const FC = "node_modules/frida-compile/dist/cli.js";

function compileOnce(): boolean {
  console.log(c.dim(`compiling ${cfg.entry} → ${AGENT_OUT} …`));
  const r = spawnSync("bun", [FC, cfg.entry, "-o", AGENT_OUT], { stdio: "inherit" });
  return r.status === 0;
}

function startWatcher(): ChildProcess {
  // rebuilds _agent.js on source edits; the fs.watch below turns that into a hot reload
  return spawn("bun", [FC, cfg.entry, "-o", AGENT_OUT, "-w"], { stdio: ["ignore", "ignore", "inherit"] });
}

async function main(): Promise<void> {
  if (!compileOnce()) { console.error(c.red("compile failed")); process.exit(1); }
  if (buildOnly) { console.log(c.green(`[+] built ${AGENT_OUT}`)); process.exit(0); }
  if (!existsSync(AGENT_OUT)) { console.error(c.red(`${AGENT_OUT} missing after compile`)); process.exit(1); }

  const device = await frida.getLocalDevice();

  let pid: number;
  let session: frida.Session;
  if (spawnTarget) {
    console.log(c.dim(`spawning ${cfg.process} …`));
    pid = await device.spawn(cfg.process);
    session = await device.attach(pid);
  } else {
    console.log(c.dim(`attaching to ${cfg.process} …`));
    session = await device.attach(cfg.process);
    pid = session.pid;
  }
  session.detached.connect((reason) => { console.log(c.yellow(`\n[session detached: ${reason}]`)); process.exit(0); });

  const onMessage = (m: frida.Message): void => {
    if (m.type === frida.MessageType.Send) {
      const p = m.payload;
      if (p && p.type === "log") console.log(c.dim("[agent]"), p.line);
      else console.log(c.cyan("[send]"), inspect(p, { colors: true, depth: 4 }));
    } else if (m.type === frida.MessageType.Error) {
      console.error(c.red("[agent error]"), m.stack ?? m.description);
    }
  };

  const inject = async (): Promise<frida.Script> => {
    const s = await session.createScript(await readFile(AGENT_OUT, "utf8"));
    s.message.connect(onMessage);
    await s.load();
    return s;
  };

  let script = await inject();
  if (spawnTarget) await device.resume(pid);
  console.log(c.green(`[+] agent injected into ${cfg.process} (pid ${pid})`));

  // watch-recompile + hot reload, all in this one process
  const watcher = noWatch ? null : startWatcher();
  if (!noWatch) {
    (async () => {
      try {
        for await (const _ of watch(AGENT_OUT)) {
          await new Promise((r) => setTimeout(r, 120)); // debounce partial writes
          try {
            const next = await inject();
            try { await script.unload(); } catch { /* */ }
            script = next;
            console.log(c.green("[↻ hot-reloaded]"));
          } catch (e) { console.error(c.red("[reload failed]"), (e as Error).message); }
        }
      } catch { /* watch ended */ }
    })();
  }

  // REPL — agent rpc.exports callable by bare name (e.g. `await espInstall()`)
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: c.green(`${name}> `) });
  const quit = async (): Promise<void> => { watcher?.kill(); try { await script.unload(); } catch { /* */ } process.exit(0); };
  console.log(c.dim("REPL ready — try `await info()`   ·   .exit to quit"));
  rl.prompt();
  rl.on("line", async (line) => {
    const src = line.trim();
    if (src === ".exit" || src === ".quit") return void rl.close();
    if (src) {
      try {
        const ctx = { ...(script.exports as Record<string, unknown>), script, session, device, frida };
        const result = await new AsyncFunction("ctx", `with (ctx) { return (${src}); }`)(ctx);
        if (result !== undefined) console.log(inspect(result, { colors: true, depth: 5 }));
      } catch (e) { console.error(c.red((e as Error).message)); }
    }
    rl.prompt();
  });
  rl.on("close", quit);
}

main().catch((e) => { console.error(c.red("fatal:"), e); process.exit(1); });
