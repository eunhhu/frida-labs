import { expect, test } from "bun:test";
import {
  deviceSelectorFromFlags,
  deviceSelectorMatchesInfo,
  describeDevice,
  normalizeDeviceSelector,
  parseDeviceSelector,
  resolveDevice,
  type DeviceInfo,
} from "../src/core/index.js";

test("device selectors are strict, explicit, and CLI-copyable", () => {
  expect(parseDeviceSelector("local")).toEqual({ kind: "local" });
  expect(parseDeviceSelector("usb", 9_000)).toEqual({ kind: "usb", timeoutMs: 9_000 });
  expect(parseDeviceSelector("remote")).toEqual({ kind: "remote" });
  expect(parseDeviceSelector("id:emulator-5554")).toEqual({ kind: "id", id: "emulator-5554" });
  expect(parseDeviceSelector("emulator-5554")).toEqual({ kind: "id", id: "emulator-5554" });
  expect(parseDeviceSelector("host:10.0.0.8:27042")).toEqual({ kind: "endpoint", address: "10.0.0.8:27042" });
  expect(deviceSelectorFromFlags(undefined, "10.0.0.8:27042", undefined)).toEqual({
    kind: "endpoint",
    address: "10.0.0.8:27042",
  });
  expect(() => deviceSelectorFromFlags("usb", "host", undefined)).toThrow("mutually exclusive");
  expect(() => deviceSelectorFromFlags(undefined, "host", "5000")).toThrow("not supported with --host");
  expect(() => deviceSelectorFromFlags(undefined, undefined, "5000")).toThrow("requires --device");
  expect(() => normalizeDeviceSelector({ kind: "usb", surprise: true })).toThrow("unsupported device field");
  expect(() => normalizeDeviceSelector({ kind: "id", id: "" })).toThrow("non-empty");
});

test("device resolution dispatches local, USB, id, remote, and endpoint exactly", async () => {
  const calls: unknown[][] = [];
  const devices = {
    local: { id: "local" },
    usb: { id: "usb-1" },
    remote: { id: "remote" },
    exact: { id: "phone-1" },
    endpoint: { id: "socket@lab" },
  };
  const api = {
    getLocalDevice: async () => { calls.push(["local"]); return devices.local; },
    getUsbDevice: async (options: unknown) => { calls.push(["usb", options]); return devices.usb; },
    getRemoteDevice: async () => { calls.push(["remote"]); return devices.remote; },
    getDevice: async (id: string, options: unknown) => { calls.push(["id", id, options]); return devices.exact; },
    getDeviceManager: () => ({
      addRemoteDevice: async (address: string, options: unknown) => {
        calls.push(["endpoint", address, options]);
        return devices.endpoint;
      },
    }),
    enumerateDevices: async () => [],
  };

  expect(await resolveDevice({ kind: "local" }, api as never)).toBe(devices.local);
  expect(await resolveDevice({ kind: "usb", timeoutMs: 1234 }, api as never)).toBe(devices.usb);
  expect(await resolveDevice({ kind: "remote" }, api as never)).toBe(devices.remote);
  expect(await resolveDevice({ kind: "id", id: "phone-1", timeoutMs: 4321 }, api as never)).toBe(devices.exact);
  const endpoint = { kind: "endpoint", address: "unit-test-device:27042", options: { token: "secret" } } as const;
  expect(await resolveDevice(endpoint, api as never)).toBe(devices.endpoint);
  expect(await resolveDevice(endpoint, api as never)).toBe(devices.endpoint);

  expect(calls).toEqual([
    ["local"],
    ["usb", { timeout: 1234 }],
    ["remote"],
    ["id", "phone-1", { timeout: 4321 }],
    ["endpoint", "unit-test-device:27042", { token: "secret" }],
  ]);
});

test("manifest selectors match only the resolved device identity", () => {
  const usb: DeviceInfo = {
    id: "phone-1",
    name: "Phone",
    type: "usb",
    platform: "darwin",
    arch: "arm64",
    selector: { kind: "id", id: "phone-1" },
  };
  expect(deviceSelectorMatchesInfo({ kind: "usb" }, usb)).toBe(true);
  expect(deviceSelectorMatchesInfo({ kind: "id", id: "phone-1" }, usb)).toBe(true);
  expect(deviceSelectorMatchesInfo({ kind: "id", id: "phone-2" }, usb)).toBe(false);
  expect(deviceSelectorMatchesInfo(undefined, usb)).toBe(false);
});

test("resolved device identity never exposes remote credentials", async () => {
  const info = await describeDevice({
    id: "socket@lab",
    name: "Lab",
    type: "remote",
    querySystemParameters: async () => ({ platform: "linux", arch: "arm64" }),
  } as never, {
    kind: "endpoint",
    address: "lab:27042",
    options: { token: "do-not-serialize", certificate: "pem" },
  });
  expect(info.selector).toEqual({ kind: "endpoint", address: "lab:27042" });
  expect(JSON.stringify(info)).not.toContain("do-not-serialize");
});
