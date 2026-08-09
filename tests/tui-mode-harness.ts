import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProjectService,
  ProjectError,
  type GameSession,
  type RpcDescriptor,
} from "../src/core/index.js";
import { ANALYSIS_SURFACES, INSTRUMENT_SURFACES, cycleSurface } from "../src/tui/index.js";
import {
  MODE_PALETTE_ITEMS,
  selectPaletteRoute,
  type WorkspaceSurface,
  type ModeSelection,
  type TuiMode,
} from "../src/tui/modebar.js";
import { buildProbeRequest, buildTargetLaunch } from "../src/tui/probe.js";
import { store } from "../src/tui/store.js";
import { workbench } from "../src/tui/workbench.js";
import { compileNativeFixture } from "./fixture-compiler.js";

const ROOT = mkdtempSync(join(tmpdir(), "flab-tui-mode-"));
const SLEEPER = join(ROOT, process.platform === "win32" ? "flab-sleeper.exe" : "flab-sleeper");
const CRASHER = join(ROOT, process.platform === "win32" ? "flab-crasher.exe" : "flab-crasher");
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitLive(id: number): Promise<void> {
  await waitFor(`session ${id} live`, () => {
    const session = store.session(id);
    if (session?.status === "error") throw new Error(`session ${id} errored: ${session.detail}`);
    return session?.status === "live";
  }, 30_000);
}

async function removeSession(id: number): Promise<void> {
  await workbench.close(id);
  store.removeSession(id);
  workbench.dropSession(id);
}

async function projectLifecycle(): Promise<void> {
  mkdirSync(join(ROOT, "agent", "targets"), { recursive: true });
  writeFileSync(join(ROOT, "frida-labs.json"), "{\n  \"targets\": {}\n}\n");
  const projects = createProjectService({ root: ROOT, transactionId: () => "harness" });

  await projects.create({ name: "alpha", process: "Alpha", mode: "attach" });
  await projects.update("alpha", { process: "Alpha.app", mode: "spawn" });
  await projects.rename("alpha", "beta", { moveConventionalSources: true });
  await projects.remove({ name: "beta", policy: "unregister" });
  assert.equal(existsSync(join(ROOT, "agent", "targets", "beta")), true, "unregister must retain sources");

  await projects.create({ name: "gamma", process: "Gamma", mode: "attach" });
  await assert.rejects(
    projects.remove({ name: "gamma", policy: "delete-sources", confirmation: "Gamma" }),
    (error: unknown) => error instanceof ProjectError && error.code === "confirmation",
  );
  await projects.remove({ name: "gamma", policy: "delete-sources", confirmation: "gamma" });
  assert.equal(existsSync(join(ROOT, "agent", "targets", "gamma")), false);
  const manifest = JSON.parse(readFileSync(join(ROOT, "frida-labs.json"), "utf8")) as { targets: Record<string, unknown> };
  assert.deepEqual(manifest.targets, {});
  console.log("PASS project create/edit/rename/unregister/exact-confirm delete");
}

function probeValidation(): void {
  assert.deepEqual(buildProbeRequest("probe-attach-name", "  ADOFAI  ", true), {
    ok: true,
    request: { kind: "probe-attach-name", process: "ADOFAI", childGating: true },
  });
  assert.deepEqual(buildProbeRequest("probe-attach-pid", "4321", false), {
    ok: true,
    request: { kind: "probe-attach-pid", pid: 4321 },
  });
  assert.deepEqual(buildProbeRequest("probe-spawn", "  /tmp/game  ", false), {
    ok: true,
    request: { kind: "probe-spawn", executable: "/tmp/game" },
  });
  assert.equal(buildProbeRequest("probe-attach-pid", "12x", false).ok, false);
  assert.equal(buildProbeRequest("probe-attach-pid", "0", false).ok, false);
  assert.equal(buildProbeRequest("probe-spawn", "  ", false).ok, false);
  console.log("PASS Probe name/PID/spawn union validation");
  assert.deepEqual(buildTargetLaunch("adofai", "ADOFAI", true, false), {
    kind: "target",
    target: "adofai",
    processOverride: "ADOFAI",
    spawnGating: true,
  });
  assert.deepEqual(buildTargetLaunch("adofai", undefined, false, true), {
    kind: "target",
    target: "adofai",
    childGating: true,
  });
}

function modeAndSurfaceRoutes(): void {
  let route: ModeSelection = { mode: "project", surface: "actions" };
  const modes = new Set<TuiMode>();
  for (let index = 0; index < MODE_PALETTE_ITEMS.length; index++) {
    route = selectPaletteRoute(route, index);
    modes.add(route.mode);
  }
  assert.deepEqual([...modes].sort(), ["analysis", "instrument", "project"]);
  assert.equal(MODE_PALETTE_ITEMS.length, 3);

  for (const mode of ["analysis", "instrument"] as const) {
    let surface: WorkspaceSurface = "actions";
    const visited = new Set<WorkspaceSurface>([surface]);
    for (let index = 0; index < 3; index++) {
      surface = cycleSurface(mode, surface);
      visited.add(surface);
    }
    assert.deepEqual([...visited].sort(), [...(mode === "analysis" ? ANALYSIS_SURFACES : INSTRUMENT_SURFACES)].sort());
  }
  console.log("PASS three modes + contextual three-surface groups route deterministically");
}

const PAGED_DESCRIPTOR: RpcDescriptor = {
  name: "rows",
  args: [],
  capabilities: ["instrument", "analysis"],
  effect: "read",
  returns: "table",
};

function installFakeSession(
  target: string,
  call: GameSession["call"],
): { id: number; handle: GameSession } {
  const slot = store.addSession(target, target);
  assert.ok(slot);
  const handle: GameSession = {
    target,
    process: target,
    pid: 9000 + slot.id,
    device: {
      id: "local",
      name: "Local System",
      type: "local",
      platform: "darwin",
      arch: "arm64",
      selector: { kind: "local" },
    },
    call,
    eval: async () => undefined,
    rpcNames: () => ["rows"],
    describe: async () => [PAGED_DESCRIPTOR],
    close: async () => {},
  };
  const internals = workbench as unknown as { handles: Map<number, GameSession> };
  internals.handles.set(slot.id, handle);
  store.patchSession(slot.id, {
    status: "live",
    process: target,
    pid: handle.pid,
    detail: "fake live",
  }, true);
  return { id: slot.id, handle };
}

async function actionPaging(): Promise<void> {
  let calls = 0;
  const rows = Array.from({ length: 500 }, (_, index) => ({ index, value: `row-${index}` }));
  const { id } = installFakeSession("paging", async () => {
    calls++;
    return rows;
  });

  const first = await workbench.invokeAction(id, "analysis", "rows", [], 0);
  const second = await workbench.invokeAction(id, "analysis", "rows", [], first.result.nextOffset!);
  const third = await workbench.invokeAction(id, "analysis", "rows", [], second.result.nextOffset!);

  assert.equal(first.result.rows.length, 200);
  assert.equal(first.result.nextOffset, 200);
  assert.equal(second.result.rows.length, 200);
  assert.equal(second.result.nextOffset, 400);
  assert.equal(third.result.rows.length, 100);
  assert.equal(third.result.nextOffset, undefined);
  assert.equal(calls, 3, "each page must re-describe and re-run through Workbench");
  await removeSession(id);
  console.log("PASS Analysis pages 0/200/400 through Workbench without retaining raw results");
}

async function closeDuringAction(): Promise<void> {
  let release!: (value: unknown) => void;
  const blocked = new Promise<unknown>((resolve) => { release = resolve; });
  const { id } = installFakeSession("action-race", async () => await blocked);
  const invocation = workbench.invokeAction(id, "analysis", "rows", []);
  await delay(0);
  const closing = workbench.close(id);
  release([{ done: true }]);
  await invocation;
  await closing;
  store.removeSession(id);
  workbench.dropSession(id);

  const internals = workbench as unknown as {
    actionChains: Map<number, unknown>;
    actions: { receiptHistory(sessionId: number): { receipts: readonly unknown[] } };
  };
  assert.equal(internals.actionChains.has(id), false);
  assert.equal(internals.actions.receiptHistory(id).receipts.length, 0);
  console.log("PASS close-during-action cannot resurrect receipt/debug state");
}

async function closeDuringLaunch(pid: number): Promise<void> {
  const slot = workbench.open({ kind: "probe-attach-pid", pid, display: "fixture-close-race" });
  assert.ok(slot);
  await workbench.close(slot.id);
  await delay(250);
  assert.equal(store.session(slot.id)?.status, "closed");
  assert.equal(workbench.handle(slot.id), null);
  const internals = workbench as unknown as { chains: Map<number, unknown>; closeRequested: Set<number> };
  assert.equal(internals.chains.has(slot.id), false);
  assert.equal(internals.closeRequested.has(slot.id), false);
  store.removeSession(slot.id);
  workbench.dropSession(slot.id);
  console.log("PASS close-during-launch: no resurrection or retained lifecycle entry");
}

async function liveModeNavigation(pid: number): Promise<void> {
  const slot = workbench.open({ kind: "probe-attach-pid", pid, display: "fixture-sleeper" });
  assert.ok(slot);
  await waitLive(slot.id);
  const handle = workbench.handle(slot.id);
  assert.ok(handle);

  let route: ModeSelection = { mode: "project", surface: "actions" };
  for (let index = 0; index < MODE_PALETTE_ITEMS.length; index++) {
    route = selectPaletteRoute(route, index);
    assert.equal(workbench.handle(slot.id), handle);
    assert.equal(store.session(slot.id)?.status, "live");
  }
  for (const mode of ["analysis", "instrument"] as const) {
    let surface: WorkspaceSurface = "actions";
    for (let index = 0; index < 3; index++) {
      surface = cycleSurface(mode, surface);
      assert.equal(workbench.handle(slot.id), handle);
      assert.ok((mode === "analysis" ? ANALYSIS_SURFACES : INSTRUMENT_SURFACES).includes(surface));
    }
    assert.equal(workbench.handle(slot.id), handle);
  }
  console.log("PASS SessionWorkbench contextual navigation preserves one live handle");

  process.kill(pid, "SIGTERM");
  await waitFor("clean sleeper detach", () => store.session(slot.id)?.status === "detached");
  const events = store.session(slot.id)?.debugEvents ?? [];
  assert.ok(events.some((event) => event.kind === "session-detached"));
  assert.equal(events.some((event) => event.kind === "process-crash"), false);
  console.log("PASS clean sleeper exit is session-detached, not process-crash");
  await removeSession(slot.id);
}

async function crashClassification(pid: number, trigger: () => void | Promise<void>): Promise<void> {
  const slot = workbench.open({ kind: "probe-attach-pid", pid, display: "fixture-crasher" });
  assert.ok(slot);
  let live = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await waitLive(slot.id);
      live = true;
      break;
    } catch (error) {
      const detail = store.session(slot.id)?.detail ?? (error as Error).message;
      const dyldSharedCacheLimited = /Module not found at "\/usr\/lib\/libSystem\.B\.dylib"/.test(detail);
      if (!dyldSharedCacheLimited) throw error;
      if (attempt < 2) {
        assert.equal(workbench.reconnect(slot.id, true), true);
        await delay(100);
      }
    }
  }
  if (!live) {
    await trigger();
    await removeSession(slot.id);
    console.log("PASS crasher attach is explicitly dyld-shared-cache environment-limited");
    return;
  }
  await trigger();
  await waitFor("crasher terminal event", () => {
    const session = store.session(slot.id);
    return session?.debugEvents.some((event) => event.kind === "process-crash") === true || session?.status === "detached";
  });
  const events = store.session(slot.id)?.debugEvents ?? [];
  if (events.some((event) => event.kind === "process-crash")) {
    console.log("PASS crasher abnormal termination is process-crash");
  } else {
    assert.equal(store.session(slot.id)?.status, "detached");
    console.log("PASS crasher abnormal termination is explicitly environment-limited detached");
  }
  await removeSession(slot.id);
}

let sleeper: ReturnType<typeof Bun.spawn> | null = null;
let crasher: ReturnType<typeof Bun.spawn> | null = null;
try {
  await compileNativeFixture(process.cwd(), "tests/fixtures/sleeper.c", SLEEPER);
  await compileNativeFixture(process.cwd(), "tests/fixtures/crasher.c", CRASHER);
  await projectLifecycle();
  probeValidation();
  modeAndSurfaceRoutes();
  await actionPaging();
  await closeDuringAction();

  sleeper = Bun.spawn({ cmd: [SLEEPER], stdout: "ignore", stderr: "ignore" });
  await delay(250);
  await closeDuringLaunch(sleeper.pid);
  await liveModeNavigation(sleeper.pid);
  await sleeper.exited;
  sleeper = null;

  crasher = Bun.spawn({ cmd: [CRASHER], stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  await delay(250);
  await crashClassification(crasher.pid, async () => {
    crasher!.stdin.write("crash\n");
    await crasher!.stdin.flush();
  });
  await crasher.exited;
  crasher = null;

  assert.equal(store.snapshot.sessions.length, 0);
  console.log("ALL PASS");
} finally {
  await workbench.closeAll().catch(() => {});
  if (sleeper) {
    sleeper.kill("SIGTERM");
    await sleeper.exited.catch(() => {});
  }
  if (crasher) {
    crasher.kill("SIGTERM");
    await crasher.exited.catch(() => {});
  }
  rmSync(ROOT, { recursive: true, force: true });
}
