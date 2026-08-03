// Host-side lifecycle signals — wraps frida Device-level events (spawn gating,
// child gating, process crashes) as structured, frontend-agnostic callbacks.
// These signals live on the Device (host process), not in the agent — agent-side
// exception reporting is agent/lib/excrash.ts (Phase B).

import type frida from "frida";

/** Structured subset of frida.Crash. */
export interface CrashReport {
  pid: number;
  processName: string;
  summary: string;
  report: string;
  parameters: Record<string, unknown>;
}

/** Structured subset of frida.Child / frida.Spawn (same shape). */
export interface ChildInfo {
  pid: number;
  parentPid: number;
  origin: string;
  identifier: string | null;
  path: string | null;
  argv: string[] | null;
}

export interface LifecycleEvents {
  onCrash?(report: CrashReport): void;
  onChildAdded?(child: ChildInfo): void;
  onChildRemoved?(child: ChildInfo): void;
  onSpawnAdded?(spawn: ChildInfo): void;
  onSpawnRemoved?(spawn: ChildInfo): void;
}

function toCrashReport(c: frida.Crash): CrashReport {
  return {
    pid: c.pid,
    processName: c.processName,
    summary: c.summary,
    report: c.report,
    parameters: (c.parameters ?? {}) as Record<string, unknown>,
  };
}

function toChildInfo(c: frida.Child): ChildInfo {
  return {
    pid: c.pid,
    parentPid: c.parentPid,
    origin: String(c.origin),
    identifier: c.identifier ?? null,
    path: c.path ?? null,
    argv: c.argv ?? null,
  };
}

/** frida.Spawn carries only pid + identifier. */
function toSpawnInfo(s: frida.Spawn): ChildInfo {
  return { pid: s.pid, parentPid: 0, origin: "spawn", identifier: s.identifier ?? null, path: null, argv: null };
}

/**
 * Subscribe a Device to lifecycle events. Returns an unsubscribe function.
 * Import-safe; wiring happens only when called.
 */
export function watchLifecycle(device: frida.Device, ev: LifecycleEvents): () => void {
  const onCrash = (c: frida.Crash): void => ev.onCrash?.(toCrashReport(c));
  const onChildAdded = (c: frida.Child): void => ev.onChildAdded?.(toChildInfo(c));
  const onChildRemoved = (c: frida.Child): void => ev.onChildRemoved?.(toChildInfo(c));
  const onSpawnAdded = (s: frida.Spawn): void => ev.onSpawnAdded?.(toSpawnInfo(s));
  const onSpawnRemoved = (s: frida.Spawn): void => ev.onSpawnRemoved?.(toSpawnInfo(s));

  if (ev.onCrash) device.processCrashed.connect(onCrash);
  if (ev.onChildAdded) device.childAdded.connect(onChildAdded);
  if (ev.onChildRemoved) device.childRemoved.connect(onChildRemoved);
  if (ev.onSpawnAdded) device.spawnAdded.connect(onSpawnAdded);
  if (ev.onSpawnRemoved) device.spawnRemoved.connect(onSpawnRemoved);

  return () => {
    if (ev.onCrash) device.processCrashed.disconnect(onCrash);
    if (ev.onChildAdded) device.childAdded.disconnect(onChildAdded);
    if (ev.onChildRemoved) device.childRemoved.disconnect(onChildRemoved);
    if (ev.onSpawnAdded) device.spawnAdded.disconnect(onSpawnAdded);
    if (ev.onSpawnRemoved) device.spawnRemoved.disconnect(onSpawnRemoved);
  };
}

/**
 * Turn on spawn gating so the Device queues new processes instead of letting
 * them run free; pair with watchLifecycle's onSpawnAdded to claim them.
 * Gating is Device-global and privileged on macOS — callers that enable it
 * MUST release it with device.disableSpawnGating() on teardown (startSession
 * does this via releaseLifecycle). Requires elevated privileges on macOS;
 * enableSpawnGating throws "requires additional privileges" otherwise.
 */
export async function enableSpawnGating(device: frida.Device): Promise<void> {
  await device.enableSpawnGating();
}

/**
 * Turn on child gating for an attached Session so the target's forked/spawned
 * children are queued and reported via Device's childAdded signal instead of
 * running free. NOTE: in frida 17 this is SESSION-level (not Device-level —
 * Device has no enableChildGating); pair with watchLifecycle's onChildAdded.
 * Gating ends with the session; call session.disableChildGating() on teardown
 * when the session outlives the interest (startSession does this via
 * releaseLifecycle).
 */
export async function enableChildGating(session: frida.Session): Promise<void> {
  await session.enableChildGating();
}
