// Editable Instrument source boundary. Agents and human tooling use the same
// guarded entry-file operations; optimistic hashes prevent silent overwrite.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { importPath, libReference } from "./libref.js";
import { getTarget, loadManifest, repoRoot } from "./manifest.js";

export const INSTRUMENT_SOURCE_MAX_BYTES = 2 * 1024 * 1024;

export interface InstrumentSource {
  instrument: string;
  path: string;
  text: string;
  bytes: number;
  sha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function resolvedRoot(root?: string): string {
  const absolute = resolve(root ?? repoRoot());
  if (!existsSync(absolute)) throw new Error(`workspace root does not exist: ${absolute}`);
  return realpathSync(absolute);
}

function entryPath(name: string, root: string): { path: string; absolute: string } {
  const config = getTarget(name, loadManifest(root), null);
  if (!config.entry || isAbsolute(config.entry)) throw new Error("instrument entry must be a repo-relative path");
  const absolute = resolve(root, config.entry);
  if (!inside(root, absolute) || !existsSync(absolute)) throw new Error(`instrument entry is outside the workspace or missing: ${config.entry}`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`instrument entry must be a regular file: ${config.entry}`);
  const real = realpathSync(absolute);
  if (!inside(root, real)) throw new Error(`instrument entry resolves outside the workspace: ${config.entry}`);
  return { path: relative(root, real).split(sep).join("/"), absolute: real };
}

export function readInstrumentSource(name: string, root?: string): InstrumentSource {
  const workspace = resolvedRoot(root);
  const entry = entryPath(name, workspace);
  const text = readFileSync(entry.absolute, "utf8");
  return {
    instrument: name,
    path: entry.path,
    text,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
  };
}

export function writeInstrumentSource(
  name: string,
  text: string,
  expectedSha256?: string,
  root?: string,
): InstrumentSource {
  if (typeof text !== "string") throw new Error("instrument source must be a string");
  if (Buffer.byteLength(text) > INSTRUMENT_SOURCE_MAX_BYTES) {
    throw new Error(`instrument source exceeds ${INSTRUMENT_SOURCE_MAX_BYTES} bytes`);
  }
  const workspace = resolvedRoot(root);
  const current = readInstrumentSource(name, workspace);
  if (expectedSha256 !== undefined && expectedSha256 !== current.sha256) {
    throw new Error(`instrument source changed: expected ${expectedSha256}, current ${current.sha256}`);
  }
  const entry = entryPath(name, workspace);
  const staging = resolve(dirname(entry.absolute), `.flab-source-${randomUUID()}`);
  try {
    writeFileSync(staging, text, "utf8");
    renameSync(staging, entry.absolute);
  } finally {
    if (existsSync(staging)) rmSync(staging, { force: true });
  }
  return readInstrumentSource(name, workspace);
}

function moduleAlias(module: string): string {
  const stem = module.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^[^A-Za-z_$]/, "_$&") || "module";
  return `flab_${stem}_${sha256(module).slice(0, 8)}`;
}

/** Link a reusable agent/lib module into an Instrument entry exactly once. */
export function linkInstrumentModule(
  name: string,
  module: string,
  expectedSha256?: string,
  root?: string,
): InstrumentSource & { module: string; alias: string; import: string; alreadyLinked: boolean } {
  const selected = libReference().find((candidate) => candidate.module === module);
  if (!selected) throw new Error(`unknown agent/lib module ${JSON.stringify(module)}`);
  const current = readInstrumentSource(name, root);
  if (expectedSha256 !== undefined && expectedSha256 !== current.sha256) {
    throw new Error(`instrument source changed: expected ${expectedSha256}, current ${current.sha256}`);
  }
  const marker = `// flab:module ${module}`;
  const alias = moduleAlias(module);
  const statement = `import * as ${alias} from ${JSON.stringify(importPath(selected))}; ${marker}`;
  if (current.text.includes(marker)) {
    return { ...current, module, alias, import: statement, alreadyLinked: true };
  }
  const updated = writeInstrumentSource(name, `${statement}\nvoid ${alias};\n${current.text}`, current.sha256, root);
  return { ...updated, module, alias, import: statement, alreadyLinked: false };
}
