// Command registry — the single source of truth for everything flab can do.
// The CLI maps argv onto this; the TUI renders menus from it. Adding a
// command here makes it available to both frontends and to the skill docs.

import { listTargets, loadManifest } from "./manifest.js";
import { scaffold } from "./scaffold.js";
import { AGENT_OUT, compileAgent } from "./compile.js";
import { evalOnce, startSession } from "./session.js";
import { libReference, renderLibText } from "./libref.js";
import { depcheck } from "./depcheck.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./manifest.js";
import { createInterface } from "node:readline";
import { inspect } from "node:util";

export interface CmdCtx {
  json: boolean;
  out(line: string): void;
  err(line: string): void;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  /** For agents: exact flags and output contract. */
  detail?: string;
  run(args: string[], flags: Record<string, string | boolean>, ctx: CmdCtx): Promise<number>;
}


export const commands: Command[] = [
  {
    name: "targets",
    usage: "flab targets [--json]",
    summary: "List registered targets (name, process, mode, entry).",
    async run(_a, _f, ctx) {
      const m = loadManifest();
      const rows = Object.entries(m.targets).map(([name, t]) => ({ name, ...t }));
      if (ctx.json) ctx.out(JSON.stringify(rows, null, 2));
      else for (const r of rows) ctx.out(`${r.name.padEnd(20)} ${r.process.padEnd(32)} ${r.mode.padEnd(7)} ${r.entry}`);
      return 0;
    },
  },
  {
    name: "new",
    usage: "flab new <name> [\"Game.exe\"] [--proc \"Game.exe\"] [--json]",
    summary: "Scaffold a new target and register it in frida-labs.json.",
    detail: "Creates agent/targets/<name>/index.ts with a detect+ping starter and adds a manifest entry.",
    async run(args, flags, ctx) {
      const name = args[0];
      if (!name) { ctx.err("usage: flab new <name> [\"Game.exe\"] [--proc \"Game.exe\"]"); return 1; }
      // Positional process name (documented form) wins; --proc is the flag form.
      const r = scaffold(name, args[1] ?? (typeof flags.proc === "string" ? flags.proc : undefined));
      ctx.out(ctx.json ? JSON.stringify(r) : `[+] ${r.entry}  (process: ${r.process})`);
      return 0;
    },
  },
  {
    name: "build",
    usage: "flab build <target> [--out file]",
    summary: "Compile a target's agent bundle without injecting.",
    async run(args, flags, ctx) {
      const target = args[0];
      if (!target) { ctx.err("usage: flab build <target>"); return 1; }
      const bundle = await compileAgent(target);
      const out = typeof flags.out === "string" ? flags.out : AGENT_OUT;
      writeFileSync(join(repoRoot(), out), bundle);
      ctx.out(ctx.json ? JSON.stringify({ target, out, bytes: bundle.length }) : `[+] built ${out} (${bundle.length} bytes)`);
      return 0;
    },
  },
  {
    name: "run",
    usage: "flab run <target> [--proc P] [--spawn] [--eval \"code\"] [--no-watch] [--json]",
    summary: "Compile, attach, inject, then REPL (or one-shot --eval). Hot reload on save.",
    detail: [
      "One-shot mode for agents: flab run <target> --no-watch --eval 'await ping()' --json",
      "The eval snippet runs with the agent's rpc.exports in scope (call by bare name).",
      "<target> may also be an agent entry path (agent/targets/_probe/index.ts) with --proc.",
    ].join("\n"),
    async run(args, flags, ctx) {
      const target = args[0];
      if (!target) { ctx.err("usage: flab run <target> [--eval code]"); return 1; }
      const oneShot = typeof flags.eval === "string";
      const opts = {
        target,
        processOverride: typeof flags.proc === "string" ? flags.proc : undefined,
        spawn: !!flags.spawn,
        noWatch: !!flags["no-watch"] || oneShot,
      };

      if (oneShot) {
        try {
          const result = await evalOnce(opts, flags.eval as string, {
            // --json keeps stdout pure: logs go to stderr.
            onLog: (l) => (ctx.json ? ctx.err(l) : ctx.out(l)),
            onError: (l) => ctx.err(l),
          });
          ctx.out(ctx.json ? JSON.stringify({ result }) : inspect(result, { colors: false, depth: 6 }));
          return 0;
        } catch (e) {
          ctx.err((e as Error).message);
          return 1;
        }
      }

      const session = await startSession(opts, {
        onLog: (l) => ctx.out(l),
        onError: (l) => ctx.err(l),
        onClose: (reason) => { ctx.out(`[detached: ${reason}]`); process.exit(0); },
      });

      ctx.out(`REPL ready — rpc exports: ${session.rpcNames().join(", ") || "(none)"} · .exit to quit`);
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${target}> ` });
      rl.prompt();
      rl.on("line", async (line) => {
        const src = line.trim();
        if (src === ".exit" || src === ".quit") return void rl.close();
        if (src) {
          try {
            const r = await session.eval(src);
            if (r !== undefined) ctx.out(inspect(r, { colors: true, depth: 6 }));
          } catch (e) { ctx.err((e as Error).message); }
        }
        rl.prompt();
      });
      rl.on("close", async () => { await session.close(); process.exit(0); });
      return 0;
    },
  },
  {
    name: "probe",
    usage: "flab probe <process> [--spawn] [--eval \"code\"] [--json]",
    summary: "Inject the engine-agnostic probe agent into any process and report what it sees.",
    detail: "Default eval prints engines(); pass --eval to run any rpc (modules, scan, strings, monoClasses…).",
    async run(args, flags, ctx) {
      const proc = args[0];
      if (!proc) { ctx.err("usage: flab probe <process>"); return 1; }
      const evalSrc = typeof flags.eval === "string" ? flags.eval : "await engines()";
      try {
        const result = await evalOnce(
          { target: "agent/targets/_probe/index.ts", processOverride: proc, spawn: !!flags.spawn },
          evalSrc,
          { onLog: (l) => (ctx.json ? ctx.err(l) : ctx.out(l)), onError: (l) => ctx.err(l) },
        );
        ctx.out(ctx.json ? JSON.stringify({ result }) : inspect(result, { colors: false, depth: 6 }));
        return 0;
      } catch (e) {
        ctx.err((e as Error).message);
        return 1;
      }
    },
  },
  {
    name: "lib",
    usage: "flab lib [--json]",
    summary: "Print the agent/lib API surface (modules, functions, docs) — extracted from source.",
    async run(_a, _f, ctx) {
      const mods = libReference();
      ctx.out(ctx.json ? JSON.stringify(mods, null, 2) : renderLibText(mods));
      return 0;
    },
  },
  {
    name: "depcheck",
    usage: "flab depcheck [--json]",
    summary: "Fail when any target imports outside agent/lib (zero exceptions).",
    detail: "Targets must depend only on agent/lib. Violations exit 1.",
    async run(_a, _f, ctx) {
      const r = depcheck();
      if (ctx.json) {
        ctx.out(JSON.stringify(r, null, 2));
      } else {
        ctx.out(`scanned ${r.scanned} import edge(s) across agent/targets`);
        for (const v of r.violations) {
          ctx.out(`✗ violation  ${v.file}:${v.line}  "${v.specifier}"  — targets may only import agent/lib`);
        }
      }
      return r.violations.length ? 1 : 0;
    },
  },
  {
    name: "doctor",
    usage: "flab doctor [--json]",
    summary: "Environment check: runtime, frida version, reachable device, manifest sanity.",
    async run(_a, _f, ctx) {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      checks.push({ name: "runtime", ok: true, detail: `${process.version} (${process.platform}/${process.arch})` });
      try {
        const frida = (await import("frida")).default;
        const dev = await frida.getLocalDevice();
        const params = await dev.querySystemParameters().catch(() => null);
        const version = (params as { version?: string } | null)?.version ?? "unknown";
        checks.push({ name: "frida", ok: true, detail: `server ${version}` });
        const procs = await dev.enumerateProcesses();
        checks.push({ name: "device", ok: true, detail: `local device reachable, ${procs.length} processes visible` });
      } catch (e) { checks.push({ name: "frida", ok: false, detail: (e as Error).message }); }
      try {
        const m = loadManifest();
        checks.push({ name: "manifest", ok: true, detail: `${Object.keys(m.targets).length} targets` });
      } catch (e) { checks.push({ name: "manifest", ok: false, detail: (e as Error).message }); }
      if (ctx.json) ctx.out(JSON.stringify(checks, null, 2));
      else for (const c of checks) ctx.out(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(10)} ${c.detail}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    },
  },
];

export function renderHelp(): string {
  const lines = ["flab — cross-game Frida workspace tool", "", "commands:"];
  for (const c of commands) {
    lines.push(`  ${c.usage}`);
    lines.push(`      ${c.summary}`);
  }
  lines.push("", "  flab tui [target]      interactive ink UI for humans");
  lines.push("  flab <cmd> --json      machine-readable output for agents");
  return lines.join("\n");
}
