// Loader-aware native module hooking — reusable across every target.
//
// Never assume the target .so/.dll is already loaded: attach time races the
// dynamic loader, and packers/protectors load their real module late. The
// correct primitive is a dlopen hook that installs instrumentation when the
// module actually maps, deduplicated by module base (a module can dlclose and
// remap elsewhere — path alone is not an identity).
//
// Deliberately NOT provided: blind .init/.init_array/JNI_OnLoad hooking.
// Constructor chains are fragile (one bad hook crashes the process before the
// logic you want runs, and early hooks shift timing and can hide the very
// behavior under study). If constructor-time anti-debug is suspected, trace
// the linker-side dispatcher first — never patch init entries until the exact
// offending routine is identified. See docs/analysis-playbooks.md.

import { ok, warn } from "./log.js";

type ModuleCallback = (module: Module) => void;

const DLOPEN_CANDIDATES = [
  // Android's extended loader is the primary entry on ART; plain dlopen is
  // the POSIX fallback on Linux/macOS. Checked in this order.
  "android_dlopen_ext",
  "dlopen",
];

function findDlopen(): NativePointer | null {
  for (const name of DLOPEN_CANDIDATES) {
    try {
      const address = Module.findGlobalExportByName(name);
      if (address) return address;
    } catch {
      // Some processes have no stable global export resolver yet (very early
      // attach, hardened linker). Fall through to the next candidate.
    }
  }
  return null;
}

/**
 * Invoke `callback` every time a module whose path contains `moduleName`
 * finishes loading, deduplicated by module base address.
 *
 * The hook fires in dlopen's onLeave: at that point the module is mapped and
 * its constructors have run, so exports are resolvable and hooking is safe.
 * Returns false when no loader export could be resolved (caller should fall
 * back to an immediate findModuleByName check or polling).
 */
export function hookModuleLoad(moduleName: string, callback: ModuleCallback): boolean {
  const dlopen = findDlopen();
  if (!dlopen) {
    warn(`hookModuleLoad: no dlopen/android_dlopen_ext export — cannot watch for ${moduleName}`);
    return false;
  }
  const hooked = new Set<string>();
  Interceptor.attach(dlopen, {
    onEnter(args) {
      const path = args[0];
      (this as { shouldHook?: boolean }).shouldHook =
        !path.isNull() && (path.readCString() ?? "").includes(moduleName);
    },
    onLeave(retval) {
      if (!(this as { shouldHook?: boolean }).shouldHook || retval.isNull()) return;
      const mod = Process.findModuleByName(moduleName);
      if (!mod) return;
      const key = mod.base.toString();
      if (hooked.has(key)) return;
      hooked.add(key);
      try {
        callback(mod);
      } catch (e) {
        warn(`hookModuleLoad callback for ${moduleName} failed: ${(e as Error).message}`);
      }
    },
  });
  return true;
}

/**
 * Hook `moduleName` whether it is already mapped or arrives later. This is
 * the default way to instrument a native library: immediate check first,
 * loader hook as the continuation.
 */
export function hookNowOrOnLoad(moduleName: string, callback: ModuleCallback): void {
  const mod = Process.findModuleByName(moduleName);
  if (mod) {
    callback(mod);
    return;
  }
  if (hookModuleLoad(moduleName, callback)) return;
  // Last resort only: some hardened linkers hide both dlopen exports. Poll
  // at a low rate; the timer is cleared on first hit so it cannot leak.
  warn(`hookNowOrOnLoad: falling back to polling for ${moduleName}`);
  const timer = setInterval(() => {
    const loaded = Process.findModuleByName(moduleName);
    if (!loaded) return;
    clearInterval(timer);
    callback(loaded);
  }, 100);
}
