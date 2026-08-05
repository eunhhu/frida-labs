import { afterAll, afterEach, expect, test } from "bun:test";
import { unwatchAll, watch } from "../agent/lib/watch.js";

const globals = globalThis as Record<string, unknown>;
const originalProcess = globals.Process;
const originalSend = globals.send;

class FakeThread {
  readonly sets: number[] = [];
  readonly unsets: number[] = [];
  constructor(readonly id: number, private readonly supportedSlots = 4) {}
  setHardwareWatchpoint(slot: number): void {
    if (slot >= this.supportedSlots) throw new Error("unsupported slot");
    this.sets.push(slot);
  }
  unsetHardwareWatchpoint(slot: number): void { this.unsets.push(slot); }
}

afterEach(() => {
  unwatchAll();
});

afterAll(() => {
  unwatchAll();
  if (originalProcess === undefined) delete globals.Process;
  else globals.Process = originalProcess;
  if (originalSend === undefined) delete globals.send;
  else globals.send = originalSend;
});

test("watch warns and throws when no thread can be armed", () => {
  const thread = new FakeThread(7, 0);
  const messages: unknown[] = [];
  globals.Process = {
    enumerateThreads: () => [thread],
    setExceptionHandler: () => {},
  };
  globals.send = (message: unknown) => { messages.push(message); };

  expect(() => watch({ toString: () => "0x1000" } as never))
    .toThrow("could not arm any thread");
  expect(messages).toContainEqual({
    type: "log",
    line: "[!] [watch] could not arm any thread — platform may not support hw watchpoints",
  });
  expect(thread.sets).toEqual([]);
  expect(thread.unsets).toEqual([]);
});

test("supported watch handles keep independent slots, verification, and cleanup", () => {
  const thread = new FakeThread(7);
  globals.Process = {
    enumerateThreads: () => [thread],
    setExceptionHandler: () => {},
  };
  globals.send = () => {};
  const address = { toString: () => "0x1000" };

  const first = watch(address as never);
  const second = watch(address as never);
  expect(first.fired()).toBe(0);
  expect(second.fired()).toBe(0);
  first.stop();
  const third = watch(address as never);
  second.stop();
  third.stop();

  expect(thread.sets).toEqual([0, 1, 0]);
  expect(thread.unsets).toEqual([0, 1, 0]);
});
