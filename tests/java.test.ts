import { afterAll, expect, mock, test } from "bun:test";

let deferred: (() => void) | null = null;
const runtime = {
  available: true,
  perform(fn: () => void): void { deferred = fn; },
};

mock.module("frida-java-bridge", () => ({ default: runtime }));
const globals = globalThis as Record<string, unknown>;
const originalProcess = globals.Process;
globals.Process = { platform: "linux" };

const { perform } = await import("../agent/lib/java.js");

afterAll(() => {
  if (originalProcess === undefined) delete globals.Process;
  else globals.Process = originalProcess;
});

test("perform resolves after a deferred Java callback", async () => {
  let settled = false;
  const result = perform(() => 42);
  void result.then(() => { settled = true; });
  await Promise.resolve();

  expect(settled).toBe(false);
  expect(deferred).toBeFunction();
  deferred!();
  expect(await result).toBe(42);
});
