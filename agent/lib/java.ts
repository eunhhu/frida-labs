// Java bridge gate — Android-only ART access, lazy and side-effect free at
// import. Not exposed when no Java runtime is detected: available() is false
// off-Android and api() throws, so targets never touch the bridge otherwise.

import { ok } from "./log.js";

type JavaRuntime = typeof import("frida-java-bridge").default;

let cached: JavaRuntime | null = null;

/** True when a Java (ART/Dalvik) runtime is loaded — Android processes only. */
export function available(): boolean {
  if (Process.platform !== "linux") return false; // Android is linux platform in frida
  try {
    return api().available;
  } catch {
    return false;
  }
}

/**
 * The Java bridge runtime, loading it on first call. Throws off-Android or
 * when the process has no VM.
 */
export function api(): JavaRuntime {
  if (Process.platform !== "linux") {
    throw new Error(`[java] not available on ${Process.platform} — Android only`);
  }
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = (require("frida-java-bridge") as { default: JavaRuntime }).default;
    ok("java bridge loaded");
  }
  if (!cached.available) {
    throw new Error("[java] bridge loaded but no Java VM in this process");
  }
  return cached;
}

/** Run `fn` on the VM thread when available; resolves null when undetected.
 *  Java.perform() may defer until the app class loader exists, so the result
 *  must cross an async boundary instead of being read immediately. */
export function perform<T>(fn: () => T | Promise<T>): Promise<T | null> {
  if (!available()) return Promise.resolve(null);
  return new Promise<T>((resolve, reject) => {
    try {
      api().perform(() => {
        try {
          Promise.resolve(fn()).then(resolve, reject);
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Demo helper: gate state report (expected available:false off-Android). */
export function status(): { platform: string; available: boolean; androidVersion?: string } {
  const av = available();
  const s: { platform: string; available: boolean; androidVersion?: string } = {
    platform: Process.platform,
    available: av,
  };
  if (av) {
    try {
      s.androidVersion = api().androidVersion;
    } catch { /* hardened VM */ }
  }
  return s;
}
