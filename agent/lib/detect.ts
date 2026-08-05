// Engine / managed-runtime detection — reusable across every target.
//
// Each detector is a cheap module-name / export-symbol check, safe to run on
// any process. `detectAll()` runs them all and returns every engine that
// matched (a Unity-IL2CPP game will report both "unity" and "il2cpp").
// Mono detection consumes the single-source matcher in mono/runtime.ts.

import { MONO_MODULE_RE, exportsRoot } from "./mono/runtime.js";
export interface EngineInfo {
  /** Stable id: "il2cpp" | "unity-mono" | "fna-mono" | "unreal" | "cocos2dx" */
  id: string;
  /** Human-readable label for logs. */
  label: string;
  /** Module the detector matched on (main module for unreal/cocos fallbacks). */
  module: Module;
}

type Detector = (modules: Module[]) => EngineInfo | null;

const enumerateModules = (): Module[] => {
  try {
    return Process.enumerateModules();
  } catch {
    return [];
  }
};

const hasExport = (m: Module, name: string): boolean => {
  try {
    return m.enumerateExports().some((e) => e.name === name);
  } catch {
    // A module can disappear between enumeration and inspection while the
    // loader is changing. Detection is advisory, so a stale module is simply
    // not a match.
    return false;
  }
};

function detectIl2cpp(modules: Module[]): EngineInfo | null {
  const m = modules.find((x) => /^(GameAssembly|libil2cpp)\.(dll|so|dylib)$/i.test(x.name));
  return m && hasExport(m, "il2cpp_init")
    ? { id: "il2cpp", label: "Unity (IL2CPP)", module: m }
    : null;
}

function detectUnityMono(modules: Module[]): EngineInfo | null {
  const m = modules.find((x) => MONO_MODULE_RE.test(x.name) && exportsRoot(x));
  return m ? { id: "unity-mono", label: "Unity (Mono)", module: m } : null;
}

function detectFnaMono(modules: Module[]): EngineInfo | null {
  // FNA "monokickstart": Mono statically linked into the main binary, which
  // exports mono_get_root_domain even though no mono shared library exists.
  const main = modules[0];
  if (!main) return null;
  const hasMono = exportsRoot(main);
  let hasSdl = false;
  try {
    hasSdl = !!Module.findGlobalExportByName("SDL_PollEvent");
  } catch {
    // Some minimal processes do not have a stable global export resolver yet.
  }
  return hasMono && hasSdl ? { id: "fna-mono", label: "FNA (embedded Mono)", module: main } : null;
}

function detectUnreal(modules: Module[]): EngineInfo | null {
  const m = modules.find((x) => /-(Win(64|32)|Mac|Linux)-Shipping\./i.test(x.name));
  return m ? { id: "unreal", label: "Unreal Engine", module: m } : null;
}

function detectCocos(modules: Module[]): EngineInfo | null {
  // Cocos2d-x games ship libcocos2dcpp (native) or link cocos2d-js.
  const m = modules.find((x) => /cocos2d(cpp|js|x)?/i.test(x.name));
  if (m) return { id: "cocos2dx", label: "Cocos2d-x", module: m };
  // Windows/desktop builds statically link cocos into the main exe; look for
  // its distinctive exported scheduler singleton instead.
  const main = modules[0];
  if (main && hasExportMatching(main, /cocos2d/i)) {
    return { id: "cocos2dx", label: "Cocos2d-x (static)", module: main };
  }
  return null;
}

const hasExportMatching = (module: Module, pattern: RegExp): boolean => {
  try {
    return module.enumerateExports().some((entry) => pattern.test(entry.name));
  } catch {
    return false;
  }
};

/** Every engine that matched, best guess first. Empty on a bare native process. */
export function detectAll(): EngineInfo[] {
  const modules = enumerateModules();
  const detectors: Detector[] = [detectIl2cpp, detectUnityMono, detectFnaMono, detectUnreal, detectCocos];
  const found: EngineInfo[] = [];
  for (const detector of detectors) {
    try {
      const match = detector(modules);
      if (match) found.push(match);
    } catch {
      // Detection must never prevent attaching to an otherwise valid process.
    }
  }
  return found;
}

/** Single best guess (first match), or null for a bare native process. */
export function detect(): EngineInfo | null {
  return detectAll()[0] ?? null;
}
