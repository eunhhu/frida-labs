/// <reference path="../../globals.d.ts" />
// Mono runtime module resolution — SINGLE SOURCE for "which module carries the
// Mono embedding API". Resolution follows a 4-tier ladder, cheapest and most
// deterministic first:
//
//   1. baked    — per-target module name pinned by real enumeration evidence
//                 (BAKED_MODULES; terraria pins its monokickstart main binary).
//   2. candidate— conventional standalone Mono runtime module names
//                 (mono.dll / mono-2.0-bdwgc / libmonobdwgc-2.0.dylib …).
//   3. scan     — every loaded module probed for the mono_get_root_domain
//                 export (catches statically-linked runtimes like FNA's
//                 monokickstart, where the symbols live in the main module).
//   4. error    — diagnostic failure listing what was probed.
//
// A module only "wins" a tier when it actually exports mono_get_root_domain,
// so a name match never binds to a stripped or unrelated module.

// Baked per-target module names, keyed by target name. Entries are added ONLY
// from real enumeration evidence on the live game (flab run … --eval), never
// from guesses. terraria: FNA monokickstart statically links Mono into the
// main binary (verified live). adofai: pending — baking deferred until the
// game process is attachable on this host (AMFI task_for_pid policy), so
// adofai currently resolves via tiers 2–3.
export const BAKED_MODULES: Record<string, readonly string[]> = {
  terraria: ["Terraria.bin.osx"],
};

// Conventional standalone Mono runtime module names (tier 2).
export const MONO_MODULE_RE =
  /^(?:mono\.dll|mono-2\.0-(?:bdwgc|sgen)(?:\.0)?\.(?:dll|dylib|so)|libmono-2\.0-(?:bdwgc|sgen)(?:\.0)?\.(?:dll|dylib|so)|libmonobdwgc-2\.0(?:\.0)?\.(?:dll|dylib|so)|mono(?:-2\.0)?\.so)$/i;

const ROOT_EXPORT = "mono_get_root_domain";

function exportsRoot(mod: Module): boolean {
  try {
    return mod.findExportByName(ROOT_EXPORT) !== null;
  } catch {
    return false;
  }
}

export interface MonoResolution {
  module: Module;
  tier: "baked" | "candidate" | "scan";
}

/**
 * Resolve the module exporting the Mono embedding API.
 * @param preferred baked/explicit module name(s) tried at tier 1
 * @throws Error with a diagnostic listing of probed modules at tier 4
 */
export function resolveMonoModule(preferred?: string | readonly string[]): MonoResolution {
  const baked = preferred === undefined ? [] : typeof preferred === "string" ? [preferred] : preferred;

  // tier 1 — baked names
  for (const name of baked) {
    const mod = Process.findModuleByName(name);
    if (mod && exportsRoot(mod)) return { module: mod, tier: "baked" };
  }

  const modules = Process.enumerateModules();

  // tier 2 — conventional runtime module names
  for (const mod of modules) {
    if (MONO_MODULE_RE.test(mod.name) && exportsRoot(mod)) {
      return { module: mod, tier: "candidate" };
    }
  }

  // tier 3 — export scan across every loaded module
  for (const mod of modules) {
    if (exportsRoot(mod)) return { module: mod, tier: "scan" };
  }

  // tier 4 — diagnostic failure
  const names = modules.map((m) => m.name);
  const preview = names.slice(0, 12).join(", ");
  throw new Error(
    `[mono] no module exports ${ROOT_EXPORT} — is this a Mono/FNA game and is it fully loaded? ` +
      `probed ${names.length} module(s) (${preview}${names.length > 12 ? ", …" : ""})` +
      (baked.length ? `; baked candidate(s) ${baked.join(", ")} not loaded or missing the export` : ""),
  );
}
