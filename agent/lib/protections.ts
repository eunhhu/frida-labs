// Protection / anti-analysis detection — a *diagnostic* scanner, reusable
// across targets. It reports which anti-debug, root-detection, SSL-pinning,
// and integrity-check primitives a process contains so the analyst knows what
// they are dealing with before hooking anything.
//
// This module deliberately contains no bypass logic. Detection guides
// authorized analysis on owned offline builds and private labs; neutralizing
// a protection is a per-target decision with per-target evidence, never a
// library default.
//
// Sources of technique coverage: cross-OS anti-debug matrices (ptrace /
// TracerPid / timing on Linux, PEB / NtQueryInformationProcess / heap flags
// on Windows) and the standard Android app-protection surface (root path and
// package probes, TrustManager / OkHttp / Conscrypt pinning, Cipher/KeyStore
// usage). See docs/analysis-playbooks.md.

import { ok } from "./log.js";
import * as java from "./java.js";

export interface ProtectionHit {
  /** Stable id, e.g. "linux.proc-status-tracerpid". */
  id: string;
  /** Grouping: "anti-debug" | "anti-tamper" | "root-detect" | "ssl-pinning" | "crypto" | "webview". */
  category: string;
  /** One-line human description of what was found. */
  detail: string;
}

function hasExport(name: string): boolean {
  try {
    return Module.findGlobalExportByName(name) !== null;
  } catch {
    return false;
  }
}

function moduleLoaded(re: RegExp): Module | null {
  try {
    return Process.enumerateModules().find((m) => re.test(m.name)) ?? null;
  } catch {
    return null;
  }
}

function moduleContains(module: Module, needle: string): boolean {
  try {
    const bytes: number[] = [];
    for (let i = 0; i < needle.length; i++) bytes.push(needle.charCodeAt(i));
    const pattern = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return Memory.scanSync(module.base, module.size, pattern).length > 0;
  } catch {
    return false;
  }
}

// --- native anti-debug imports ---------------------------------------------

interface NativeProbe {
  id: string;
  category: string;
  detail: string;
  symbols: string[];
  /** Only run on these platforms; omit to run everywhere. */
  platforms?: string[];
}

const NATIVE_PROBES: NativeProbe[] = [
  {
    id: "posix.ptrace",
    category: "anti-debug",
    detail: "ptrace import — classic TRACEME self-attach anti-debug",
    symbols: ["ptrace"],
    platforms: ["linux", "android", "darwin"],
  },
  {
    id: "linux.proc-status",
    category: "anti-debug",
    detail: '"/proc/self/status" string — TracerPid debugger check',
    symbols: [],
    platforms: ["linux", "android"],
  },
  {
    id: "posix.prctl",
    category: "anti-debug",
    detail: "prctl import — PR_SET_DUMPABLE / name manipulation",
    symbols: ["prctl"],
    platforms: ["linux", "android"],
  },
  {
    id: "windows.isdebuggerpresent",
    category: "anti-debug",
    detail: "IsDebuggerPresent / CheckRemoteDebuggerPresent import",
    symbols: ["IsDebuggerPresent", "CheckRemoteDebuggerPresent"],
    platforms: ["windows"],
  },
  {
    id: "windows.ntqip",
    category: "anti-debug",
    detail: "NtQueryInformationProcess import — DebugPort/DebugObjectHandle/DebugFlags query",
    symbols: ["NtQueryInformationProcess"],
    platforms: ["windows"],
  },
  {
    id: "windows.hide-thread",
    category: "anti-debug",
    detail: "NtSetInformationThread import — ThreadHideFromDebugger",
    symbols: ["NtSetInformationThread"],
    platforms: ["windows"],
  },
  {
    id: "timing.qpc",
    category: "anti-debug",
    detail: "QueryPerformanceCounter import — timing-based debugger detection",
    symbols: ["QueryPerformanceCounter"],
    platforms: ["windows"],
  },
  {
    id: "timing.gettime",
    category: "anti-debug",
    detail: "clock_gettime import — timing-based debugger detection",
    symbols: ["clock_gettime"],
    platforms: ["linux", "android", "darwin"],
  },
];

function scanNative(platform: string): ProtectionHit[] {
  const hits: ProtectionHit[] = [];
  const main = Process.enumerateModules()[0];
  for (const probe of NATIVE_PROBES) {
    if (probe.platforms && !probe.platforms.includes(platform)) continue;
    const imported = probe.symbols.some((s) => hasExport(s));
    // "/proc/self/status" is a string probe, not a symbol probe.
    const embedded =
      probe.id === "linux.proc-status" && main ? moduleContains(main, "/proc/self/status") : false;
    if (imported || embedded) hits.push({ id: probe.id, category: probe.category, detail: probe.detail });
  }
  return hits;
}

// --- Java-layer probes (Android) --------------------------------------------

interface JavaProbe {
  id: string;
  category: string;
  detail: string;
  classes: string[];
}

const JAVA_PROBES: JavaProbe[] = [
  // Root / tamper detection surfaces the app may call.
  { id: "java.rootbeer", category: "root-detect", detail: "RootBeer library present", classes: ["com.scottyab.rootbeer.RootBeer"] },
  { id: "java.safetynet", category: "anti-tamper", detail: "Play Integrity / SafetyNet API present", classes: ["com.google.android.gms.safetynet.SafetyNet", "com.google.android.play.core.integrity.IntegrityManagerFactory"] },
  // SSL pinning implementations — these are the classes a TLS-interception
  // analysis would need to account for.
  { id: "java.okhttp-pinner", category: "ssl-pinning", detail: "OkHttp CertificatePinner present", classes: ["okhttp3.CertificatePinner"] },
  { id: "java.conscrypt-pin", category: "ssl-pinning", detail: "Conscrypt trust manager present", classes: ["com.android.org.conscrypt.TrustManagerImpl"] },
  { id: "java.trustmanager", category: "ssl-pinning", detail: "custom X509TrustManager usage possible", classes: ["javax.net.ssl.X509TrustManager"] },
  // Crypto surfaces worth instrumenting for key/plaintext visibility.
  { id: "java.cipher", category: "crypto", detail: "javax.crypto.Cipher in use — runtime key/plaintext capture point", classes: ["javax.crypto.Cipher"] },
  { id: "java.keystore", category: "crypto", detail: "AndroidKeyStore in use — hardware-backed key storage", classes: ["java.security.KeyStore"] },
  // WebView bridges are a common injection surface.
  { id: "java.webview", category: "webview", detail: "android.webkit.WebView present — check addJavascriptInterface bridges", classes: ["android.webkit.WebView"] },
];

const ROOT_PATH_MARKERS = ["/system/xbin/su", "/sbin/su", "/su/bin/su", "/magisk"];

function scanJava(): ProtectionHit[] {
  if (!java.available()) return [];
  const hits: ProtectionHit[] = [];
  try {
    java.api().perform(() => {
      let loaded: Set<string>;
      try {
        loaded = new Set(java.api().enumerateLoadedClassesSync());
      } catch {
        // Class enumeration can fail on hardened ART; fall back to targeted
        // availability checks, which go through the class loader.
        loaded = new Set(
          JAVA_PROBES.flatMap((p) => p.classes).filter((name) => {
            try { java.api().use(name); return true; } catch { return false; }
          }),
        );
      }
      for (const probe of JAVA_PROBES) {
        if (probe.classes.some((c) => loaded.has(c))) {
          hits.push({ id: probe.id, category: probe.category, detail: probe.detail });
        }
      }
      const main = Process.enumerateModules()[0];
      if (main && ROOT_PATH_MARKERS.some((marker) => moduleContains(main, marker))) {
        hits.push({ id: "java.root-paths", category: "root-detect", detail: "su-binary path strings embedded — root file probing likely" });
      }
    });
  } catch {
    // Report whatever the native pass found; a broken VM gate is not fatal.
  }
  return hits;
}

/**
 * Scan the attached process for known protection primitives. Read-only and
 * safe to run on any session; every probe degrades to "not found" when the
 * platform or runtime does not expose the surface.
 */
export function scanProtections(platform: string = Process.platform): ProtectionHit[] {
  const hits = [...scanNative(platform), ...scanJava()];
  ok(`protection scan: ${hits.length} hit(s)`);
  for (const hit of hits) ok(`[${hit.category}] ${hit.id}: ${hit.detail}`);
  return hits;
}
