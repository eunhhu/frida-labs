import { loadManifest, type Manifest } from "./manifest.js";
import {
  describeDevice,
  deviceSelectorMatchesInfo,
  normalizeDeviceSelector,
  resolveDevice,
  type DeviceInfo,
  type DeviceSelector,
} from "./devices.js";

export interface VisibleProcess {
  pid: number;
  name: string;
}

export interface ProcessCandidate extends VisibleProcess {
  matchedTargets: string[];
  suggestedAction: "attach-target" | "probe";
}

export interface DiscoverProcessOptions {
  query?: string;
  limit?: number;
  manifest?: Manifest;
  enumerate?: () => Promise<VisibleProcess[]>;
  device?: DeviceSelector;
  /** Test/embedding override when enumerate does not come from a Frida device. */
  platform?: string;
}

export interface ProcessDiscovery {
  device: DeviceInfo;
  processes: ProcessCandidate[];
}

function leaf(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

export function canonicalProcessName(value: string): string {
  return leaf(value).trim().toLowerCase().replace(/\.(exe|bin\.[a-z0-9_-]+)$/i, "");
}

export function processNameMatches(configured: string, running: string): boolean {
  const exact = leaf(configured).trim().toLowerCase() === leaf(running).trim().toLowerCase();
  return exact || canonicalProcessName(configured) === canonicalProcessName(running);
}

export function annotateProcesses(
  processes: readonly VisibleProcess[],
  manifest: Manifest,
  platform: string = process.platform,
  device?: DeviceInfo,
): ProcessCandidate[] {
  const targets = Object.entries(manifest.targets)
    .filter(([, config]) => !device || deviceSelectorMatchesInfo(config.device, device))
    .map(([name, config]) => ({
      name,
      process: config.processByPlatform?.[platform] ?? config.process,
    }));
  return processes.map((candidate) => {
    const matchedTargets = targets
      .filter((target) => processNameMatches(target.process, candidate.name))
      .map((target) => target.name)
      .sort();
    return {
      pid: candidate.pid,
      name: candidate.name,
      matchedTargets,
      suggestedAction: matchedTargets.length ? "attach-target" : "probe",
    };
  });
}

/** Enumerate one selected device and return identity + ranked processes. */
export async function discoverProcessSnapshot(options: DiscoverProcessOptions = {}): Promise<ProcessDiscovery> {
  const selector = normalizeDeviceSelector(options.device);
  let info: DeviceInfo;
  let visible: VisibleProcess[];
  if (options.enumerate) {
    visible = await options.enumerate();
    info = {
      id: "custom",
      name: "Custom device",
      type: "local",
      platform: options.platform ?? process.platform,
      arch: null,
      selector,
    };
  } else {
    const device = await resolveDevice(selector);
    info = await describeDevice(device, selector);
    visible = (await device.enumerateProcesses()).map((item) => ({ pid: item.pid, name: item.name }));
  }
  const query = options.query?.trim().toLowerCase() ?? "";
  const rows = annotateProcesses(visible, options.manifest ?? loadManifest(), info.platform ?? process.platform, info)
    .filter((item) => !query || item.name.toLowerCase().includes(query) || item.matchedTargets.some((target) => target.includes(query)))
    .sort((a, b) => {
      const matched = Number(b.matchedTargets.length > 0) - Number(a.matchedTargets.length > 0);
      return matched || a.name.localeCompare(b.name) || a.pid - b.pid;
    });
  const limit = options.limit === undefined ? rows.length : Math.max(0, Math.floor(options.limit));
  return { device: info, processes: rows.slice(0, limit) };
}

/** Compatibility list-only form. */
export async function discoverProcesses(options: DiscoverProcessOptions = {}): Promise<ProcessCandidate[]> {
  return (await discoverProcessSnapshot(options)).processes;
}
