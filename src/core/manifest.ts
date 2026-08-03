// Workspace manifest — the target registry. Plain JSON (frida-labs.json at
// the repo root) so the tool itself, any script, and any agent can read or
// edit it without importing TypeScript.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface TargetConfig {
  /** Process name for attach, or executable path for spawn. Windows-style
   *  `Game.exe` automatically also matches `Game` on macOS/Linux. */
  process: string;
  /** Per-platform override for `process` (e.g. { "darwin": "Game.bin.osx" }). */
  processByPlatform?: Partial<Record<string, string>>;
  mode: "attach" | "spawn";
  /** Agent entry, repo-relative. Convention: agent/targets/<name>/index.ts */
  entry: string;
}

export interface Manifest {
  targets: Record<string, TargetConfig>;
}

/** Repo root: two levels up from this file, or cwd when running from a
 *  compiled binary (then the workspace is wherever flab is invoked). */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  return existsSync(join(root, "frida-labs.json")) ? root : process.cwd();
}

const MANIFEST = "frida-labs.json";
export const PROBE_TARGET = "_probe";

export function loadManifest(): Manifest {
  const p = join(repoRoot(), MANIFEST);
  if (!existsSync(p)) return { targets: {} };
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

export function saveManifest(m: Manifest): void {
  writeFileSync(join(repoRoot(), MANIFEST), JSON.stringify(m, null, 2) + "\n");
}

export function listTargets(m: Manifest = loadManifest()): string[] {
  return Object.keys(m.targets).filter((t) => t !== PROBE_TARGET);
}

export function getTarget(name: string, m: Manifest = loadManifest()): TargetConfig {
  const cfg = m.targets[name];
  if (!cfg) throw new Error(`unknown target "${name}". known: ${listTargets(m).join(", ") || "(none)"}`);
  const override = cfg.processByPlatform?.[process.platform];
  return override ? { ...cfg, process: override } : cfg;
}

export function addTarget(name: string, cfg: TargetConfig): void {
  const m = loadManifest();
  if (m.targets[name]) throw new Error(`target "${name}" already exists`);
  m.targets[name] = cfg;
  saveManifest(m);
}
