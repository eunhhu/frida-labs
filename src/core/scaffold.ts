// Backward-compatible `flab new` adapter. Project mutation belongs to the
// typed core service so CLI and TUI share transaction and safety semantics.

import { currentProjectService } from "./projects.js";
import type { DeviceSelector } from "./devices.js";

export interface ScaffoldResult {
  name: string;
  entry: string;
  process: string;
  device?: DeviceSelector;
}

export async function scaffold(name: string, processName?: string, device?: DeviceSelector): Promise<ScaffoldResult> {
  const process = processName ?? `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}.exe`;
  const result = await currentProjectService().create({ name, process, mode: "attach", ...(device ? { device } : {}) });
  return {
    name: result.name,
    entry: result.entry,
    process: result.config.process,
    ...(result.config.device ? { device: result.config.device } : {}),
  };
}
