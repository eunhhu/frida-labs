// Workbench — multi-session lifecycle owner (attach / switch / reconnect /
// close) plus the sidebar and status header renderers. GameSession handles
// live here (not in the store); every attach goes through the SessionEngine
// core, never around it.

import React from "react";
import { Box, Text } from "ink";
import { startSession, type GameSession } from "../core/index.js";
import { store, MAX_SESSIONS, type SessionState } from "./store.js";

class Workbench {
  private handles = new Map<number, GameSession>();
  /** Serializes attach attempts so a slow compile cannot interleave with a close. */
  private chains = new Map<number, Promise<void>>();
  /** Ids whose close was requested while a launch was still in flight — the
   *  late session is torn down instead of being installed (closed->live fix). */
  private closeRequested = new Set<number>();

  handle(id: number | null): GameSession | null {
    return id === null ? null : (this.handles.get(id) ?? null);
  }

  attach(target: string, proc?: string): void {
    const slot = store.addSession(target, proc);
    if (!slot) {
      // Session cap: surface as a transient picker-level notice.
      return;
    }
    void this.launch(slot.id, target, proc);
  }

  /** Re-attach a detached/errored session in place (same id, fresh agent). */
  reconnect(id: number): void {
    const s = store.session(id);
    if (!s || s.status === "connecting" || s.status === "live") return;
    void this.teardownHandle(id);
    store.patchSession(id, { status: "connecting", detail: "reconnecting …", pid: null }, true);
    void this.launch(id, s.target, s.proc);
  }

  private launch(id: number, target: string, proc?: string): Promise<void> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        const session = await startSession(
          { target, processOverride: proc },
          {
            onLog: (l) => store.pushLog(id, l),
            onError: (l) => store.pushLog(id, l, true),
            onEvent: (p) => store.pushEvent(id, p),
            onClose: (reason) => {
              store.patchSession(id, { status: "detached", detail: `detached: ${reason}` });
              store.pushLog(id, `detached: ${reason}`, true);
              void this.teardownHandle(id);
            },
          },
        );
        if (this.closeRequested.has(id)) {
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
          detail: `attached — pid ${session.pid}`,
        }, true);
        // Prime the explorer cache; describe() falls back to seen names.
        void session.describe()
          .then((d) => store.setDescribe(id, d))
          .catch(() => { /* fallback: explorer re-fetches on demand */ });
      } catch (e) {
        store.patchSession(id, { status: "error", detail: (e as Error).message }, true);
        store.pushLog(id, (e as Error).message, true);
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
  }

  private async teardownHandle(id: number): Promise<void> {
    const h = this.handles.get(id);
    this.handles.delete(id);
    if (h) {
      try { await h.close(); } catch { /* detach errors are not actionable here */ }
    }
  }
}

export const workbench = new Workbench();

const statusTint: Record<SessionState["status"], string> = {
  connecting: "yellow", live: "green", detached: "magenta", closed: "gray", error: "red",
};

/** Left column: attachable targets plus live/detached sessions. */
export function Sidebar(props: {
  targets: string[];
  pickerIndex: number;
  sessions: SessionState[];
  activeId: number | null;
  focus: "targets" | "sessions";
}): React.JSX.Element {
  return (
    <Box flexDirection="column" width={26} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold underline>targets</Text>
      {props.targets.length === 0 && <Text color="yellow">none — flab new</Text>}
      {props.targets.map((t, i) => (
        <Text key={t} color={props.focus === "targets" && i === props.pickerIndex ? "green" : undefined}>
          {props.focus === "targets" && i === props.pickerIndex ? "❯ " : "  "}{t}
        </Text>
      ))}
      <Text> </Text>
      <Text bold underline>sessions ({props.sessions.length}/{MAX_SESSIONS})</Text>
      {props.sessions.length === 0 && <Text dimColor>none — enter attaches</Text>}
      {props.sessions.map((s) => (
        <Text key={s.id} color={s.id === props.activeId ? statusTint[s.status] : "gray"}>
          {s.id === props.activeId ? "● " : "○ "}#{s.id} {s.target} <Text dimColor>{s.status}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Top bar: active session facts at a glance. */
export function StatusHeader(props: { session: SessionState | null }): React.JSX.Element {
  const s = props.session;
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text bold>flab</Text>
      {s ? (
        <Text color={statusTint[s.status]}>
          #{s.id} {s.target}
          {s.process ? ` (${s.process})` : ""}
          {s.pid ? ` pid ${s.pid}` : ""} — {s.status}
          {s.describe ? ` · ${s.describe.length} exports` : ""}
          {s.crashes.length ? ` · ${s.crashes.length} crash(es)` : ""}
          {s.frozen ? " · FROZEN" : ""}
        </Text>
      ) : (
        <Text dimColor>no session — pick a target</Text>
      )}
      <Text dimColor>tab: panel · ^t/^s: list · ^r: reconnect · ^w: close · ^q: quit</Text>
    </Box>
  );
}
