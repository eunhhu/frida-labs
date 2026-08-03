// Target entry: _probe — generic, engine-agnostic first contact with ANY
// process. Run:  flab probe "Some Game.exe"
//
// Injects without any per-game config, detects the engine/managed runtime,
// and exposes the matching exploration surface over rpc.exports:
//   - always: modules, exports, scan, strings, peek/poke/freeze/watch, trace
//   - Unity Mono:   mono assemblies/classes/methods/invoke
//   - Cocos2d-x:    cocos symbol browse
//
// Use this to recon a new game before writing a real target under
// agent/targets/<game>/.

import { ok, warn } from "../../lib/log.js";
import * as detect from "../../lib/detect.js";
import * as mem from "../../lib/mem.js";
import * as search from "../../lib/search.js";
import * as hook from "../../lib/hook.js";
import * as watchlib from "../../lib/watch.js";
import * as stringslib from "../../lib/strings.js";
import * as cocos from "../../lib/cocos.js";
import { mono } from "../../lib/mono/index.js";

const engines = detect.detectAll();
if (engines.length === 0) ok("_probe: no known engine detected — native-only surface");
else for (const e of engines) ok(`_probe: detected ${e.label} @ ${e.module.name}`);

const freezes = new Map<string, watchlib.FreezeHandle>();

const base = {
  engines(): Array<{ id: string; label: string; module: string }> {
    return engines.map((e) => ({ id: e.id, label: e.label, module: e.module.name }));
  },
  modules(q: string) { return search.modules(q).map((m) => ({ name: m.name, base: m.base.toString() })); },
  exports(q: string, mod?: string) {
    return search.exports(q, mod).map((e) => `${(e as { module?: Module }).module?.name ?? "?"}!${e.name} @ ${e.address}`);
  },
  scan(pattern: string, modName?: string) {
    const m = modName ? Process.getModuleByName(modName) : mem.mainModule();
    return mem.scan(pattern, m).map((a) => a.toString());
  },
  strings(q: string, cap?: number) { return stringslib.strings(q, { cap }); },
  hexdump(addr: string, len?: number) { return mem.dump(ptr(addr), len ?? 128); },
  peek(addr: string, type?: watchlib.WatchType) { return watchlib.peek(ptr(addr), type); },
  poke(addr: string, value: number, type?: watchlib.WatchType) { return watchlib.poke(ptr(addr), value, type); },
  freeze(addr: string, value: number, type?: watchlib.WatchType): string {
    freezes.get(addr)?.stop();
    freezes.set(addr, watchlib.freeze(ptr(addr), value, type));
    return `frozen ${addr} = ${value}`;
  },
  unfreeze(addr: string): string {
    const h = freezes.get(addr);
    if (!h) return `no freeze on ${addr}`;
    h.stop();
    freezes.delete(addr);
    return `released ${addr}`;
  },
  watch(addr: string, type?: watchlib.WatchType): string {
    watchlib.watch(ptr(addr), type);
    return `watching ${addr}`;
  },
  trace(addr: string, args?: number): string {
    hook.trace(ptr(addr), { args: args ?? 4 });
    return `tracing ${addr}`;
  },
  detachAll(): string { hook.detachAll(); watchlib.unwatchAll(); return "detached"; },
};

// Engine-specific surface, layered on top when detected.
const extra: Record<string, (...a: never[]) => unknown> = {};

if (engines.some((e) => e.id === "unity-mono")) {
  extra.monoAssemblies = () => mono.assemblies();
  extra.monoClasses = (re: string, image = "Assembly-CSharp") =>
    mono.find(new RegExp(re, "i"), mono.image(image)).map((c) => `${c.ns}.${c.name}`);
  extra.monoMethods = (ns: string, klass: string) =>
    mono.methods(mono.classByName(ns, klass)).map((m) => m.full);
  extra.monoTrace = (ns: string, klass: string, method: string) => {
    const m = mono.method(ns, klass, method);
    return m ? (mono.trace(m) ? `tracing ${klass}::${method}` : `cannot hook ${klass}::${method}`) : `method not found`;
  };
}

if (engines.some((e) => e.id === "cocos2dx")) {
  extra.cocosSymbols = (re: string) => cocos.symbols(new RegExp(re, "i"));
}

if (engines.some((e) => e.id === "unreal")) {
  warn("_probe: UE game — lib/ue reflection runs eagerly on import, so it is not loaded here; write a real target importing ../../lib/ue");
}

rpc.exports = { ...base, ...extra };
