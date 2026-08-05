// External TUI store — all render state lives outside React and flushes in
// 33ms batches so high-frequency agent logs never become a setState storm.
// Components subscribe via useSyncExternalStore(subscribe, getVersion) and
// read through the typed getters. No frida/session objects live here — the
// workbench owns GameSession handles; the store holds only render state.

import type {
  ActionReceipt,
  DebugEvent,
  DebugHistory,
  ReceiptHistory,
  RpcDescriptor,
  DeviceInfo,
} from "../core/index.js";

export type LogLevel = "ok" | "info" | "warn" | "error";

export interface LogLine {
  ts: number;
  level: LogLevel;
  /** Bracket tag when the agent line carries one ("+", "!", "x"), else null. */
  tag: string | null;
  text: string;
}

export type SessionStatus = "connecting" | "live" | "detached" | "closed" | "error";


export interface SessionState {
  id: number;
  target: string;
  /** Entry-path targets carry the process name for attach/reconnect. */
  proc?: string;
  process: string;
  pid: number | null;
  /** Selected device while connecting; resolved identity once live. */
  deviceLabel: string;
  device: DeviceInfo | null;
  status: SessionStatus;
  /** Last status detail: attach progress, detach reason, or error message. */
  detail: string;
  logs: LogLine[];
  /** Lines evicted from the ring buffer (rendered as a drop marker). */
  dropped: number;
  /** Retained action receipts from the typed action service. */
  receipts: readonly ActionReceipt[];
  droppedReceipts: number;
  /** Retained structured debug events from the typed action service. */
  debugEvents: readonly DebugEvent[];
  droppedDebugEvents: number;
  /** Observe panel freeze: new logs keep collecting but the view pins. */
  frozen: boolean;
  /** Cached describe() result; null until the first successful call. */
  describe: RpcDescriptor[] | null;
  /** Crash reports received over the structured channel. */
  crashes: unknown[];
  /** REPL input history (oldest first), capped. */
  history: string[];
  /** Last rpc/eval result rendered by the result inspector. */
  lastResult: { ok: boolean; text: string } | null;
}

export interface TuiState {
  sessions: SessionState[];
  activeId: number | null;
}

const MAX_SESSIONS = 8;
const RING = 5000;
const HISTORY = 200;
export const FLUSH_MS = 33;

/** Classify a flattened agent log line into level + bracket tag. */
export function classify(text: string, isError: boolean): Pick<LogLine, "level" | "tag"> {
  const m = /\[([+!x])\]/.exec(text);
  if (m) {
    const tag = m[1]!;
    return { tag, level: tag === "x" ? "error" : tag === "!" ? "warn" : "ok" };
  }
  return { tag: null, level: isError ? "error" : "info" };
}

type Listener = () => void;

export interface TuiStoreOptions {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Test/diagnostic seam for work performed by flush/query processing. */
  countOperations?: (operations: number) => void;
}

type PendingEvent = { id: number; payload: Record<string, unknown> };

export class TuiStore {
  private state: TuiState = { sessions: [], activeId: null };
  private listeners = new Set<Listener>();
  private version = 0;
  private nextId = 1;
  private dirty = false;
  private timer: unknown | null = null;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly countOperations: (operations: number) => void;
  /** Log lines queued since the last flush, keyed by session id. */
  private pendingLogs = new Map<number, LogLine[]>();
  private pendingEvents: PendingEvent[] = [];

  constructor(options: TuiStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.countOperations = options.countOperations ?? (() => {});
  }
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  get snapshot(): TuiState {
    return this.state;
  }

  session(id: number | null): SessionState | null {
    if (id === null) return null;
    return this.state.sessions.find((s) => s.id === id) ?? null;
  }

  /** Bump the version and notify — coalesced into 33ms flushes. */
  private touch(immediate = false): void {
    this.dirty = true;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = this.schedule(this.flush, FLUSH_MS);
  }

  /** Apply queued logs/events and notify subscribers at most once. */
  flush = (): void => {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;

    if (this.pendingLogs.size || this.pendingEvents.length) {
      const crashesBySession = new Map<number, unknown[]>();
      for (const event of this.pendingEvents) {
        if (event.payload.type !== "crash") continue;
        const report = event.payload.report ?? event.payload;
        const crashes = crashesBySession.get(event.id);
        if (crashes) crashes.push(report);
        else crashesBySession.set(event.id, [report]);
      }
      this.countOperations(this.pendingEvents.length);

      const sessions = this.state.sessions.map((s) => {
        const queued = this.pendingLogs.get(s.id);
        const crashes = crashesBySession.get(s.id);
        if (!queued?.length && !crashes?.length) return s;
        let next = s;
        if (queued?.length) {
          const merged = [...s.logs, ...queued];
          const overflow = merged.length - RING;
          next = {
            ...next,
            logs: overflow > 0 ? merged.slice(overflow) : merged,
            dropped: s.dropped + (overflow > 0 ? overflow : 0),
          };
        }
        if (crashes?.length) {
          next = { ...next, crashes: [...next.crashes, ...crashes].slice(-16) };
        }
        return next;
      });
      this.countOperations(this.state.sessions.length);
      this.state = { ...this.state, sessions };
      this.pendingLogs.clear();
      this.pendingEvents = [];
    }
    this.version++;
    for (const fn of this.listeners) fn();
  };

  private patch(id: number, partial: Partial<SessionState>, immediate = false): void {
    this.state = {
      ...this.state,
      sessions: this.state.sessions.map((s) => (s.id === id ? { ...s, ...partial } : s)),
    };
    this.touch(immediate);
  }

  /** Register a session in the picker→connecting transition. Returns its id,
   *  or null when the session cap (8) is reached. */
  addSession(target: string, proc?: string, deviceLabel = "local"): SessionState | null {
    if (this.state.sessions.length >= MAX_SESSIONS) return null;
    const s: SessionState = {
      id: this.nextId++,
      target,
      ...(proc ? { proc } : {}),
      process: "",
      pid: null,
      deviceLabel,
      device: null,
      status: "connecting",
      detail: "compiling …",
      logs: [],
      dropped: 0,
      receipts: [],
      droppedReceipts: 0,
      debugEvents: [],
      droppedDebugEvents: 0,
      frozen: false,
      describe: null,
      crashes: [],
      history: [],
      lastResult: null,
    };
    this.state = { sessions: [...this.state.sessions, s], activeId: s.id };
    this.touch(true);
    return s;
  }

  setActive(id: number): void {
    if (this.state.activeId === id) return;
    this.state = { ...this.state, activeId: id };
    this.touch(true);
  }

  patchSession(id: number, partial: Partial<SessionState>, immediate = false): void {
    this.patch(id, partial, immediate);
  }

  /** Queue a log line for the next 33ms flush (never throws, never blocks). */
  pushLog(id: number, text: string, isError = false): void {
    const { level, tag } = classify(text, isError);
    const line: LogLine = { ts: this.now(), level, tag, text };
    const q = this.pendingLogs.get(id);
    if (q) q.push(line);
    else this.pendingLogs.set(id, [line]);
    this.touch();
  }

  pushEvent(id: number, payload: Record<string, unknown>): void {
    this.pendingEvents.push({ id, payload });
    this.touch();
  }

  pushHistory(id: number, src: string): void {
    const s = this.session(id);
    if (!s) return;
    const history = [...s.history.filter((h) => h !== src), src].slice(-HISTORY);
    this.patch(id, { history });
  }

  setResult(id: number, ok: boolean, text: string): void {
    this.patch(id, { lastResult: { ok, text } }, true);
  }

  setDescribe(id: number, describe: RpcDescriptor[]): void {
    this.patch(id, { describe }, true);
  }


  setActionHistory(id: number, history: ReceiptHistory): void {
    this.patch(id, {
      receipts: history.receipts,
      droppedReceipts: history.droppedReceipts,
    }, true);
  }

  setDebugHistory(id: number, history: DebugHistory): void {
    this.patch(id, {
      debugEvents: history.events,
      droppedDebugEvents: history.droppedDebugEvents,
    }, true);
  }

  toggleFrozen(id: number): void {
    const s = this.session(id);
    if (s) this.patch(id, { frozen: !s.frozen }, true);
  }

  /** Remove a closed session from the list (keeps the ring alive until then). */
  removeSession(id: number): void {
    const sessions = this.state.sessions.filter((s) => s.id !== id);
    const activeId = this.state.activeId === id ? (sessions[sessions.length - 1]?.id ?? null) : this.state.activeId;
    this.state = { sessions, activeId };
    this.touch(true);
  }
}

export const store = new TuiStore();
export { MAX_SESSIONS, RING };
