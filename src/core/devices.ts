// Device selection and discovery — one boundary shared by CLI, TUI, process
// discovery, attach/spawn, and machine sessions. Never let a frontend resolve
// a Frida device independently or a PID from one device may be used on another.

import frida from "frida";

export const DEFAULT_DEVICE_TIMEOUT_MS = 5_000;
export const MAX_DEVICE_TIMEOUT_MS = 300_000;

export interface RemoteConnectionOptions {
  certificate?: string;
  origin?: string;
  token?: string;
  keepaliveInterval?: number;
}

export type DeviceSelector =
  | { kind: "local" }
  | { kind: "usb"; timeoutMs?: number }
  | { kind: "remote" }
  | { kind: "id"; id: string; timeoutMs?: number }
  | { kind: "endpoint"; address: string; options?: RemoteConnectionOptions };

export interface DeviceInfo {
  id: string;
  name: string;
  type: "local" | "usb" | "remote";
  platform: string | null;
  arch: string | null;
  selector: DeviceSelector;
}

export interface DeviceChoice {
  selector: DeviceSelector;
  info: DeviceInfo;
}

type FridaApi = Pick<typeof frida,
  "getLocalDevice" | "getUsbDevice" | "getRemoteDevice" | "getDevice" |
  "getDeviceManager" | "enumerateDevices"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unsupported device field "${key}"`);
  }
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_DEVICE_TIMEOUT_MS) {
    throw new Error(`device timeout must be an integer from 0 to ${MAX_DEVICE_TIMEOUT_MS}`);
  }
  return value;
}

function remoteOptions(value: unknown): RemoteConnectionOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("remote options must be an object");
  exactKeys(value, ["certificate", "origin", "token", "keepaliveInterval"]);
  const result: RemoteConnectionOptions = {};
  for (const field of ["certificate", "origin", "token"] as const) {
    if (value[field] !== undefined) result[field] = nonempty(value[field], `remote ${field}`);
  }
  if (value.keepaliveInterval !== undefined) {
    if (typeof value.keepaliveInterval !== "number" || !Number.isFinite(value.keepaliveInterval) || value.keepaliveInterval < 0) {
      throw new Error("remote keepaliveInterval must be a non-negative number");
    }
    result.keepaliveInterval = value.keepaliveInterval;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Strictly validate a programmatic/manifest selector. */
export function normalizeDeviceSelector(value: unknown): DeviceSelector {
  if (value === undefined || value === null) return { kind: "local" };
  if (typeof value === "string") return parseDeviceSelector(value);
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("device must be a selector object or selector string");
  }
  switch (value.kind) {
    case "local":
      exactKeys(value, ["kind"]);
      return { kind: "local" };
    case "usb": {
      exactKeys(value, ["kind", "timeoutMs"]);
      const timeoutMs = timeout(value.timeoutMs);
      return { kind: "usb", ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    }
    case "remote":
      exactKeys(value, ["kind"]);
      return { kind: "remote" };
    case "id": {
      exactKeys(value, ["kind", "id", "timeoutMs"]);
      const id = nonempty(value.id, "device id");
      const timeoutMs = timeout(value.timeoutMs);
      return { kind: "id", id, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    }
    case "endpoint": {
      exactKeys(value, ["kind", "address", "options"]);
      const address = nonempty(value.address, "remote address");
      const options = remoteOptions(value.options);
      return { kind: "endpoint", address, ...(options ? { options } : {}) };
    }
    default:
      throw new Error(`unsupported device kind "${value.kind}"`);
  }
}

/** Parse the compact CLI/manifest form: local, usb, remote, id:ID, host:ADDR. */
export function parseDeviceSelector(value: string, timeoutMs?: number): DeviceSelector {
  const input = nonempty(value, "device");
  const wait = timeout(timeoutMs);
  if (input === "local") return { kind: "local" };
  if (input === "usb") return { kind: "usb", ...(wait === undefined ? {} : { timeoutMs: wait }) };
  if (input === "remote") return { kind: "remote" };
  if (input.startsWith("id:")) {
    return { kind: "id", id: nonempty(input.slice(3), "device id"), ...(wait === undefined ? {} : { timeoutMs: wait }) };
  }
  if (input.startsWith("host:")) {
    return { kind: "endpoint", address: nonempty(input.slice(5), "remote address") };
  }
  // Exact ids are the most common output of `flab devices`; accepting them
  // directly keeps copy/paste ergonomic while reserved words stay explicit.
  return { kind: "id", id: input, ...(wait === undefined ? {} : { timeoutMs: wait }) };
}

export function deviceSelectorFromFlags(
  device: string | boolean | undefined,
  host: string | boolean | undefined,
  timeoutValue: string | boolean | undefined,
): DeviceSelector | undefined {
  if (device !== undefined && typeof device !== "string") throw new Error("--device requires a value");
  if (host !== undefined && typeof host !== "string") throw new Error("--host requires a value");
  if (device !== undefined && host !== undefined) throw new Error("--device and --host are mutually exclusive");
  let timeoutMs: number | undefined;
  if (timeoutValue !== undefined) {
    if (typeof timeoutValue !== "string" || !/^\d+$/.test(timeoutValue)) {
      throw new Error(`--device-timeout must be an integer from 0 to ${MAX_DEVICE_TIMEOUT_MS}`);
    }
    timeoutMs = timeout(Number(timeoutValue));
  }
  if (host !== undefined) {
    if (timeoutMs !== undefined) throw new Error("--device-timeout is not supported with --host");
    return { kind: "endpoint", address: nonempty(host, "remote address") };
  }
  if (device !== undefined) return parseDeviceSelector(device, timeoutMs);
  if (timeoutMs !== undefined) throw new Error("--device-timeout requires --device");
  return undefined;
}

export function deviceSelectorKey(selector: DeviceSelector): string {
  switch (selector.kind) {
    case "local": return "local";
    case "usb": return `usb:${selector.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS}`;
    case "remote": return "remote";
    case "id": return `id:${selector.id}:${selector.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS}`;
    case "endpoint": return `host:${selector.address}`;
  }
}

export function deviceSelectorLabel(selector: DeviceSelector): string {
  switch (selector.kind) {
    case "local": return "local";
    case "usb": return "usb (first available)";
    case "remote": return "remote (default)";
    case "id": return selector.id;
    case "endpoint": return selector.address;
  }
}

/** Whether a configured selector refers to the currently resolved device. */
export function deviceSelectorMatchesInfo(selectorInput: DeviceSelector | undefined, info: DeviceInfo): boolean {
  const selector = normalizeDeviceSelector(selectorInput);
  switch (selector.kind) {
    case "local": return info.type === "local";
    case "usb": return info.type === "usb";
    case "remote": return info.type === "remote";
    case "id": return info.id === selector.id;
    case "endpoint":
      return info.selector.kind === "endpoint" && info.selector.address === selector.address;
  }
}

const endpointCache = new Map<string, Promise<frida.Device>>();

/** Resolve one selector to exactly one Frida Device. */
export async function resolveDevice(
  selectorInput: DeviceSelector = { kind: "local" },
  api: FridaApi = frida,
): Promise<frida.Device> {
  const selector = normalizeDeviceSelector(selectorInput);
  try {
    switch (selector.kind) {
      case "local": return await api.getLocalDevice();
      case "usb": return await api.getUsbDevice({ timeout: selector.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS });
      case "remote": return await api.getRemoteDevice();
      case "id": return await api.getDevice(selector.id, { timeout: selector.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS });
      case "endpoint": {
        const key = JSON.stringify([selector.address, selector.options ?? {}]);
        let pending = endpointCache.get(key);
        if (!pending) {
          pending = api.getDeviceManager().addRemoteDevice(selector.address, selector.options);
          endpointCache.set(key, pending);
          void pending.then((device) => {
            const lost = (device as frida.Device & { lost?: frida.Device["lost"] }).lost;
            lost?.connect(() => {
              if (endpointCache.get(key) === pending) endpointCache.delete(key);
            });
          }).catch(() => { /* rejection cleanup below owns the cache entry */ });
          void pending.catch(() => { if (endpointCache.get(key) === pending) endpointCache.delete(key); });
        }
        return await pending;
      }
    }
  } catch (error) {
    throw new Error(`device ${deviceSelectorLabel(selector)} unavailable: ${(error as Error).message}`, { cause: error });
  }
}

function selectorForDevice(device: frida.Device): DeviceSelector {
  if (device.type === frida.DeviceType.Local) return { kind: "local" };
  return { kind: "id", id: device.id };
}

function publicSelector(selector: DeviceSelector): DeviceSelector {
  // Connection credentials are runtime-only and must never enter TUI state,
  // JSON process output, logs, or the machine-session ready envelope.
  return selector.kind === "endpoint"
    ? { kind: "endpoint", address: selector.address }
    : selector;
}

export async function describeDevice(device: frida.Device, selector?: DeviceSelector): Promise<DeviceInfo> {
  const params = await device.querySystemParameters().catch(() => null) as {
    platform?: unknown;
    arch?: unknown;
  } | null;
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    platform: typeof params?.platform === "string" ? params.platform : null,
    arch: typeof params?.arch === "string" ? params.arch : null,
    selector: selector ? publicSelector(normalizeDeviceSelector(selector)) : selectorForDevice(device),
  };
}

/** Enumerate currently visible local/USB/remote devices without waiting. */
export async function discoverDevices(api: FridaApi = frida): Promise<DeviceChoice[]> {
  const devices = await api.enumerateDevices();
  const choices = await Promise.all(devices.map(async (device) => {
    const selector = selectorForDevice(device);
    return { selector, info: await describeDevice(device, selector) };
  }));
  return choices.sort((a, b) => {
    const rank = (type: DeviceInfo["type"]): number => type === "local" ? 0 : type === "usb" ? 1 : 2;
    return rank(a.info.type) - rank(b.info.type) || a.info.name.localeCompare(b.info.name) || a.info.id.localeCompare(b.info.id);
  });
}
