// Workspace manifest — the target registry. Plain JSON (frida-labs.json at
// the repo root) so the tool itself, any script, and any agent can read or
// edit it without importing TypeScript.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceSelector } from "./devices.js";

export interface TargetConfig {
  /** Process name for attach, or executable path for spawn. Windows-style
   *  `Game.exe` automatically also matches `Game` on macOS/Linux. */
  process: string;
  /** Per-platform override for `process` (e.g. { "darwin": "Game.bin.osx" }). */
  processByPlatform?: Partial<Record<string, string>>;
  mode: "attach" | "spawn";
  /** Default Frida device. Runtime --device/--host overrides this. */
  device?: DeviceSelector;
  /** Agent entry, repo-relative. Convention: agent/targets/<name>/index.ts */
  entry: string;
  /** Forward-compatible target metadata is preserved by project mutations. */
  [key: string]: unknown;
}

export interface Manifest {
  targets: Record<string, TargetConfig>;
  /** Forward-compatible workspace metadata is preserved by project mutations. */
  [key: string]: unknown;
}

/** Repo root: two levels up from this file, or cwd when running from a
 *  compiled binary (then the workspace is wherever flab is invoked). */
export function repoRoot(): string {
  const sessionWorkspace = process.env.FLAB_WORKSPACE;
  if (sessionWorkspace) {
    const selected = resolve(sessionWorkspace);
    if (existsSync(join(selected, "frida-labs.json"))) return selected;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  return existsSync(join(root, "frida-labs.json")) ? root : process.cwd();
}

const MANIFEST = "frida-labs.json";
export const PROBE_TARGET = "_probe";

export function loadManifest(root: string = repoRoot()): Manifest {
  const p = join(root, MANIFEST);
  if (!existsSync(p)) return { targets: {} };
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}


export function listTargets(m: Manifest = loadManifest()): string[] {
  return Object.keys(m.targets).filter((t) => t !== PROBE_TARGET);
}

export function getTarget(
  name: string,
  m: Manifest = loadManifest(),
  platform: string | null = process.platform,
): TargetConfig {
  const cfg = m.targets[name];
  if (!cfg) throw new Error(`unknown target "${name}". known: ${listTargets(m).join(", ") || "(none)"}`);
  const override = platform === null ? undefined : cfg.processByPlatform?.[platform];
  return override ? { ...cfg, process: override } : cfg;
}
