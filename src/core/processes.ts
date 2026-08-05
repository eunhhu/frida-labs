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
  /** Mobile bundle identifiers Frida maps to this live PID. */
  identifiers?: string[];
}

export interface VisibleApplication {
  pid: number;
  name: string;
  identifier: string;
}

export interface AttachTargetResolution {
  /** PID when discovery could prove the running identity; configured name otherwise. */
  target: number | string;
  /** Human-facing name. Keeps package identifiers visible when they differ. */
  display: string;
  source: "process" | "application" | "configured";
}

export interface AttachDiscoveryDevice {
  enumerateProcesses(): Promise<VisibleProcess[]>;
  enumerateApplications(options?: { identifiers?: string[] }): Promise<VisibleApplication[]>;
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

export function mapApplicationIdentifiers(
  processes: readonly VisibleProcess[],
  applications: readonly VisibleApplication[],
): VisibleProcess[] {
  const byPid = new Map<number, Set<string>>();
  for (const application of applications) {
    if (application.pid <= 0 || !application.identifier.trim()) continue;
    const identifiers = byPid.get(application.pid) ?? new Set<string>();
    identifiers.add(application.identifier);
    byPid.set(application.pid, identifiers);
  }
  return processes.map((candidate) => {
    const identifiers = byPid.get(candidate.pid);
    return identifiers?.size
      ? { ...candidate, identifiers: [...identifiers].sort() }
      : { ...candidate };
  });
}

/**
 * Resolve an attach target without assuming an Android/iOS bundle identifier is
 * also the OS process display name. Mobile Frida devices expose that mapping in
 * enumerateApplications(); attaching by its live PID avoids localized app names.
 *
 * Spawn callers must not use this helper: mobile spawn needs the stable bundle
 * identifier, not a PID or localized display name.
 */
export async function resolveAttachTarget(
  device: AttachDiscoveryDevice,
  configured: string,
): Promise<AttachTargetResolution> {
  const wanted = configured.trim();
  if (!wanted) throw new Error("no process name — pass --proc");

  try {
    const running = await device.enumerateProcesses();
    const hit = running.find((candidate) => processNameMatches(wanted, candidate.name));
    if (hit) return { target: hit.pid, display: hit.name, source: "process" };
  } catch { /* enumeration unsupported — try application discovery */ }

  try {
    const applications = await device.enumerateApplications({ identifiers: [wanted] });
    const exact = applications.find((application) =>
      application.identifier.toLowerCase() === wanted.toLowerCase(),
    );
    const hit = exact ?? applications.find((application) => processNameMatches(wanted, application.name));
    if (hit) {
      const display = hit.name === hit.identifier ? hit.name : `${hit.name} (${hit.identifier})`;
      if (hit.pid <= 0) {
        throw new Error(
          `application ${display} is installed but not running — launch it or use spawn mode`,
        );
      }
      return { target: hit.pid, display, source: "application" };
    }
  } catch (error) {
    // Preserve the actionable installed-but-stopped error. Discovery failures
    // still fall back to Frida's native string attach for older remote stubs.
    if (/ is installed but not running /.test((error as Error).message)) throw error;
  }

  return { target: wanted, display: wanted, source: "configured" };
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
      .filter((target) =>
        processNameMatches(target.process, candidate.name) ||
        (candidate.identifiers ?? []).some((identifier) => processNameMatches(target.process, identifier)),
      )
      .map((target) => target.name)
      .sort();
    return {
      pid: candidate.pid,
      name: candidate.name,
      ...(candidate.identifiers?.length ? { identifiers: [...candidate.identifiers] } : {}),
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
    try {
      const applications = (await device.enumerateApplications()).map((item) => ({
        pid: item.pid,
        name: item.name,
        identifier: item.identifier,
      }));
      visible = mapApplicationIdentifiers(visible, applications);
    } catch { /* desktop/older remote stubs may not expose applications */ }
  }
  const query = options.query?.trim().toLowerCase() ?? "";
  const rows = annotateProcesses(visible, options.manifest ?? loadManifest(), info.platform ?? process.platform, info)
    .filter((item) =>
      !query ||
      item.name.toLowerCase().includes(query) ||
      (item.identifiers ?? []).some((identifier) => identifier.toLowerCase().includes(query)) ||
      item.matchedTargets.some((target) => target.includes(query)),
    )
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
