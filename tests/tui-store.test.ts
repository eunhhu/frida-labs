import { expect, test } from "bun:test";
import type { ActionReceipt, DebugEvent } from "../src/core/index.js";
import {
  FLUSH_MS,
  MAX_SESSIONS,
  RING,
  TuiStore,
  classify,
  type TuiStoreOptions,
} from "../src/tui/store.js";

class FakeScheduler {
  now = 0;
  scheduleCount = 0;
  cancelCount = 0;
  private nextHandle = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  readonly schedule: NonNullable<TuiStoreOptions["schedule"]> = (callback, delayMs) => {
    const handle = this.nextHandle++;
    this.scheduleCount++;
    this.tasks.set(handle, { at: this.now + delayMs, callback });
    return handle;
  };

  readonly cancel: NonNullable<TuiStoreOptions["cancel"]> = (handle) => {
    this.cancelCount++;
    this.tasks.delete(handle as number);
  };

  readonly readNow = (): number => this.now;

  advance(ms: number): void {
    this.now += ms;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort(([leftHandle, left], [rightHandle, right]) => left.at - right.at || leftHandle - rightHandle)[0];
      if (!due) return;
      const [handle, task] = due;
      this.tasks.delete(handle);
      task.callback();
    }
  }
}

function makeStore(options: TuiStoreOptions = {}): { store: TuiStore; scheduler: FakeScheduler } {
  const scheduler = new FakeScheduler();
  return {
    store: new TuiStore({
      now: scheduler.readNow,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      ...options,
    }),
    scheduler,
  };
}

function receipt(action: string): ActionReceipt {
  return {
    sessionId: 1,
    action,
    mode: "instrument",
    status: "passed",
    startedAt: 1,
    completedAt: 2,
    result: { summary: action, rows: [], totalRows: 0, truncated: false },
    warnings: [],
  };
}

function debugEvent(summary: string): DebugEvent {
  return {
    kind: "agent-exception",
    timestamp: 3,
    summary,
  };
}

test("10k logs share one 33ms flush and retain the newest ring", () => {
  const { store, scheduler } = makeStore();
  const session = store.addSession("target");
  expect(session).not.toBeNull();

  let notifications = 0;
  store.subscribe(() => notifications++);
  for (let i = 0; i < 10_000; i++) store.pushLog(session!.id, `line ${i}`);

  expect(scheduler.scheduleCount).toBe(1);
  expect(notifications).toBe(0);
  expect(store.session(session!.id)?.logs).toHaveLength(0);

  scheduler.advance(FLUSH_MS - 1);
  expect(notifications).toBe(0);
  scheduler.advance(1);

  const retained = store.session(session!.id)!;
  expect(notifications).toBe(1);
  expect(retained.logs).toHaveLength(RING);
  expect(retained.logs[0]?.text).toBe("line 5000");
  expect(retained.logs.at(-1)?.text).toBe("line 9999");
  expect(retained.logs[0]?.ts).toBe(0);
  expect(retained.dropped).toBe(5000);
});

test("session cap, removal, and active fallback preserve the original picker behavior", () => {
  const { store } = makeStore();
  const sessions = Array.from({ length: MAX_SESSIONS }, (_, index) => store.addSession(`target-${index}`));

  expect(sessions.every(Boolean)).toBe(true);
  expect(store.addSession("over-cap")).toBeNull();
  expect(store.snapshot.sessions).toHaveLength(MAX_SESSIONS);

  const firstId = sessions[0]!.id;
  const lastId = sessions.at(-1)!.id;
  store.setActive(firstId);
  store.removeSession(firstId);
  expect(store.snapshot.activeId).toBe(lastId);
  expect(store.session(firstId)).toBeNull();

  const replacement = store.addSession("replacement");
  expect(replacement).not.toBeNull();
  expect(replacement!.id).toBeGreaterThan(lastId);
  expect(store.snapshot.activeId).toBe(replacement!.id);

  store.removeSession(replacement!.id);
  expect(store.snapshot.activeId).toBe(lastId);
});

test("typed histories update immediately and disappear with their session", () => {
  const { store } = makeStore();
  const session = store.addSession("target")!;
  const receipts = [receipt("scan"), receipt("hook")];
  const events = [debugEvent("first"), debugEvent("second")];
  let notifications = 0;
  store.subscribe(() => notifications++);

  store.setActionHistory(session.id, { receipts, bytes: 20, droppedReceipts: 4 });
  expect(notifications).toBe(1);
  expect(store.session(session.id)?.receipts).toBe(receipts);
  expect(store.session(session.id)?.droppedReceipts).toBe(4);

  store.setDebugHistory(session.id, { events, bytes: 30, droppedDebugEvents: 5 });
  expect(notifications).toBe(2);
  expect(store.session(session.id)?.debugEvents).toBe(events);
  expect(store.session(session.id)?.droppedDebugEvents).toBe(5);

  store.removeSession(session.id);
  expect(store.session(session.id)).toBeNull();
  const replacement = store.addSession("replacement")!;
  expect(replacement.receipts).toEqual([]);
  expect(replacement.droppedReceipts).toBe(0);
  expect(replacement.debugEvents).toEqual([]);
  expect(replacement.droppedDebugEvents).toBe(0);
});

test("classification, observe freeze, and bounded unique REPL history stay compatible", () => {
  expect(classify("[+] installed", false)).toEqual({ tag: "+", level: "ok" });
  expect(classify("[!] caution", false)).toEqual({ tag: "!", level: "warn" });
  expect(classify("[x] failed", false)).toEqual({ tag: "x", level: "error" });
  expect(classify("plain error", true)).toEqual({ tag: null, level: "error" });
  expect(classify("plain info", false)).toEqual({ tag: null, level: "info" });

  const { store, scheduler } = makeStore();
  const session = store.addSession("target")!;
  store.toggleFrozen(session.id);
  expect(store.session(session.id)?.frozen).toBe(true);
  store.toggleFrozen(session.id);
  expect(store.session(session.id)?.frozen).toBe(false);

  for (let i = 0; i < 201; i++) store.pushHistory(session.id, `command-${i}`);
  store.pushHistory(session.id, "command-1");
  const history = store.session(session.id)!.history;
  expect(history).toHaveLength(200);
  expect(history[0]).toBe("command-2");
  expect(history.at(-1)).toBe("command-1");
  expect(history.filter((entry) => entry === "command-1")).toHaveLength(1);
  expect(scheduler.scheduleCount).toBe(1);
});

test("pending events are grouped in one pass and render reads do not scan", () => {
  let operations = 0;
  const { store, scheduler } = makeStore({ countOperations: (count) => { operations += count; } });
  const sessions = Array.from({ length: MAX_SESSIONS }, (_, index) => store.addSession(`target-${index}`)!);
  const eventCount = 1_000;

  for (let i = 0; i < eventCount; i++) {
    const session = sessions[i % sessions.length]!;
    store.pushEvent(session.id, { type: "crash", report: `report-${i}` });
  }
  expect(scheduler.scheduleCount).toBe(1);
  scheduler.advance(FLUSH_MS);

  expect(operations).toBe(eventCount + sessions.length);
  for (const session of sessions) expect(store.session(session.id)?.crashes).toHaveLength(16);
  expect(store.session(sessions[0]!.id)?.crashes[0]).toBe("report-872");
  expect(store.session(sessions[0]!.id)?.crashes.at(-1)).toBe("report-992");

  const operationsAfterFlush = operations;
  for (let i = 0; i < 100; i++) {
    void store.snapshot;
    void store.getVersion();
    void store.session(sessions[i % sessions.length]!.id);
  }
  expect(operations).toBe(operationsAfterFlush);
});

test("an immediate mutation drains an existing batch without a second notification", () => {
  const { store, scheduler } = makeStore();
  const session = store.addSession("target")!;
  let notifications = 0;
  store.subscribe(() => notifications++);

  store.pushLog(session.id, "queued");
  store.setResult(session.id, true, "done");

  expect(notifications).toBe(1);
  expect(store.session(session.id)?.logs.map((line) => line.text)).toEqual(["queued"]);
  expect(store.session(session.id)?.lastResult).toEqual({ ok: true, text: "done" });
  scheduler.advance(FLUSH_MS);
  expect(notifications).toBe(1);
});
