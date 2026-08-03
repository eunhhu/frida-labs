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
import * as stalker from "../../lib/stalker.js";
import * as mam from "../../lib/mam.js";
import * as sym from "../../lib/sym.js";
import * as objc from "../../lib/objc.js";
import * as java from "../../lib/java.js";
import * as excrash from "../../lib/excrash.js";
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
  // --- 8 advanced-module demos (firing-verified; see appendix A of the plan) ---
  /** Stalker: capture basic-block events on the main thread for `ms`. */
  async demoStalker(ms?: number): Promise<{ total: number; verified: boolean; state: string }> {
    const tid = Process.enumerateThreads()[0]!.id;
    const s = await stalker.sample(ms ?? 300, tid, { events: { block: true } });
    return { total: s.total, verified: s.verification.verified, state: s.verification.state };
  },
  /** MemoryAccessMonitor: watch a page deep inside a large private allocation,
   *  write to it, expect a hit. The offset keeps gum's own heap traffic (which
   *  would fault-storm the runtime and destroy the script) off the watched page. */
  async demoMam(ms?: number): Promise<{ fired: number; verified: boolean }> {
    const block = Memory.alloc(0x100000);
    const page = block.add(0x80000).and(ptr("0xfffffffffffff000"));
    return mam.probe({ base: page, size: Process.pageSize }, ms ?? 300, () => {
      for (let i = 0; i < 8; i++) page.add(i).writeU8(0x41 + i);
      page.readU8(); // read-trigger too: darwin MAM delivery is historically flaky
    });
  },
  /** DebugSymbol: resolve an export and symbolicate it back. */
  demoSym(q?: string): { matches: number; sample: string } {
    const addr = Module.findGlobalExportByName(q ?? "open");
    const fns = sym.findFunctionsMatching(q ? `*${q}*` : "*open*");
    const at = addr ?? fns[0];
    return { matches: fns.length, sample: at ? sym.fromAddress(at) : "unresolved" };
  },
  /** ObjC bridge gate (Darwin only). */
  demoObjcGate(): { platform: string; available: boolean; classCount?: number } { return objc.status(); },
  /** Java bridge gate (expected available:false off-Android). */
  demoJavaGate(): { platform: string; available: boolean; androidVersion?: string } { return java.status(); },
  /** hook 심화: verified attach to a libc fn, trigger via NativeFunction, assertFired(strict). */
  demoHookVerified(): { fired: number; verified: boolean } {
    const getpid = Module.findGlobalExportByName("getpid");
    if (!getpid) return { fired: 0, verified: false };
    const listener = Interceptor.attach(getpid, { onEnter() { v.note(); } });
    const v = hook.withVerification(listener, "demo getpid");
    new NativeFunction(getpid, "int", [])(); // side-effect-free trigger
    const ok_ = v.assertFired({ strict: true, label: "hook getpid" });
    v.detach();
    return { fired: v.fired, verified: ok_ };
  },
  /** excrash: install → status → uninstall (no real fault; reception is host-side). */
  demoExcrashInstall(): { installed: boolean; reports: number } {
    const s = excrash.install();
    const r = { installed: true, reports: s.reports.length };
    s.uninstall();
    return r;
  },
  /** hook 심화: Interceptor.replace with a JS implementation, trigger, verify, revert. */
  demoReplace(): { fired: number; fake: string } {
    const getpid = Module.findGlobalExportByName("getpid");
    if (!getpid) return { fired: 0, fake: "no getpid" };
    const v = hook.implementation(getpid, () => 4242, "int", []);
    const got = new NativeFunction(getpid, "int", [])();
    v.detach(); // Interceptor.revert
    return { fired: v.fired, fake: `getpid() -> ${got}` };
  },
  /** Structured rpc surface descriptor — consumed by the host describe(). */
  __describe(): unknown {
    const d: Array<unknown> = [
      { name: "engines", doc: "Detected engines/managed runtimes" },
      { name: "modules", args: [{ name: "q", type: "string" }], doc: "Modules matching substring" },
      { name: "exports", args: [{ name: "q", type: "string" }, { name: "mod", type: "string?" }], doc: "Exports matching substring" },
      { name: "scan", args: [{ name: "pattern", type: "string" }, { name: "modName", type: "string?" }], doc: "Byte-pattern scan" },
      { name: "strings", args: [{ name: "q", type: "string" }, { name: "cap", type: "number?" }], doc: "String search" },
      { name: "hexdump", args: [{ name: "addr", type: "string" }, { name: "len", type: "number?" }] },
      { name: "peek", args: [{ name: "addr", type: "string" }, { name: "type", type: "string?" }] },
      { name: "poke", args: [{ name: "addr", type: "string" }, { name: "value", type: "number" }, { name: "type", type: "string?" }] },
      { name: "freeze", args: [{ name: "addr", type: "string" }, { name: "value", type: "number" }, { name: "type", type: "string?" }] },
      { name: "unfreeze", args: [{ name: "addr", type: "string" }] },
      { name: "watch", args: [{ name: "addr", type: "string" }, { name: "type", type: "string?" }] },
      { name: "trace", args: [{ name: "addr", type: "string" }, { name: "args", type: "number?" }] },
      { name: "detachAll" },
      { name: "demoStalker", args: [{ name: "ms", type: "number?" }], doc: "Stalker block capture demo (firing-verified)" },
      { name: "demoMam", doc: "MemoryAccessMonitor hit demo" },
      { name: "demoSym", args: [{ name: "q", type: "string?" }], doc: "DebugSymbol resolve demo" },
      { name: "demoObjcGate", doc: "ObjC bridge gate status" },
      { name: "demoJavaGate", doc: "Java bridge gate status" },
      { name: "demoHookVerified", doc: "Verified Interceptor attach, strict assertFired" },
      { name: "demoExcrashInstall", doc: "Exception-report install/uninstall demo" },
      { name: "demoReplace", doc: "Interceptor.replace with JS implementation" },
    ];
    if (engines.some((e) => e.id === "unity-mono")) {
      d.push(
        { name: "monoAssemblies" }, { name: "monoClasses", args: [{ name: "re", type: "string" }, { name: "image", type: "string?" }] },
        { name: "monoMethods", args: [{ name: "ns", type: "string" }, { name: "klass", type: "string" }] },
        { name: "monoTrace", args: [{ name: "ns", type: "string" }, { name: "klass", type: "string" }, { name: "method", type: "string" }] },
      );
    }
    if (engines.some((e) => e.id === "cocos2dx")) d.push({ name: "cocosSymbols", args: [{ name: "re", type: "string" }] });
    d.push({ name: "__describe", doc: "This descriptor" });
    return d;
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
