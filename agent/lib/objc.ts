// ObjC bridge gate — Darwin-only ObjC runtime access, lazy and side-effect
// free at import. The bridge module is require()d on first api() call, so
// importing this file (or the lib barrel) never initializes the ObjC runtime
// in processes that do not need it.

import { ok } from "./log.js";

type ObjCRuntime = typeof import("frida-objc-bridge").default;

let cached: ObjCRuntime | null = null;

/** True on Darwin with a working ObjC bridge/runtime (expected on Apple platforms; false when bridge init fails). */
export function available(): boolean {
  if (Process.platform !== "darwin") return false;
  try {
    return api().available;
  } catch {
    return false;
  }
}

/**
 * The ObjC bridge runtime, loading it on first call. Throws when the bridge
 * cannot initialize in this process (non-Darwin, or a stripped environment).
 */
export function api(): ObjCRuntime {
  if (Process.platform !== "darwin") {
    throw new Error(`[objc] not available on ${Process.platform} — Darwin only`);
  }
  if (!cached) {
    // Lazy require keeps module-eval side effects out of the lib barrel.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = (require("frida-objc-bridge") as { default: ObjCRuntime }).default;
    ok("objc bridge loaded");
  }
  return cached;
}

/** Convenience: the ObjC class registry (throws via api() when unavailable). */
export function classes(): ObjCRuntime["classes"] {
  return api().classes;
}

/** Demo helper: report gate state plus a cheap runtime fact. */
export function status(): { platform: string; available: boolean; classCount?: number } {
  const av = available();
  const s: { platform: string; available: boolean; classCount?: number } = {
    platform: Process.platform,
    available: av,
  };
  if (av) {
    try {
      s.classCount = Object.keys(api().classes).length;
    } catch {
      // classes enumeration can fail in hardened processes — gate stays true
    }
  }
  return s;
}
