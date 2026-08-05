import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectService,
  nodeManifestCommitter,
  nodeProjectFs,
  ProjectError,
  type Manifest,
  type ManifestCommitter,
  type ProjectFs,
} from "../src/core/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(manifest: Manifest = { targets: {} }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flab-projects-")));
  roots.push(root);
  mkdirSync(join(root, "agent", "targets"), { recursive: true });
  writeFileSync(join(root, "frida-labs.json"), JSON.stringify(manifest, null, 2) + "\n");
  return root;
}

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, "frida-labs.json"), "utf8")) as Manifest;
}

function conventional(root: string, name: string, source = "export {};\n"): void {
  const dir = join(root, "agent", "targets", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
}

function expectCode(error: unknown, code: ProjectError["code"]): void {
  expect(error).toBeInstanceOf(ProjectError);
  expect((error as ProjectError).code).toBe(code);
}
function faultFs(overrides: Partial<ProjectFs>): ProjectFs {
  return { ...nodeProjectFs, ...overrides };
}

async function failure(operation: Promise<unknown>): Promise<ProjectError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectError);
    return error as ProjectError;
  }
  throw new Error("expected ProjectError");
}

test("create is transactional and preserves unknown manifest fields", async () => {
  const root = workspace({ schema: 7, targets: { old: { process: "Old", mode: "attach", entry: "agent/targets/old/index.ts", custom: true } } });
  conventional(root, "old");

  const result = await createProjectService({ root, transactionId: () => "create" }).create({
    name: "game",
    process: " Game.exe ",
    mode: "attach",
    processByPlatform: { darwin: " Game " },
    device: { kind: "usb", timeoutMs: 8_000 },
  });

  expect(result).toMatchObject({ operation: "create", name: "game", entry: "agent/targets/game/index.ts" });
  expect(readFileSync(join(root, result.entry), "utf8")).toContain("Target entry: game");
  const manifest = readManifest(root);
  expect(manifest.schema).toBe(7);
  expect(manifest.targets.old?.custom).toBe(true);
  expect(manifest.targets.game).toMatchObject({
    process: "Game.exe",
    mode: "attach",
    processByPlatform: { darwin: "Game" },
    device: { kind: "usb", timeoutMs: 8_000 },
  });
});

test("reserved and malformed names fail before filesystem mutation", async () => {
  const root = workspace();
  const service = createProjectService({ root });

  await service.create({ name: "_probe", process: "x", mode: "attach" }).then(
    () => { throw new Error("expected reserved-name rejection"); },
    (error) => expectCode(error, "reserved"),
  );
  await service.create({ name: "Bad Name", process: "x", mode: "attach" }).then(
    () => { throw new Error("expected malformed-name rejection"); },
    (error) => expectCode(error, "invalid_name"),
  );
  expect(readManifest(root).targets).toEqual({});
  expect(existsSync(join(root, "agent", "targets", "_probe"))).toBe(false);
});

test("create validates all request fields before staging source", async () => {
  const root = workspace();
  const service = createProjectService({ root, transactionId: () => "must-not-stage" });

  await failure(service.create({ name: "game", process: " ", mode: "attach" }));
  await failure(service.create({ name: "game", process: "Game", mode: "invalid" as "attach" }));
  await failure(service.create({
    name: "game",
    process: "Game",
    mode: "attach",
    processByPlatform: { darwin: " " },
  }));
  await failure(service.create({
    name: "game",
    process: "Game",
    mode: "attach",
    device: { kind: "id", id: "" },
  }));

  expect(existsSync(join(root, "agent", "targets", ".flab-txn-must-not-stage"))).toBe(false);
  expect(readManifest(root).targets).toEqual({});
});

test("update validates entries and preserves target metadata", async () => {
  const root = workspace({ targets: { game: { process: "Old", mode: "attach", entry: "agent/targets/game/index.ts", note: "keep" } } });
  conventional(root, "game");
  mkdirSync(join(root, "agent", "custom"), { recursive: true });
  writeFileSync(join(root, "agent", "custom", "entry.ts"), "export {};\n");
  const service = createProjectService({ root });

  const result = await service.update("game", {
    process: "New",
    mode: "spawn",
    entry: "agent/custom/entry.ts",
    device: { kind: "endpoint", address: "10.0.0.8:27042" },
  });
  expect(result.config).toMatchObject({
    process: "New",
    mode: "spawn",
    entry: "agent/custom/entry.ts",
    device: { kind: "endpoint", address: "10.0.0.8:27042" },
    note: "keep",
  });
  await service.update("game", { entry: "../escape.ts" }).then(
    () => { throw new Error("expected path rejection"); },
    (error) => expectCode(error, "outside_root"),
  );

  const outside = mkdtempSync(join(tmpdir(), "flab-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "entry.ts"), "export {};\n");
  symlinkSync(join(outside, "entry.ts"), join(root, "agent", "custom", "link.ts"));
  await service.update("game", { entry: "agent/custom/link.ts" }).then(
    () => { throw new Error("expected symlink rejection"); },
    (error) => expectCode(error, "symlink"),
  );
});

test("target roots reject ancestor and directory symlinks before outside mutation", async () => {
  const externalAgentRoot = workspace();
  const externalAgent = mkdtempSync(join(tmpdir(), "flab-agent-link-"));
  roots.push(externalAgent);
  rmSync(join(externalAgentRoot, "agent"), { recursive: true, force: true });
  symlinkSync(externalAgent, join(externalAgentRoot, "agent"), "dir");

  const agentError = await failure(createProjectService({ root: externalAgentRoot }).create({
    name: "game",
    process: "Game",
    mode: "attach",
  }));
  expect(agentError.code).toBe("symlink");
  expect(existsSync(join(externalAgent, "targets"))).toBe(false);

  const externalTargetsRoot = workspace();
  const externalTargets = mkdtempSync(join(tmpdir(), "flab-targets-link-"));
  roots.push(externalTargets);
  rmSync(join(externalTargetsRoot, "agent", "targets"), { recursive: true, force: true });
  symlinkSync(externalTargets, join(externalTargetsRoot, "agent", "targets"), "dir");

  const targetsError = await failure(createProjectService({ root: externalTargetsRoot }).create({
    name: "game",
    process: "Game",
    mode: "attach",
  }));
  expect(targetsError.code).toBe("symlink");
  expect(existsSync(join(externalTargets, "game"))).toBe(false);

  const inRoot = workspace();
  const alternate = join(inRoot, "alternate-targets");
  mkdirSync(alternate);
  rmSync(join(inRoot, "agent", "targets"), { recursive: true, force: true });
  symlinkSync(alternate, join(inRoot, "agent", "targets"), "dir");
  const inRootError = await failure(createProjectService({ root: inRoot }).create({
    name: "game",
    process: "Game",
    mode: "attach",
  }));
  expect(inRootError.code).toBe("symlink");
  expect(existsSync(join(alternate, "game"))).toBe(false);
});

test("delete rejects a symlinked conventional source directory", async () => {
  const root = workspace({
    targets: { game: { process: "Game", mode: "attach", entry: "agent/targets/game/index.ts" } },
  });
  const source = mkdtempSync(join(tmpdir(), "flab-source-link-"));
  roots.push(source);
  writeFileSync(join(source, "index.ts"), "export {};\n");
  symlinkSync(source, join(root, "agent", "targets", "game"), "dir");

  const error = await failure(createProjectService({ root }).remove({
    name: "game",
    policy: "delete-sources",
    confirmation: "game",
  }));
  expect(error.code).toBe("symlink");
  expect(readManifest(root).targets.game).toBeDefined();
  expect(existsSync(join(source, "index.ts"))).toBe(true);
});

test("conventional rename moves source and registry atomically", async () => {
  const root = workspace({ targets: { old: { process: "Old", mode: "attach", entry: "agent/targets/old/index.ts" } } });
  conventional(root, "old", "export const old = true;\n");

  const result = await createProjectService({ root }).rename("old", "next", { moveConventionalSources: true });

  expect(result.entry).toBe("agent/targets/next/index.ts");
  expect(existsSync(join(root, "agent", "targets", "old"))).toBe(false);
  expect(readFileSync(join(root, "agent", "targets", "next", "index.ts"), "utf8")).toContain("old = true");
  expect(Object.keys(readManifest(root).targets)).toEqual(["next"]);
});

test("custom-entry rename requires explicit registry-only policy", async () => {
  const root = workspace({ targets: { old: { process: "Old", mode: "attach", entry: "agent/custom.ts" } } });
  writeFileSync(join(root, "agent", "custom.ts"), "export {};\n");
  const service = createProjectService({ root });

  await service.rename("old", "next", { moveConventionalSources: true }).then(
    () => { throw new Error("expected custom-entry rejection"); },
    (error) => expectCode(error, "custom_entry"),
  );
  const result = await service.rename("old", "next", { moveConventionalSources: false });
  expect(result.entry).toBe("agent/custom.ts");
  expect(result.warnings).toHaveLength(1);
  expect(readManifest(root).targets.next?.entry).toBe("agent/custom.ts");
});

test("unregister preserves source while source delete requires exact confirmation", async () => {
  const unregisterRoot = workspace({ targets: { game: { process: "Game", mode: "attach", entry: "agent/targets/game/index.ts" } } });
  conventional(unregisterRoot, "game");
  await createProjectService({ root: unregisterRoot }).remove({ name: "game", policy: "unregister" });
  expect(existsSync(join(unregisterRoot, "agent", "targets", "game", "index.ts"))).toBe(true);
  expect(readManifest(unregisterRoot).targets.game).toBeUndefined();

  const deleteRoot = workspace({ targets: { game: { process: "Game", mode: "attach", entry: "agent/targets/game/index.ts" } } });
  conventional(deleteRoot, "game");
  const service = createProjectService({ root: deleteRoot, transactionId: () => "delete" });
  await service.remove({ name: "game", policy: "delete-sources", confirmation: "GAME" }).then(
    () => { throw new Error("expected confirmation rejection"); },
    (error) => expectCode(error, "confirmation"),
  );
  expect(readManifest(deleteRoot).targets.game).toBeDefined();
  await service.remove({ name: "game", policy: "delete-sources", confirmation: "game" });
  expect(readManifest(deleteRoot).targets.game).toBeUndefined();
  expect(existsSync(join(deleteRoot, "agent", "targets", "game"))).toBe(false);
});

test("manifest commit failures roll back create, rename, and staged delete", async () => {
  const failing: ManifestCommitter = {
    load: (root) => nodeManifestCommitter.load(root),
    commit: () => { throw new Error("disk full"); },
  };

  const createRoot = workspace();
  await createProjectService({ root: createRoot, manifest: failing, transactionId: () => "create-fail" })
    .create({ name: "game", process: "Game", mode: "attach" }).catch((error) => expectCode(error, "io"));
  expect(existsSync(join(createRoot, "agent", "targets", "game"))).toBe(false);
  expect(readManifest(createRoot).targets).toEqual({});

  const renameRoot = workspace({ targets: { old: { process: "Old", mode: "attach", entry: "agent/targets/old/index.ts" } } });
  conventional(renameRoot, "old");
  await createProjectService({ root: renameRoot, manifest: failing }).rename("old", "next", { moveConventionalSources: true })
    .catch((error) => expectCode(error, "io"));
  expect(existsSync(join(renameRoot, "agent", "targets", "old", "index.ts"))).toBe(true);
  expect(existsSync(join(renameRoot, "agent", "targets", "next"))).toBe(false);

  const deleteRoot = workspace({ targets: { game: { process: "Game", mode: "attach", entry: "agent/targets/game/index.ts" } } });
  conventional(deleteRoot, "game");
  await createProjectService({ root: deleteRoot, manifest: failing, transactionId: () => "delete-fail" })
    .remove({ name: "game", policy: "delete-sources", confirmation: "game" }).catch((error) => expectCode(error, "io"));
  expect(existsSync(join(deleteRoot, "agent", "targets", "game", "index.ts"))).toBe(true);
  expect(readManifest(deleteRoot).targets.game).toBeDefined();
});

test("fault injection reports exact staging and rollback residues", async () => {
  const conflict: ManifestCommitter = {
    load: (root) => nodeManifestCommitter.load(root),
    commit: () => { throw new ProjectError("manifest_changed", "concurrent edit"); },
  };

  const stageRoot = workspace();
  const stagePath = join(stageRoot, "agent", "targets", ".flab-txn-stage-fail");
  const stageError = await failure(createProjectService({
    root: stageRoot,
    transactionId: () => "stage-fail",
    fs: faultFs({
      rename: (from, to) => {
        if (from === stagePath) throw new Error("stage rename failed");
        nodeProjectFs.rename(from, to);
      },
    }),
  }).create({ name: "game", process: "Game", mode: "attach" }));
  expect(stageError.code).toBe("io");
  expect(stageError.residue).toBeUndefined();
  expect(existsSync(stagePath)).toBe(false);
  expect(readManifest(stageRoot).targets).toEqual({});

  const createRoot = workspace();
  const createDestination = join(createRoot, "agent", "targets", "game");
  const createError = await failure(createProjectService({
    root: createRoot,
    manifest: conflict,
    transactionId: () => "create-residue",
    fs: faultFs({
      rm: (path) => {
        if (path === createDestination) throw new Error("create rollback failed");
        nodeProjectFs.rm(path);
      },
    }),
  }).create({ name: "game", process: "Game", mode: "attach" }));
  expect(createError.code).toBe("manifest_changed");
  expect(createError.residue).toBe(createDestination);
  expect(existsSync(createDestination)).toBe(true);

  const renameRoot = workspace({
    targets: { old: { process: "Old", mode: "attach", entry: "agent/targets/old/index.ts" } },
  });
  conventional(renameRoot, "old");
  const oldDirectory = join(renameRoot, "agent", "targets", "old");
  const nextDirectory = join(renameRoot, "agent", "targets", "next");
  const renameError = await failure(createProjectService({
    root: renameRoot,
    manifest: conflict,
    fs: faultFs({
      rename: (from, to) => {
        if (from === nextDirectory && to === oldDirectory) throw new Error("rename rollback failed");
        nodeProjectFs.rename(from, to);
      },
    }),
  }).rename("old", "next", { moveConventionalSources: true }));
  expect(renameError.code).toBe("manifest_changed");
  expect(renameError.residue).toBe(nextDirectory);
  expect(existsSync(nextDirectory)).toBe(true);
  expect(readManifest(renameRoot).targets.old).toBeDefined();

  const deleteRoot = workspace({
    targets: { game: { process: "Game", mode: "attach", entry: "agent/targets/game/index.ts" } },
  });
  conventional(deleteRoot, "game");
  const deleteSource = join(deleteRoot, "agent", "targets", "game");
  const deleteStaging = join(deleteRoot, "agent", "targets", ".flab-delete-delete-residue");
  const deleteError = await failure(createProjectService({
    root: deleteRoot,
    manifest: conflict,
    transactionId: () => "delete-residue",
    fs: faultFs({
      rename: (from, to) => {
        if (from === deleteStaging && to === deleteSource) throw new Error("delete rollback failed");
        nodeProjectFs.rename(from, to);
      },
    }),
  }).remove({ name: "game", policy: "delete-sources", confirmation: "game" }));
  expect(deleteError.code).toBe("manifest_changed");
  expect(deleteError.residue).toBe(deleteStaging);
  expect(existsSync(deleteStaging)).toBe(true);
  expect(readManifest(deleteRoot).targets.game).toBeDefined();

  const cleanupRoot = workspace({
    targets: { game: { process: "Game", mode: "attach", entry: "agent/targets/game/index.ts" } },
  });
  conventional(cleanupRoot, "game");
  const cleanupStaging = join(cleanupRoot, "agent", "targets", ".flab-delete-cleanup-residue");
  const cleanupError = await failure(createProjectService({
    root: cleanupRoot,
    transactionId: () => "cleanup-residue",
    fs: faultFs({
      rm: (path) => {
        if (path === cleanupStaging) throw new Error("cleanup failed");
        nodeProjectFs.rm(path);
      },
    }),
  }).remove({ name: "game", policy: "delete-sources", confirmation: "game" }));
  expect(cleanupError.code).toBe("io");
  expect(cleanupError.residue).toBe(cleanupStaging);
  expect(existsSync(cleanupStaging)).toBe(true);
  expect(readManifest(cleanupRoot).targets.game).toBeUndefined();
});

test("optimistic manifest conflict rolls source changes back", async () => {
  const root = workspace();
  const conflicting: ManifestCommitter = {
    load: (workspaceRoot) => nodeManifestCommitter.load(workspaceRoot),
    commit: (workspaceRoot, digest, manifest) => {
      const current = readManifest(workspaceRoot);
      writeFileSync(join(workspaceRoot, "frida-labs.json"), JSON.stringify({ ...current, concurrent: true }, null, 2) + "\n");
      nodeManifestCommitter.commit(workspaceRoot, digest, manifest);
    },
  };

  await createProjectService({ root, manifest: conflicting, transactionId: () => "conflict" })
    .create({ name: "game", process: "Game", mode: "attach" }).then(
      () => { throw new Error("expected manifest conflict"); },
      (error) => expectCode(error, "manifest_changed"),
    );
  expect(existsSync(join(root, "agent", "targets", "game"))).toBe(false);
  expect(readManifest(root).concurrent).toBe(true);
});

test("mutations from separate service instances serialize per canonical root", async () => {
  const root = workspace();
  const first = createProjectService({ root, transactionId: () => "one" });
  const second = createProjectService({ root, transactionId: () => "two" });

  await Promise.all([
    first.create({ name: "one", process: "One", mode: "attach" }),
    second.create({ name: "two", process: "Two", mode: "spawn" }),
  ]);

  expect(Object.keys(readManifest(root).targets).sort()).toEqual(["one", "two"]);
});
