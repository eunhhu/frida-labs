// Current-workspace target project lifecycle. CLI and TUI share this typed
// service; filesystem/manifest mutation never lives in either frontend.

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROBE_TARGET, repoRoot, type Manifest, type TargetConfig } from "./manifest.js";
import { normalizeDeviceSelector, type DeviceSelector } from "./devices.js";

export type ProjectErrorCode =
  | "invalid_name" | "reserved" | "collision" | "manifest_changed"
  | "outside_root" | "symlink" | "custom_entry" | "confirmation"
  | "unknown_target" | "io";

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    readonly residue?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProjectError";
  }
}

export interface ProjectStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProjectFs {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  mkdir(path: string): void;
  rename(from: string, to: string): void;
  rm(path: string): void;
  exists(path: string): boolean;
  lstat(path: string): ProjectStat;
  realpath(path: string): string;
}

export interface ManifestSnapshot { manifest: Manifest; source: string; digest: string }
export interface ManifestCommitter {
  load(root: string): ManifestSnapshot;
  commit(root: string, expectedDigest: string, next: Manifest): void;
}
export interface ProjectServiceOptions {
  /** Isolation/test seam only; the product UI remains current-workspace. */
  root?: string;
  fs?: ProjectFs;
  manifest?: ManifestCommitter;
  transactionId?: () => string;
}
export interface TargetCreate {
  name: string;
  process: string;
  mode: "attach" | "spawn";
  processByPlatform?: Record<string, string>;
  device?: DeviceSelector;
}
export interface TargetPatch {
  process?: string;
  mode?: "attach" | "spawn";
  processByPlatform?: Record<string, string>;
  device?: DeviceSelector;
  /** Repo-relative existing source. Updating it never moves source files. */
  entry?: string;
}
export interface RenameOptions { moveConventionalSources: boolean }
export interface RemoveRequest {
  name: string;
  policy: "unregister" | "delete-sources";
  confirmation?: string;
}
export interface ProjectResult {
  operation: "create" | "update" | "rename" | "unregister" | "delete";
  name: string;
  entry: string;
  config: TargetConfig;
  warnings: string[];
}
export interface ProjectService {
  readonly root: string;
  list(): Array<{ name: string; config: TargetConfig }>;
  create(draft: TargetCreate): Promise<ProjectResult>;
  update(name: string, patch: TargetPatch): Promise<ProjectResult>;
  rename(name: string, nextName: string, options: RenameOptions): Promise<ProjectResult>;
  remove(request: RemoveRequest): Promise<ProjectResult>;
}

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const MANIFEST_NAME = "frida-labs.json";
const queues = new Map<string, Promise<void>>();

export const nodeProjectFs: ProjectFs = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, data) => writeFileSync(path, data),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rename: (from, to) => renameSync(from, to),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  exists: (path) => existsSync(path),
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
};

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
function parseManifest(source: string): Manifest {
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectError("io", "frida-labs.json must contain an object");
  }
  const manifest = value as Manifest;
  if (!manifest.targets || typeof manifest.targets !== "object" || Array.isArray(manifest.targets)) {
    throw new ProjectError("io", "frida-labs.json must contain a targets object");
  }
  return manifest;
}
function currentManifestSource(root: string): string {
  const path = join(root, MANIFEST_NAME);
  return existsSync(path) ? readFileSync(path, "utf8") : "{\n  \"targets\": {}\n}\n";
}

export const nodeManifestCommitter: ManifestCommitter = {
  load(root) {
    const source = currentManifestSource(root);
    return { manifest: parseManifest(source), source, digest: digest(source) };
  },
  commit(root, expectedDigest, next) {
    const path = join(root, MANIFEST_NAME);
    if (digest(currentManifestSource(root)) !== expectedDigest) {
      throw new ProjectError("manifest_changed", "frida-labs.json changed during the operation; reload and retry");
    }
    const tmp = `${path}.flab-${process.pid}-${randomUUID()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(next, null, 2) + "\n", "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, path);
    } catch (error) {
      if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
      try { rmSync(tmp, { force: true }); } catch { /* original error wins */ }
      if (error instanceof ProjectError) throw error;
      throw new ProjectError("io", `failed to commit ${MANIFEST_NAME}: ${(error as Error).message}`, undefined, { cause: error });
    }
  },
};

function projectError(error: unknown, operation: string, residue?: string): ProjectError {
  if (error instanceof ProjectError) {
    const effectiveResidue = residue ?? error.residue;
    if (effectiveResidue === error.residue) return error;
    return new ProjectError(error.code, error.message, effectiveResidue, {
      cause: error.cause ?? error,
    });
  }
  return new ProjectError("io", `${operation}: ${(error as Error).message}`, residue, { cause: error });
}
function validName(name: string): void {
  if (name === PROBE_TARGET) throw new ProjectError("reserved", `target "${PROBE_TARGET}" is reserved for Probe mode`);
  if (!NAME_RE.test(name)) throw new ProjectError("invalid_name", "target name must be lowercase letters/digits/-/_, starting with a letter");
}
function validProcess(value: string): string {
  const processName = value.trim();
  if (!processName) throw new ProjectError("io", "process must be non-empty");
  return processName;
}
function validMode(value: unknown): "attach" | "spawn" {
  if (value !== "attach" && value !== "spawn") {
    throw new ProjectError("io", "mode must be attach or spawn");
  }
  return value;
}
function validPlatformMap(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [platform, processName] of Object.entries(value)) {
    if (!platform.trim() || !processName.trim()) throw new ProjectError("io", "platform process overrides must be non-empty strings");
    result[platform] = processName.trim();
  }
  return result;
}
function validDevice(value: DeviceSelector): DeviceSelector {
  try {
    const selector = normalizeDeviceSelector(value);
    if (selector.kind === "endpoint" && selector.options) {
      throw new Error("remote credentials are runtime-only and cannot be stored in frida-labs.json");
    }
    return selector;
  } catch (error) {
    throw new ProjectError("io", (error as Error).message, undefined, { cause: error });
  }
}
function conventionalEntry(name: string): string { return `agent/targets/${name}/index.ts`; }
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function cloneManifest(snapshot: Manifest): Manifest { return { ...snapshot, targets: { ...snapshot.targets } }; }

export function targetTemplate(name: string): string {
  return `// Target entry: ${name} — compiled and injected by flab.
// rpc.exports is callable from the CLI and TUI. Reusable engines live in ../../lib/.

import { ok } from "../../lib/log.js";
import { detectAll } from "../../lib/detect.js";
import { recordingDescriptors, recordingRpcSurface } from "../../lib/recording.js";

const engines = detectAll();
for (const e of engines) ok(\`[${name}] detected \${e.label} @ \${e.module.name}\`);

rpc.exports = {
  ...recordingRpcSurface(),
  ping(): string {
    return \`alive; engines: \${engines.map((e) => e.id).join(", ") || "none"}\`;
  },
  __describe(): unknown {
    return [
      { name: "ping", label: "Connection check", category: "System", doc: "Sanity check — what the agent sees", capabilities: ["instrument", "analysis"], effect: "read", returns: "scalar" },
      ...recordingDescriptors(),
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};
`;
}

class Service implements ProjectService {
  readonly root: string;
  private readonly fs: ProjectFs;
  private readonly manifest: ManifestCommitter;
  private readonly transactionId: () => string;

  constructor(options: ProjectServiceOptions) {
    this.fs = options.fs ?? nodeProjectFs;
    this.manifest = options.manifest ?? nodeManifestCommitter;
    this.transactionId = options.transactionId ?? randomUUID;
    const requestedRoot = resolve(options.root ?? repoRoot());
    if (!this.fs.exists(requestedRoot)) throw new ProjectError("outside_root", `workspace root does not exist: ${requestedRoot}`);
    this.root = this.fs.realpath(requestedRoot);
  }

  list(): Array<{ name: string; config: TargetConfig }> {
    const { manifest } = this.manifest.load(this.root);
    return Object.entries(manifest.targets).filter(([name]) => name !== PROBE_TARGET).map(([name, config]) => ({ name, config }));
  }

  create(draft: TargetCreate): Promise<ProjectResult> {
    return this.mutate(async () => {
      validName(draft.name);
      const process = validProcess(draft.process);
      const mode = validMode(draft.mode);
      const processByPlatform = validPlatformMap(draft.processByPlatform);
      const device = draft.device === undefined ? undefined : validDevice(draft.device);
      const loaded = this.manifest.load(this.root);
      if (loaded.manifest.targets[draft.name]) throw new ProjectError("collision", `target "${draft.name}" already exists in ${MANIFEST_NAME}`);
      const targetsRoot = this.targetsRoot();
      const destination = join(targetsRoot, draft.name);
      const staging = join(targetsRoot, `.flab-txn-${this.transactionId()}`);
      if (this.fs.exists(destination) || this.fs.exists(staging)) throw new ProjectError("collision", `target source collision for "${draft.name}"`);
      let moved = false;
      try {
        this.fs.mkdir(staging);
        this.fs.writeFile(join(staging, "index.ts"), targetTemplate(draft.name));
        this.fs.rename(staging, destination);
        moved = true;
        const config: TargetConfig = {
          process,
          mode,
          entry: conventionalEntry(draft.name),
          ...(processByPlatform && Object.keys(processByPlatform).length ? { processByPlatform } : {}),
          ...(device ? { device } : {}),
        };
        const next = cloneManifest(loaded.manifest);
        next.targets[draft.name] = config;
        this.manifest.commit(this.root, loaded.digest, next);
        return { operation: "create", name: draft.name, entry: config.entry, config, warnings: [] };
      } catch (error) {
        let residue: string | undefined;
        try {
          if (moved && this.fs.exists(destination)) this.fs.rm(destination);
          else if (this.fs.exists(staging)) this.fs.rm(staging);
        } catch { residue = moved ? destination : staging; }
        throw projectError(error, `create target "${draft.name}"`, residue);
      }
    });
  }

  update(name: string, patch: TargetPatch): Promise<ProjectResult> {
    return this.mutate(async () => {
      validName(name);
      const loaded = this.manifest.load(this.root);
      const current = loaded.manifest.targets[name];
      if (!current) throw new ProjectError("unknown_target", `unknown target "${name}"`);
      const config: TargetConfig = { ...current };
      if (patch.process !== undefined) config.process = validProcess(patch.process);
      if (patch.mode !== undefined) config.mode = validMode(patch.mode);
      if (patch.processByPlatform !== undefined) {
        const map = validPlatformMap(patch.processByPlatform)!;
        if (Object.keys(map).length) config.processByPlatform = map;
        else delete config.processByPlatform;
      }
      if (patch.device !== undefined) config.device = validDevice(patch.device);
      if (patch.entry !== undefined) config.entry = this.validateEntry(patch.entry);
      const next = cloneManifest(loaded.manifest);
      next.targets[name] = config;
      this.manifest.commit(this.root, loaded.digest, next);
      return { operation: "update", name, entry: config.entry, config, warnings: [] };
    });
  }

  rename(name: string, nextName: string, options: RenameOptions): Promise<ProjectResult> {
    return this.mutate(async () => {
      validName(name); validName(nextName);
      if (name === nextName) throw new ProjectError("collision", "new target name must differ from the current name");
      const loaded = this.manifest.load(this.root);
      const current = loaded.manifest.targets[name];
      if (!current) throw new ProjectError("unknown_target", `unknown target "${name}"`);
      if (loaded.manifest.targets[nextName]) throw new ProjectError("collision", `target "${nextName}" already exists`);
      const isConventional = current.entry === conventionalEntry(name);
      if (options.moveConventionalSources && !isConventional) throw new ProjectError("custom_entry", `target "${name}" uses custom entry ${current.entry}; use registry-only rename`);
      const oldDir = join(this.targetsRoot(), name);
      const nextDir = join(this.targetsRoot(), nextName);
      let moved = false;
      try {
        if (options.moveConventionalSources) {
          this.validateConventionalDirectory(name);
          if (this.fs.exists(nextDir)) throw new ProjectError("collision", `source destination already exists: agent/targets/${nextName}`);
          this.fs.rename(oldDir, nextDir); moved = true;
        }
        const config: TargetConfig = { ...current, entry: moved ? conventionalEntry(nextName) : current.entry };
        const next = cloneManifest(loaded.manifest);
        delete next.targets[name]; next.targets[nextName] = config;
        this.manifest.commit(this.root, loaded.digest, next);
        return {
          operation: "rename",
          name: nextName,
          entry: config.entry,
          config,
          warnings: moved
            ? ["source directory moved; source contents were not rewritten"]
            : ["registry key renamed; source entry unchanged"],
        };
      } catch (error) {
        let residue: string | undefined;
        if (moved) try { this.fs.rename(nextDir, oldDir); } catch { residue = nextDir; }
        throw projectError(error, `rename target "${name}"`, residue);
      }
    });
  }

  remove(request: RemoveRequest): Promise<ProjectResult> {
    return this.mutate(async () => {
      validName(request.name);
      const loaded = this.manifest.load(this.root);
      const current = loaded.manifest.targets[request.name];
      if (!current) throw new ProjectError("unknown_target", `unknown target "${request.name}"`);
      const result: ProjectResult = { operation: request.policy === "unregister" ? "unregister" : "delete", name: request.name, entry: current.entry, config: current, warnings: [] };
      const next = cloneManifest(loaded.manifest); delete next.targets[request.name];
      if (request.policy === "unregister") { this.manifest.commit(this.root, loaded.digest, next); return result; }
      if (request.confirmation !== request.name) throw new ProjectError("confirmation", `delete confirmation must exactly match "${request.name}"`);
      if (current.entry !== conventionalEntry(request.name)) throw new ProjectError("custom_entry", `refusing to delete sources for custom entry ${current.entry}; unregister it instead`);
      const source = this.validateConventionalDirectory(request.name);
      const staging = join(this.targetsRoot(), `.flab-delete-${this.transactionId()}`);
      if (this.fs.exists(staging)) throw new ProjectError("collision", `delete staging path already exists: ${staging}`);
      let staged = false; let committed = false;
      try {
        this.fs.rename(source, staging); staged = true;
        this.manifest.commit(this.root, loaded.digest, next); committed = true;
        this.fs.rm(staging);
        return result;
      } catch (error) {
        let residue: string | undefined;
        if (staged && !committed) try { this.fs.rename(staging, source); } catch { residue = staging; }
        else if (staged && committed && this.fs.exists(staging)) residue = staging;
        throw projectError(error, `delete target "${request.name}"`, residue);
      }
    });
  }

  private targetsRoot(): string {
    const agent = this.ensureDirectory(this.root, join(this.root, "agent"), "agent");
    return this.ensureDirectory(agent, join(agent, "targets"), "agent/targets");
  }

  private ensureDirectory(parent: string, path: string, label: string): string {
    if (this.fs.exists(path)) {
      const existing = this.fs.lstat(path);
      if (existing.isSymbolicLink()) throw new ProjectError("symlink", `${label} must not be a symlink`);
      if (!existing.isDirectory()) throw new ProjectError("io", `${label} is not a directory`);
    } else {
      this.fs.mkdir(path);
    }

    const stat = this.fs.lstat(path);
    if (stat.isSymbolicLink()) throw new ProjectError("symlink", `${label} must not be a symlink`);
    if (!stat.isDirectory()) throw new ProjectError("io", `${label} is not a directory`);
    const canonical = this.fs.realpath(path);
    if (!inside(parent, canonical)) {
      throw new ProjectError("outside_root", `${label} escapes its validated parent: ${canonical}`);
    }
    return canonical;
  }
  private validateEntry(entry: string): string {
    if (!entry || isAbsolute(entry)) throw new ProjectError("outside_root", "entry must be a non-empty repo-relative path");
    const absolute = resolve(this.root, entry);
    if (!inside(this.root, absolute)) throw new ProjectError("outside_root", `entry escapes workspace: ${entry}`);
    if (!this.fs.exists(absolute)) throw new ProjectError("io", `entry does not exist: ${entry}`);
    const stat = this.fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new ProjectError("symlink", `entry must not be a symlink: ${entry}`);
    const real = this.fs.realpath(absolute);
    if (!inside(this.root, real)) throw new ProjectError("outside_root", `entry resolves outside workspace: ${entry}`);
    return relative(this.root, real).split(sep).join("/");
  }
  private validateConventionalDirectory(name: string): string {
    const targetsRoot = this.targetsRoot();
    const dir = join(targetsRoot, name);
    if (!this.fs.exists(dir)) throw new ProjectError("io", `target source does not exist: agent/targets/${name}`);
    const stat = this.fs.lstat(dir);
    if (stat.isSymbolicLink()) throw new ProjectError("symlink", `target source must not be a symlink: agent/targets/${name}`);
    if (!stat.isDirectory()) throw new ProjectError("io", `target source is not a directory: agent/targets/${name}`);
    const real = this.fs.realpath(dir);
    if (!inside(targetsRoot, real)) throw new ProjectError("outside_root", `target source resolves outside agent/targets: ${real}`);
    return real;
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.root) ?? Promise.resolve();
    const run = previous.catch(() => { /* prior operation cannot poison the queue */ }).then(operation);
    const tracked = run.then(() => undefined, () => undefined);
    queues.set(this.root, tracked);
    return run.finally(() => { if (queues.get(this.root) === tracked) queues.delete(this.root); });
  }
}

export function createProjectService(options: ProjectServiceOptions = {}): ProjectService { return new Service(options); }
export function currentProjectService(): ProjectService { return createProjectService({ root: repoRoot() }); }
