// Workbench — multi-session lifecycle owner (attach / switch / reconnect /
// close) plus the sidebar and status header renderers. GameSession handles
// live here (not in the store); every attach goes through the SessionEngine
// core, never around it.

import React from "react";
import { Box, Text, useWindowSize } from "ink";
import {
  ActionService,
  resolveLaunchRequest,
  startLaunch,
  type ActionMode,
  type ActionReceipt,
  type DebugEventInput,
  deviceSelectorLabel,
  type DeviceSelector,
  type GameSession,
  type LaunchRequest,
  type ProcessCandidate,
  type RpcDescriptor,
  RecordingCoordinator,
  type AnalysisRecordMetadata,
  type AnalysisRecordOptions,
  type AnalysisRecordProbe,
  type AnalysisRecordSummary,
  type RecordPlanResult,
} from "../core/index.js";
import { store, MAX_SESSIONS, type SessionState } from "./store.js";


class Workbench {
  private handles = new Map<number, GameSession>();
  private requests = new Map<number, LaunchRequest>();
  private actions = new ActionService();
  private actionChains = new Map<number, Set<Promise<ActionReceipt>>>();
  /** Serializes attach attempts so a slow compile cannot interleave with a close. */
  private chains = new Map<number, Promise<void>>();
  /** Ids whose close was requested while a launch was still in flight — the
   *  late session is torn down instead of being installed (closed->live fix). */
  private closeRequested = new Set<number>();
  private recordings = new Map<number, RecordingCoordinator>();

  handle(id: number | null): GameSession | null {
    return id === null ? null : (this.handles.get(id) ?? null);
  }

  async refreshDescribe(id: number): Promise<RpcDescriptor[]> {
    const session = this.handle(id);
    if (!session) throw new Error("session is not live");
    const descriptors = await session.describe();
    store.setDescribe(id, descriptors);
    return descriptors;
  }


  async eval(id: number, source: string): Promise<unknown> {
    const session = this.handle(id);
    if (!session) throw new Error("session is not live");
    return session.eval(source);
  }

  async invokeAction(
    id: number,
    mode: ActionMode,
    action: string,
    rawArgs: readonly string[],
    offset = 0,
  ): Promise<ActionReceipt> {
    if (this.closeRequested.has(id)) throw new Error("session is closing");
    const session = this.handle(id);
    if (!session) throw new Error("session is not live");

    const pending = this.actions.invoke(session, {
      sessionId: id,
      mode,
      action,
      rawArgs,
      ...(offset ? { offset } : {}),
    });
    const actions = this.actionChains.get(id) ?? new Set<Promise<ActionReceipt>>();
    actions.add(pending);
    this.actionChains.set(id, actions);
    this.syncActionState(id);

    let receipt: ActionReceipt;
    try {
      receipt = await pending;
    } finally {
      actions.delete(pending);
      if (actions.size === 0 && this.actionChains.get(id) === actions) this.actionChains.delete(id);
      this.syncActionState(id);
    }

    if (mode === "debug" || receipt.verification || receipt.statusAction) {
      this.recordDebug(id, {
        kind: "hook-receipt",
        summary: `${receipt.action}: ${receipt.status}`,
        action: receipt.action,
        actionStatus: receipt.status,
        ...(receipt.verification ? { verification: receipt.verification } : {}),
        report: receipt.result,
      });
    }
    return receipt;
  }

  private recording(id: number): RecordingCoordinator {
    const current = this.recordings.get(id);
    if (current) return current;
    const created = new RecordingCoordinator();
    this.recordings.set(id, created);
    return created;
  }

  async planRecord(id: number, query: string, module?: string, limit = 24): Promise<RecordPlanResult> {
    const session = this.handle(id);
    if (!session) throw new Error("session is not live");
    return this.recording(id).plan(session, query, module, limit);
  }

  async startRecord(
    id: number,
    label: string,
    probes: AnalysisRecordProbe[],
    options?: AnalysisRecordOptions,
  ): Promise<AnalysisRecordMetadata> {
    const session = this.handle(id);
    if (!session) throw new Error("session is not live");
    return this.recording(id).start(
      session,
      { target: session.target, process: session.process, pid: session.pid, device: session.device },
      label,
      probes,
      options,
    );
  }

  async recordStatus(id: number): Promise<{ record: AnalysisRecordMetadata | null; agent: unknown; completed: AnalysisRecordMetadata | null }> {
    const recording = this.recordings.get(id);
    return recording ? recording.status() : { record: null, agent: null, completed: null };
  }

  async stopRecord(id: number): Promise<AnalysisRecordMetadata | null> {
    return this.recordings.get(id)?.stop("requested") ?? null;
  }

  recordList(id: number): AnalysisRecordMetadata[] {
    return this.recording(id).store.list();
  }

  async recordSummary(id: number, recordId: string): Promise<AnalysisRecordSummary> {
    return this.recording(id).store.summary(recordId);
  }

  /** Compatibility wrapper for the original registered-target attach surface. */
  attach(target: string, proc?: string, device?: DeviceSelector): void {
    this.open({
      kind: "target",
      target,
      ...(proc ? { processOverride: proc } : {}),
      ...(device ? { device } : {}),
    });
  }

  /** Open one validated target/probe launch in a normal workbench slot. */
  open(request: LaunchRequest): SessionState | null {
    const { options, initialDisplay } = resolveLaunchRequest(request);
    const canonical: LaunchRequest = request.kind === "target"
      ? Object.freeze({
          kind: "target",
          target: options.target,
          ...(options.processOverride ? { processOverride: options.processOverride } : {}),
          ...(options.spawnGating === undefined ? {} : { spawnGating: options.spawnGating }),
          ...(options.childGating === undefined ? {} : { childGating: options.childGating }),
          ...(options.device === undefined ? {} : { device: options.device }),
        })
      : request.kind === "probe-attach-name"
        ? Object.freeze({
            kind: "probe-attach-name",
            process: options.processOverride!,
            ...(options.childGating === undefined ? {} : { childGating: options.childGating }),
            ...(options.device === undefined ? {} : { device: options.device }),
          })
        : request.kind === "probe-attach-pid"
          ? Object.freeze({
              kind: "probe-attach-pid",
              pid: options.attachPid!,
              ...(request.display === undefined ? {} : { display: options.processDisplay }),
              ...(options.childGating === undefined ? {} : { childGating: options.childGating }),
              ...(options.device === undefined ? {} : { device: options.device }),
            })
          : Object.freeze({
              kind: "probe-spawn",
              executable: options.processOverride!,
              ...(options.device === undefined ? {} : { device: options.device }),
            });
    const target = request.kind === "target" ? options.target : "_probe";
    const proc = request.kind === "target" ? options.processOverride : initialDisplay;
    const slot = store.addSession(
      target,
      proc,
      options.device ? deviceSelectorLabel(options.device) : "manifest/default",
    );
    if (!slot) return null;
    this.requests.set(slot.id, canonical);
    void this.runLaunch(slot.id, canonical);
    return slot;
  }

  /** Re-attach a detached/errored session in place (same id, fresh agent). */
  reconnect(id: number, confirmProbeSpawn = false): boolean {
    const state = store.session(id);
    if (!state || state.status === "connecting" || state.status === "live") return false;
    const request = this.requests.get(id) ?? {
      kind: "target" as const,
      target: state.target,
      ...(state.proc ? { processOverride: state.proc } : {}),
    };
    if (request.kind === "probe-spawn" && !confirmProbeSpawn) {
      store.patchSession(id, { detail: "probe spawn reconnect requires confirmation" }, true);
      return false;
    }
    store.patchSession(id, { status: "connecting", detail: "reconnecting …", pid: null }, true);
    // Serialize teardown before the next attach so old and new scripts cannot
    // overlap hooks in the same process.
    const pending = this.chains.get(id) ?? Promise.resolve();
    this.chains.set(id, pending.catch(() => { /* prior launch state is already surfaced */ }).then(() => this.teardownHandle(id)));
    void this.runLaunch(id, request);
    return true;
  }

  private runLaunch(id: number, request: LaunchRequest): Promise<void> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      let detachedDuringLaunch = false;
      try {
        const session = await startLaunch(
          request,
          {
            onLog: (line) => store.pushLog(id, line),
            onError: (line) => store.pushLog(id, line, true),
            onAgentError: (detail) => {
              this.recordDebug(id, { kind: "agent-exception", summary: "Agent exception", detail });
            },
            onEvent: (payload) => {
              if (payload.type === "flab.record.event" || payload.type === "flab.record.state") {
                this.recordings.get(id)?.capture(payload);
                if (payload.type === "flab.record.event") return;
              }
              store.pushEvent(id, payload);
              if (payload.type === "crash") {
                this.recordDebug(id, {
                  kind: "agent-exception",
                  summary: typeof payload.summary === "string" ? payload.summary : "Agent exception report",
                  report: payload.report ?? payload,
                });
              }
            },
            onCrash: (report) => {
              store.pushEvent(id, { type: "process-crash", report });
              this.recordDebug(id, {
                kind: "process-crash",
                summary: report.summary || `${report.processName} crashed`,
                detail: `${report.processName} (pid ${report.pid})`,
                report,
              });
            },
            onChildAdded: (child) => {
              store.pushEvent(id, { type: "child-added", child });
              this.recordDebug(id, { kind: "child", summary: `Child added: ${child.identifier ?? child.path ?? child.pid}` , report: child });
            },
            onChildRemoved: (child) => {
              store.pushEvent(id, { type: "child-removed", child });
              this.recordDebug(id, { kind: "child", summary: `Child removed: ${child.identifier ?? child.path ?? child.pid}`, report: child });
            },
            onSpawnAdded: (spawn) => {
              store.pushEvent(id, { type: "spawn-added", spawn });
              this.recordDebug(id, { kind: "spawn", summary: `Spawn added: ${spawn.identifier ?? spawn.pid}`, report: spawn });
            },
            onSpawnRemoved: (spawn) => {
              store.pushEvent(id, { type: "spawn-removed", spawn });
              this.recordDebug(id, { kind: "spawn", summary: `Spawn removed: ${spawn.identifier ?? spawn.pid}`, report: spawn });
            },
            onClose: (reason) => {
              detachedDuringLaunch = true;
              store.pushEvent(id, { type: "session-detached", reason });
              this.recordDebug(id, { kind: "session-detached", summary: `Session detached: ${reason}` });
              store.patchSession(id, { status: "detached", detail: `detached: ${reason}` });
              store.pushLog(id, `detached: ${reason}`, true);
              void this.teardownHandle(id);
            },
          },
        );
        if (this.closeRequested.has(id) || detachedDuringLaunch) {
          // Closed while compiling/attaching: tear the late session down
          // instead of resurrecting the record as live.
          try { await session.close(); } catch { /* best effort */ }
          return;
        }
        this.handles.set(id, session);
        store.patchSession(id, {
          status: "live",
          process: session.process,
          pid: session.pid,
          device: session.device,
          deviceLabel: `${session.device.name} [${session.device.id}]`,
          detail: `attached — pid ${session.pid} · ${session.device.type}:${session.device.id}`,
        }, true);
        void session.describe()
          .then((descriptors) => store.setDescribe(id, descriptors))
          .catch((error) => store.pushLog(id, `[descriptor] ${(error as Error).message}`, true));
      } catch (error) {
        store.patchSession(id, { status: "error", detail: (error as Error).message }, true);
        store.pushLog(id, (error as Error).message, true);
      }
    });
    this.chains.set(id, next);
    // Identity-guarded settle cleanup: completed launches must not retain
    // per-id entries (session churn would grow this map and closeAll's work).
    void next.finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return next;
  }

  async close(id: number): Promise<void> {
    this.closeRequested.add(id);
    try {
      // Join any in-flight launch so its late session is cancelled above
      // before we declare the record closed.
      await (this.chains.get(id) ?? Promise.resolve());
      await this.waitForActions(id);
      if (this.handles.has(id)) {
        this.recordDebug(id, { kind: "session-detached", summary: "Session closed by user" });
      }
      await this.teardownHandle(id);
      store.patchSession(id, { status: "closed", detail: "closed" }, true);
    } finally {
      this.closeRequested.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    const ids = new Set<number>([...this.handles.keys(), ...this.chains.keys()]);
    for (const id of store.snapshot.sessions.map((s) => s.id)) ids.add(id);
    await Promise.all([...ids].map((id) => this.close(id)));
  }

  /** Drop every per-id remnant after the row leaves the store. */
  dropSession(id: number): void {
    this.chains.delete(id);
    this.closeRequested.delete(id);
    this.handles.delete(id);
    this.requests.delete(id);
    this.actionChains.delete(id);
    this.recordings.delete(id);
    this.actions.removeSession(id);
  }

  private async teardownHandle(id: number): Promise<void> {
    const h = this.handles.get(id);
    this.handles.delete(id);
    const recording = this.recordings.get(id);
    if (recording) {
      try { await recording.stop("session-close"); } catch { /* metadata remains interrupted */ }
    }
    if (h) {
      try { await h.close(); } catch { /* detach errors are not actionable here */ }
    }
  }
  private async waitForActions(id: number): Promise<void> {
    const pending = this.actionChains.get(id);
    if (!pending?.size) return;
    await Promise.allSettled([...pending]);
  }

  private syncActionState(id: number): void {
    store.setActionHistory(id, this.actions.receiptHistory(id));
    store.setDebugHistory(id, this.actions.debugHistory(id));
  }

  private recordDebug(id: number, input: DebugEventInput): void {
    this.actions.recordDebugEvent(id, input);
    store.setDebugHistory(id, this.actions.debugHistory(id));
  }
}

export const workbench = new Workbench();

const statusTint: Record<SessionState["status"], string> = {
  connecting: "yellow", live: "green", detached: "magenta", closed: "gray", error: "red",
};

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}

function windowAround<T>(items: readonly T[], cursor: number, size: number): Array<{ item: T; index: number }> {
  const start = Math.max(0, Math.min(cursor - (size >> 1), Math.max(0, items.length - size)));
  return items.slice(start, start + size).map((item, offset) => ({ item, index: start + offset }));
}

/** Left column: one connect flow, with sessions shown only after they exist. */
export function Sidebar(props: {
  expanded?: boolean;
  deviceLabel: string;
  deviceCount: number;
  processes: ProcessCandidate[];
  processTotal: number;
  processIndex: number;
  processQuery: string;
  processFilterActive: boolean;
  processesLoading: boolean;
  processesError: string | null;
  targets: string[];
  pickerIndex: number;
  sessions: SessionState[];
  activeId: number | null;
  focus: "processes" | "targets" | "sessions" | null;
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const minimal = Boolean(props.expanded && windowSize.rows < 28);
  const listSize = minimal ? 2 : 3;
  const selectedProcess = props.processes[props.processIndex];
  const matchedTarget = selectedProcess?.matchedTargets[0];
  const multipleMatches = (selectedProcess?.matchedTargets.length ?? 0) > 1;
  const showConnectLists = props.sessions.length === 0 || props.focus === "processes" || props.focus === "targets";
  return (
    <Box
      flexDirection="column"
      width={props.expanded ? undefined : 36}
      flexGrow={props.expanded ? 1 : 0}
      flexShrink={0}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold color="cyan">{props.sessions.length ? "CONNECTION" : "1. CONNECT"}</Text>
      <Text>Device: {clip(props.deviceLabel, 24)}</Text>
      <Text dimColor>Ctrl+V device ({props.deviceCount} found)</Text>
      {props.sessions.length > 0 && (
        <>
          {!minimal && <Text> </Text>}
          <Text bold underline>connections ({props.sessions.length}/{MAX_SESSIONS})</Text>
          {windowAround(props.sessions, Math.max(0, props.sessions.findIndex((session) => session.id === props.activeId)), 3).map(({ item: s }) => (
            <Text key={s.id} color={s.id === props.activeId ? statusTint[s.status] : "gray"}>
              {s.id === props.activeId ? "● " : "○ "}#{s.id} {clip(s.target, 14)} <Text dimColor>{s.status}</Text>
            </Text>
          ))}
          <Text dimColor>Ctrl+D change app · Ctrl+T saved</Text>
        </>
      )}
      {showConnectLists && (
        <>
          {!minimal && <Text> </Text>}
          {props.focus !== "targets" && <><Text bold underline>running apps · {props.processTotal} found</Text>
          {(props.processFilterActive || props.processQuery) && (
            <Text color={props.processFilterActive ? "yellow" : "gray"}>
              search: {props.processQuery || "type game name"}{props.processFilterActive ? "_" : ""}
            </Text>
          )}
          {props.processesLoading && <Text color="yellow">discovering…</Text>}
          {props.processesError && <Text color="red">{clip(props.processesError, 30)}</Text>}
          {!props.processesLoading && !props.processesError && props.processes.length === 0 && props.processFilterActive && !props.processQuery && (
            <Text color="yellow">start typing to search</Text>
          )}
          {!props.processesLoading && !props.processesError && props.processes.length === 0 && (!props.processFilterActive || props.processQuery) && (
            <Text color="yellow">no matching running app</Text>
          )}
          {windowAround(props.processes, props.processIndex, listSize).map(({ item, index }) => (
            <Text key={`${item.pid}-${item.name}`} color={props.focus === "processes" && index === props.processIndex ? "cyan" : undefined}>
              {props.focus === "processes" && index === props.processIndex ? "❯ " : "  "}
              {item.matchedTargets.length ? "◆ " : "· "}{clip(item.name, 18)} <Text dimColor>PID {item.pid}</Text>
            </Text>
          ))}
          <Text dimColor>
            {selectedProcess
              ? `PID ${selectedProcess.pid} · ${multipleMatches
                  ? `${selectedProcess.matchedTargets.length} saved matches`
                  : matchedTarget ? `saved: ${clip(matchedTarget, 14)}` : "quick analysis"}`
              : props.processFilterActive ? "Esc shows every process" : "/ starts search"}
          </Text>
          <Text dimColor>{selectedProcess ? "Enter connect · n save · r refresh" : "Tab saved games · r refresh"}</Text>
          </>}
          {props.focus === "targets" && <><Text bold underline>saved games · {props.targets.length} found</Text>
          {props.targets.length === 0 && <Text color="yellow">none yet — n creates one</Text>}
          {windowAround(props.targets, props.pickerIndex, listSize).map(({ item: t, index: i }) => (
            <Text key={t} color={props.focus === "targets" && i === props.pickerIndex ? "green" : undefined}>
              {props.focus === "targets" && i === props.pickerIndex ? "❯ " : "  "}{clip(t, 29)}
            </Text>
          ))}
          <Text dimColor>Tab switch list · Enter connect · m manage</Text>
          </>}
        </>
      )}
    </Box>
  );
}

/** Top bar: active session facts at a glance. */
export function StatusHeader(props: { session: SessionState | null; deviceLabel: string; compact: boolean }): React.JSX.Element {
  const s = props.session;
  const heading = !s
    ? "1 CONNECT"
    : s.status === "live"
      ? "CONNECTED"
      : s.status === "connecting"
        ? "CONNECTING"
        : s.status === "error"
          ? "CONNECTION ERROR"
          : s.status.toUpperCase();
  if (props.compact) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text bold>flab · {heading}  </Text>
          {s ? (
            <Text color={statusTint[s.status]}>
              #{s.id} {clip(s.target, 18)}{s.pid ? ` · pid ${s.pid}` : ""}{s.describe ? ` · ${s.describe.length} actions` : ""}
            </Text>
          ) : <Text dimColor>{clip(props.deviceLabel, 30)}</Text>}
        </Text>
        <Text dimColor>
          {s
            ? s.status === "live"
              ? "2 Analyze · 3 Instrument · Ctrl+P switch"
              : s.detail
            : "Type game name · ↑/↓ choose · Enter connect"}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={s?.status === "error" ? "red" : "gray"} paddingX={1}>
      <Box>
        <Text bold>flab · {heading}  </Text>
        {s ? (
          <Text color={statusTint[s.status]}>
            #{s.id} {clip(s.target, 22)}{s.process ? ` (${clip(s.process, 34)})` : ""}{s.pid ? ` pid ${s.pid}` : ""} — {s.status}
            {` · ${clip(s.device?.id ?? s.deviceLabel, 18)}`}
            {s.describe ? ` · ${s.describe.length} actions` : ""}
            {s.crashes.length ? ` · ${s.crashes.length} crash(es)` : ""}{s.frozen ? " · FROZEN" : ""}
          </Text>
        ) : <Text dimColor>{clip(props.deviceLabel, 32)} · type a game name or Tab to saved games</Text>}
      </Box>
      <Text dimColor>
        {s
          ? "2 Analyze · 3 Instrument · Ctrl+P switch"
          : "Type to search · ↑/↓ choose · Enter connect"}
      </Text>
      {s && s.detail && (
        <Text color={s.status === "error" ? "red" : s.status === "connecting" ? "yellow" : "gray"}>
          ↳ {s.detail}{s.status === "error" || s.status === "detached" ? " · Ctrl+R retry · Ctrl+W close" : ""}
        </Text>
      )}
    </Box>
  );
}
