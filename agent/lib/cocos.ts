// Cocos2d-x helpers. Cocos has no stable C ABI across builds — most games
// statically link libcocos2d into the main binary with C++ symbols stripped
// or mangled — so this module is intentionally about *discovery*, not a
// canned cheat: find the cocos module, browse its symbols/exports by regex,
// and hook the per-frame scheduler entry point when a usable symbol exists.

import { ok, warn } from "./log.js";

export interface CocosModule {
  module: Module;
  /** True when cocos is statically linked into the main executable. */
  staticallyLinked: boolean;
}

/** Locate the cocos2d runtime module, or null when the game is not cocos. */
export function findCocos(): CocosModule | null {
  const m = Process.enumerateModules().find((x) => /cocos2d(cpp|js|x)?/i.test(x.name));
  if (m) return { module: m, staticallyLinked: false };
  const main = Process.enumerateModules()[0];
  const hasCocosSymbols =
    main.enumerateExports().some((e) => /cocos2d/i.test(e.name)) ||
    (() => { try { return main.enumerateSymbols().some((s) => /cocos2d/i.test(s.name)); } catch { return false; } })();
  return hasCocosSymbols ? { module: main, staticallyLinked: true } : null;
}

/** All cocos symbols/exports whose name matches `re`. */
export function symbols(re: RegExp, mod?: Module): Array<{ name: string; address: string }> {
  const m = mod ?? findCocos()?.module;
  if (!m) return [];
  const out: Array<{ name: string; address: string }> = [];
  for (const e of m.enumerateExports()) if (re.test(e.name)) out.push({ name: e.name, address: e.address.toString() });
  try {
    for (const s of m.enumerateSymbols()) if (re.test(s.name)) out.push({ name: s.name, address: s.address.toString() });
  } catch { /* stripped */ }
  ok(`cocos symbols matching ${re}: ${out.length}`);
  return out;
}

/**
 * Hook the scheduler's per-frame tick when a recognizable symbol exists
 * (unstripped builds). Returns the listener, or null when no symbol matched —
 * in that case use symbols(/update|tick|mainLoop/i) to pick one manually and
 * lib/hook.trace() on its address.
 */
export function hookMainLoop(onFrame: () => void): InvocationListener | null {
  const m = findCocos();
  if (!m) { warn("[cocos] no cocos module in this process"); return null; }
  const candidates = symbols(/Scheduler.*(update|tick)|Director.*(mainLoop|drawScene)/i, m.module);
  if (candidates.length === 0) {
    warn("[cocos] no scheduler symbol found (stripped build?) — browse with cocos.symbols(/update/i)");
    return null;
  }
  const target = ptr(candidates[0]!.address);
  ok(`[cocos] hooking main loop @ ${candidates[0]!.name}`);
  return Interceptor.attach(target, { onEnter() { onFrame(); } });
}
