// Target scaffolding — `flab new <name>`. Creates agent/targets/<name>/index.ts
// and registers the target in frida-labs.json. Pure data, no shell.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, addTarget } from "./manifest.js";

const TEMPLATE = (name: string) => `// Target entry: ${name} — compiled and injected by flab.
// rpc.exports is the whole control surface: every function is callable from
// the CLI (flab run ${name}) and the TUI by bare name.
//
// Reusable engines live in ../../lib/ (mem, hook, search, mono, ue, il2cpp,
// detect, watch, strings, cocos) — run \`flab lib\` for the full API surface.
// Keep game-specific glue here; push anything reusable into lib/.

import { ok } from "../../lib/log.js";
import { detectAll } from "../../lib/detect.js";

const engines = detectAll();
for (const e of engines) ok(\`[${name}] detected \${e.label} @ \${e.module.name}\`);

rpc.exports = {
  /** Sanity check — what the agent sees in this process. */
  ping(): string {
    return \`alive; engines: \${engines.map((e) => e.id).join(", ") || "none"}\`;
  },
  /** Structured rpc surface — consumed by the host describe() (TUI explorer lands in Phase C). */
  __describe(): unknown {
    return [
      { name: "ping", doc: "Sanity check — what the agent sees" },
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};
`;

export interface ScaffoldResult {
  name: string;
  entry: string;
  process: string;
}

export function scaffold(name: string, processName?: string): ScaffoldResult {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error("target name must be lowercase letters/digits/-/_, starting with a letter");
  }
  const dir = join(repoRoot(), "agent", "targets", name);
  if (existsSync(dir)) throw new Error(`target "${name}" already exists at agent/targets/${name}/`);

  const proc = processName ?? `${name[0]!.toUpperCase()}${name.slice(1)}.exe`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), TEMPLATE(name));
  const entry = `agent/targets/${name}/index.ts`;
  addTarget(name, { process: proc, mode: "attach", entry });
  return { name, entry, process: proc };
}
