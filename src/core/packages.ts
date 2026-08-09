// Portable Instrument artifacts. A package contains the registered target
// metadata, editable entry source, and a self-contained Frida bundle. The
// format is deterministic so agents and humans can verify the same artifact.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { compileAgent } from "./compile.js";
import { stableSerialize } from "./actions.js";
import { getTarget, loadManifest, repoRoot, type TargetConfig } from "./manifest.js";

export const INSTRUMENT_PACKAGE_SCHEMA = "flab.instrument.v1";

export interface InstrumentPackage {
  schema: typeof INSTRUMENT_PACKAGE_SCHEMA;
  instrument: {
    name: string;
    config: TargetConfig;
  };
  source: {
    path: string;
    encoding: "utf8";
    text: string;
  };
  bundle: {
    format: "frida-agent-javascript";
    encoding: "utf8";
    bytes: number;
    sha256: string;
    text: string;
  };
  integrity: {
    algorithm: "sha256";
    digest: string;
  };
}

export interface InstrumentPackageResult {
  path: string;
  bytes: number;
  sha256: string;
  artifact: InstrumentPackage;
}

export interface InstrumentPackageOptions {
  root?: string;
  out?: string;
  compile?: (name: string) => Promise<string>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeEntry(root: string, entry: string): string {
  if (!entry || isAbsolute(entry)) throw new Error("instrument entry must be a repo-relative path");
  const absolute = resolve(root, entry);
  if (!inside(root, absolute) || !existsSync(absolute)) throw new Error(`instrument entry is outside the workspace or missing: ${entry}`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`instrument entry must be a regular file: ${entry}`);
  const real = realpathSync(absolute);
  if (!inside(root, real)) throw new Error(`instrument entry resolves outside the workspace: ${entry}`);
  return real;
}

function safeOutput(root: string, output: string): string {
  if (!output || isAbsolute(output)) throw new Error("package output must be a non-empty workspace-relative path");
  const absolute = resolve(root, output);
  if (!inside(root, absolute)) throw new Error(`package output escapes the workspace: ${output}`);
  return absolute;
}

function packageCore(
  name: string,
  config: TargetConfig,
  sourcePath: string,
  source: string,
  bundle: string,
): Omit<InstrumentPackage, "integrity"> {
  return {
    schema: INSTRUMENT_PACKAGE_SCHEMA,
    instrument: { name, config },
    source: { path: sourcePath, encoding: "utf8", text: source },
    bundle: {
      format: "frida-agent-javascript",
      encoding: "utf8",
      bytes: Buffer.byteLength(bundle),
      sha256: sha256(bundle),
      text: bundle,
    },
  };
}

/** Build and write one deterministic, distributable Instrument artifact. */
export async function buildInstrumentPackage(
  name: string,
  options: InstrumentPackageOptions = {},
): Promise<InstrumentPackageResult> {
  const root = realpathSync(resolve(options.root ?? repoRoot()));
  const config = getTarget(name, loadManifest(root), null);
  const entry = safeEntry(root, config.entry);
  const source = readFileSync(entry, "utf8");
  const bundle = await (options.compile ?? compileAgent)(name);
  const core = packageCore(name, config, config.entry, source, bundle);
  const digest = sha256(stableSerialize(core));
  const artifact: InstrumentPackage = {
    ...core,
    integrity: { algorithm: "sha256", digest },
  };
  const output = options.out ?? `dist/instruments/${name}.flab.json`;
  const absolute = safeOutput(root, output);
  mkdirSync(dirname(absolute), { recursive: true });
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(absolute, encoded, "utf8");
  return {
    path: relative(root, absolute).split(sep).join("/"),
    bytes: Buffer.byteLength(encoded),
    sha256: sha256(encoded),
    artifact,
  };
}

/** Parse and verify an Instrument package without registering or executing it. */
export function inspectInstrumentPackage(value: string): InstrumentPackage {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("instrument package must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("instrument package must be an object");
  const artifact = parsed as Partial<InstrumentPackage>;
  if (artifact.schema !== INSTRUMENT_PACKAGE_SCHEMA || !artifact.instrument || !artifact.source || !artifact.bundle || !artifact.integrity) {
    throw new Error(`instrument package must use schema ${INSTRUMENT_PACKAGE_SCHEMA}`);
  }
  if (typeof artifact.instrument.name !== "string" || !artifact.instrument.config ||
      typeof artifact.source.path !== "string" || typeof artifact.source.text !== "string" ||
      typeof artifact.bundle.text !== "string" || typeof artifact.bundle.sha256 !== "string" ||
      typeof artifact.integrity.digest !== "string") {
    throw new Error("instrument package has invalid fields");
  }
  if (sha256(artifact.bundle.text) !== artifact.bundle.sha256) throw new Error("instrument bundle checksum mismatch");
  const { integrity: _integrity, ...core } = artifact as InstrumentPackage;
  if (sha256(stableSerialize(core)) !== artifact.integrity.digest) throw new Error("instrument package integrity mismatch");
  return artifact as InstrumentPackage;
}
