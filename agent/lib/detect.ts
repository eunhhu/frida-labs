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

type Detector = () => EngineInfo | null;

const hasExport = (m: Module, name: string): boolean =>
  m.enumerateExports().some((e) => e.name === name);

function detectIl2cpp(): EngineInfo | null {
  const m = Process.enumerateModules().find((x) => /^(GameAssembly|libil2cpp)\.(dll|so|dylib)$/i.test(x.name));
  return m && hasExport(m, "il2cpp_init")
    ? { id: "il2cpp", label: "Unity (IL2CPP)", module: m }
    : null;
}

function detectUnityMono(): EngineInfo | null {
  const m = Process.enumerateModules().find((x) => MONO_MODULE_RE.test(x.name) && exportsRoot(x));
  return m ? { id: "unity-mono", label: "Unity (Mono)", module: m } : null;
}

function detectFnaMono(): EngineInfo | null {
  // FNA "monokickstart": Mono statically linked into the main binary, which
  // exports mono_get_root_domain even though no mono shared library exists.
  const main = Process.enumerateModules()[0];
  const hasMono = exportsRoot(main);
  const hasSdl = !!Module.findGlobalExportByName("SDL_PollEvent");
  return hasMono && hasSdl ? { id: "fna-mono", label: "FNA (embedded Mono)", module: main } : null;
}

function detectUnreal(): EngineInfo | null {
  const m = Process.enumerateModules().find((x) => /-(Win(64|32)|Mac|Linux)-Shipping\./i.test(x.name));
  return m ? { id: "unreal", label: "Unreal Engine", module: m } : null;
}

function detectCocos(): EngineInfo | null {
  // Cocos2d-x games ship libcocos2dcpp (native) or link cocos2d-js.
  const m = Process.enumerateModules().find((x) => /cocos2d(cpp|js|x)?/i.test(x.name));
  if (m) return { id: "cocos2dx", label: "Cocos2d-x", module: m };
  // Windows/desktop builds statically link cocos into the main exe; look for
  // its distinctive exported scheduler singleton instead.
  const main = Process.enumerateModules()[0];
  if (main.enumerateExports().some((e) => /cocos2d/i.test(e.name))) {
    return { id: "cocos2dx", label: "Cocos2d-x (static)", module: main };
  }
  return null;
}

/** Every engine that matched, best guess first. Empty on a bare native process. */
export function detectAll(): EngineInfo[] {
  const found = [detectIl2cpp(), detectUnityMono(), detectFnaMono(), detectUnreal(), detectCocos()]
    .filter((e): e is EngineInfo => e !== null);
  return found;
}

/** Single best guess (first match), or null for a bare native process. */
export function detect(): EngineInfo | null {
  return detectAll()[0] ?? null;
}
