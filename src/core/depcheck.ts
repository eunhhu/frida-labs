// Dependency-direction checker — enforces "targets depend only on agent/lib".
// Scans agent/targets/** for import edges; every edge must resolve under
// agent/lib. Zero exceptions: the Phase-A/B pinned allowlist (terraria
// ./mono.js, mecchachameleon ./esp.js, piu frida-il2cpp-bridge) was fully
// absorbed in Phase B (b1 mono consolidation, b2 esp/il2cpp moves).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { repoRoot } from "./manifest.js";

export interface ImportEdge {
  /** Repo-relative importing file. */
  file: string;
  line: number;
  specifier: string;
  /** Repo-relative resolution target for relative specifiers, else null. */
  resolved: string | null;
}

export interface DepcheckReport {
  /** Edges outside agent/lib — the gate fails on any of these. */
  violations: ImportEdge[];
  scanned: number;
}


/**
 * Extract module specifiers with a small token-aware scanner — never a regex
 * over raw text. One stack machine records "dead" ranges (comments, string
 * literals, and raw template text; ${…} interiors of templates stay live
 * code), then a keyword matcher with identifier boundaries — the (?<![\w$.])
 * lookbehind kills myrequire(/obj.require(/myimport( — parses each construct
 * positionally: the specifier is the literal read at the expected slot, never
 * "the last quoted string in a matched span". Non-literal arguments
 * (require(name), import(`./${x}`)) are unanalyzable and reported as the
 * "(dynamic)" specifier so they cannot bypass the gate silently.
 *
 * Known heuristic limit: regex literals containing quotes/backticks (e.g.
 * /`/) can confuse the state machine — typescript@7 (tsgo) ships no classic
 * AST API, so this stays a scanner. No target file uses such literals.
 */

interface Dead { start: number; end: number; }

type Frame =
  | { m: "code"; d: number }
  | { m: "line" }
  | { m: "block" }
  | { m: "str"; q: string }
  | { m: "tmpl" };

function deadRanges(src: string): Dead[] {
  const ranges: Dead[] = [];
  const stack: Frame[] = [{ m: "code", d: 0 }];
  const top = (): Frame => stack[stack.length - 1];
  let start = -1;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const nx = src[i + 1];
    const t = top();
    if (t.m === "line") {
      if (c === "\n") { ranges.push({ start, end: i + 1 }); stack.pop(); }
      i++;
      continue;
    }
    if (t.m === "block") {
      if (c === "*" && nx === "/") { ranges.push({ start, end: i + 2 }); i += 2; stack.pop(); }
      else i++;
      continue;
    }
    if (t.m === "str") {
      if (c === "\\") { i += 2; continue; }
      if (c === t.q) { ranges.push({ start, end: i + 1 }); stack.pop(); }
      i++;
      continue;
    }
    if (t.m === "tmpl") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { ranges.push({ start, end: i + 1 }); stack.pop(); i++; continue; }
      if (c === "$" && nx === "{") {
        ranges.push({ start, end: i }); // raw template text so far
        i += 2;
        stack.push({ m: "code", d: 1 }); // ${…} interior is live code
        continue;
      }
      i++;
      continue;
    }
    // code
    if (c === "/" && nx === "/") { stack.push({ m: "line" }); start = i; i += 2; continue; }
    if (c === "/" && nx === "*") { stack.push({ m: "block" }); start = i; i += 2; continue; }
    if (c === '"' || c === "'") { stack.push({ m: "str", q: c }); start = i; i++; continue; }
    if (c === "`") { stack.push({ m: "tmpl" }); start = i; i++; continue; }
    if (c === "{") t.d++;
    else if (c === "}" && t.d > 0) {
      t.d--;
      if (t.d === 0 && stack.length > 1) { stack.pop(); start = i + 1; } // template text resumes
    }
    i++;
  }
  if (top().m !== "code") ranges.push({ start, end: n }); // unterminated literal/comment
  return ranges;
}

/** Read the string literal starting at src[i] (quote char required). Escapes
 *  are kept raw; a template literal containing ${ is not static → null. */
function readLiteral(src: string, i: number): { content: string; end: number } | null {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let j = i + 1;
  let out = "";
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { out += src.slice(j, j + 2); j += 2; continue; }
    if (q === "`" && c === "$" && src[j + 1] === "{") return null;
    if (c === q) return { content: out, end: j + 1 };
    out += c;
    j++;
  }
  return null;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/** Parse an import/export statement starting after the keyword: collect
 *  literals (skipping comments), track `from`, and pick the specifier
 *  positionally. Returns null when no static specifier exists. */
function parseStatement(src: string, from: number): string | null {
  const lits: string[] = [];
  let hasFrom = false;
  let hasEq = false;
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === ";") break;
    if (c === "\n" && depth === 0) break;
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const lit = readLiteral(src, i);
      if (!lit) return null;
      lits.push(lit.content);
      i = lit.end;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === "=") hasEq = true;
    else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      if (src.slice(i, j) === "from") hasFrom = true;
      i = j;
      continue;
    }
    i++;
  }
  if (hasEq) return null; // import x = require(…) — the require branch owns it
  if (hasFrom) return lits[lits.length - 1] ?? null;
  return lits[0] ?? null;
}

const KEYWORD_RE = /(?<![\w$.])(import|export|require)(?![\w$])/g;

function specifiersOf(src: string): Array<{ specifier: string; line: number }> {
  const dead = deadRanges(src);
  const inDead = (idx: number): boolean => dead.some((r) => idx >= r.start && idx < r.end);
  const out: Array<{ specifier: string; line: number }> = [];
  for (const m of src.matchAll(KEYWORD_RE)) {
    const kw = m[1];
    const at = m.index!;
    if (inDead(at)) continue;
    let i = at + kw.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    let specifier: string | null;
    if (kw === "require") {
      if (src[i] !== "(") continue; // require.resolve et al — not an edge
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const lit = readLiteral(src, i);
      specifier = lit ? lit.content : "(dynamic)";
    } else if (kw === "import" && src[i] === "(") {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const lit = readLiteral(src, i);
      specifier = lit ? lit.content : "(dynamic)";
    } else {
      specifier = parseStatement(src, i);
    }
    if (specifier) out.push({ specifier, line: lineOf(src, at) });
  }
  return out;
}

function collectTs(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectTs(p, root, out);
    else if (/\.(ts|js|tsx|jsx)$/.test(name)) out.push(relative(root, p).split(sep).join("/"));
  }
}

export function findImportEdges(root: string = repoRoot()): ImportEdge[] {
  const targetsDir = join(root, "agent", "targets");
  const files: string[] = [];
  collectTs(targetsDir, root, files);
  const edges: ImportEdge[] = [];
  for (const file of files.sort()) {
    const src = readFileSync(join(root, file), "utf8");
    for (const { specifier, line } of specifiersOf(src)) {
      const resolved = specifier.startsWith(".")
        ? join(dirname(file), specifier).split(sep).join("/")
        : null;
      edges.push({ file, line, specifier, resolved });
    }
  }
  return edges;
}

export function depcheck(root: string = repoRoot()): DepcheckReport {
  const edges = findImportEdges(root);
  const libPrefix = "agent/lib/";
  const violations: ImportEdge[] = [];
  for (const e of edges) {
    if (e.resolved && (e.resolved === "agent/lib" || e.resolved.startsWith(libPrefix))) continue;
    violations.push(e);
  }
  return { violations, scanned: edges.length };
}
