// Lib API reference — extracts the public surface of agent/lib/ straight from
// source, so `flab lib` and the agent skill docs can never drift out of sync
// with the code. Regex-based on purpose: lib modules are flat files of
// exported functions/objects, and a full TS AST is overkill here.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "./manifest.js";

export interface LibFunction {
  name: string;
  signature: string;
  doc: string;
}

export interface LibModule {
  /** e.g. "mem", "mono/index", "ue/actor" */
  module: string;
  /** File header comment, if any. */
  about: string;
  functions: LibFunction[];
}

/** Import path a target would use, e.g. ../../lib/mem.js */
export function importPath(mod: LibModule): string {
  return `../../lib/${mod.module.replace(/\.ts$/, "").replace(/\/index$/, "/index.js").replace(/^(?!.*\.js$)/, (m) => m + ".js")}`;
}

function collect(dir: string, base: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collect(p, base, out);
    else if (e.endsWith(".ts") && e !== "index.ts") out.push(relative(base, p));
    else if (e === "index.ts") out.push(relative(base, p));
  }
}

const FN_RE = /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?\(|[<(])([^\n]*)/;
const METHOD_RE = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\([^)]*\)[^{:=]*)[:=]/;

function parseFile(abs: string, rel: string): LibModule {
  const src = readFileSync(abs, "utf8");
  const lines = src.split("\n");
  const mod: LibModule = { module: rel.replace(/\.ts$/, ""), about: "", functions: [] };

  // header comment block
  const header: string[] = [];
  for (const l of lines) {
    if (l.startsWith("//")) header.push(l.replace(/^\/\/\s?/, ""));
    else if (l.trim() === "") { if (header.length) break; }
    else break;
  }
  mod.about = header.join("\n").trim();

  let pendingDoc = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const docMatch = line.match(/^\s*\/\*\*\s*(.*?)\s*\*?\/?$/);
    if (docMatch) { pendingDoc = docMatch[1] ?? ""; continue; }

    const fn = line.match(FN_RE);
    if (fn) {
      let sig = line.replace(/^\s*export\s+(?:declare\s+)?/, "").replace(/\s*[{;]\s*$/, "").trim();
      // multi-line signatures: keep consuming until parens balance
      let depth = (sig.match(/[([{]/g) ?? []).length - (sig.match(/[)\]}]/g) ?? []).length;
      while (depth > 0 && i + 1 < lines.length) {
        sig += " " + lines[++i]!.trim().replace(/\s*[{;]\s*$/, "");
        depth = (sig.match(/[([{]/g) ?? []).length - (sig.match(/[)\]}]/g) ?? []).length;
      }
      mod.functions.push({ name: fn[1]!, signature: sig, doc: pendingDoc });
      pendingDoc = "";
      continue;
    }

    const method = line.match(METHOD_RE);
    if (method) {
      mod.functions.push({ name: method[1]!, signature: `${method[1]}${method[2]!.trim()}`, doc: pendingDoc });
      pendingDoc = "";
      continue;
    }
    if (line.trim() && !line.trim().startsWith("*") && !line.trim().startsWith("//")) pendingDoc = pendingDoc; // keep doc across blank-ish lines
  }
  return mod;
}

/** All lib modules with their public functions, in stable order. */
export function libReference(): LibModule[] {
  const libDir = join(repoRoot(), "agent", "lib");
  const files: string[] = [];
  collect(libDir, libDir, files);
  return files.sort().map((rel) => parseFile(join(libDir, rel), rel));
}

/** Human-readable rendering. */
export function renderLibText(mods: LibModule[]): string {
  const out: string[] = [];
  for (const m of mods) {
    out.push(`\n## agent/lib/${m.module}.ts`);
    if (m.about) out.push(m.about.split("\n")[0]!);
    for (const f of m.functions) out.push(`  ${f.signature}${f.doc ? `  — ${f.doc}` : ""}`);
  }
  return out.join("\n");
}
