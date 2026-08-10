// Target entry: _probe — generic, engine-agnostic first contact with ANY
// process. Run:  flab probe "Some Game.exe"
//
// Injects without any per-game config, detects the engine/managed runtime,
// and exposes the matching exploration surface over rpc.exports:
//   - always: modules/imports/exports/symbols, scan, strings, bounded memory
//             snapshots/diffs, peek/poke/freeze/watch, trace,
//             protection scan, loader-aware module hooking
//   - Unity Mono:   mono assemblies/classes/methods/invoke
//   - Cocos2d-x:    cocos symbol browse
//   - Android ART:  Java class trace, crypto/webview/intent watch, prefs dump
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
import * as instruments from "../../lib/instruments.js";
import * as recording from "../../lib/recording.js";
import * as loader from "../../lib/loader.js";
import * as protections from "../../lib/protections.js";
import * as jtrace from "../../lib/jtrace.js";
import { mono } from "../../lib/mono/index.js";

const engines = detect.detectAll();
if (engines.length === 0) ok("_probe: no known engine detected — native-only surface");
else for (const e of engines) ok(`_probe: detected ${e.label} @ ${e.module.name}`);
const javaAvailable = java.available();

const freezes = new Map<string, watchlib.FreezeHandle>();
const snapshots = new Map<string, { address: NativePointer; bytes: ArrayBuffer; length: number }>();
let nextSnapshotId = 1;
let rpcSurface: RpcExports = {};

function stopEverything(): instruments.InstrumentResult {
  recording.recordStop();
  const result = instruments.instrumentStopAll();
  for (const handle of freezes.values()) handle.stop();
  freezes.clear();
  snapshots.clear();
  hook.detachAll();
  watchlib.unwatchAll();
  return result;
}

const base = {
  ...recording.recordingRpcSurface(),
  engines(): Array<{ id: string; label: string; module: string }> {
    return engines.map((e) => ({ id: e.id, label: e.label, module: e.module.name }));
  },
  modules(q: string) { return search.modules(q).map((m) => ({ name: m.name, base: m.base.toString() })); },
  exports(q: string, mod?: string) {
    return search.exports(q, mod).map((e) => `${(e as { module?: Module }).module?.name ?? "?"}!${e.name} @ ${e.address}`);
  },
  imports(q: string, mod: string) {
    return search.imports(q, mod).slice(0, 500).map((entry) => ({
      name: entry.name,
      type: entry.type,
      address: entry.address?.toString() ?? null,
      module: entry.module ?? null,
    }));
  },
  symbols(q: string, mod: string) {
    return search.symbols(q, mod).slice(0, 500).map((entry) => ({
      name: entry.name,
      address: entry.address.toString(),
      size: entry.size,
    }));
  },
  scan(pattern: string, modName?: string) {
    const m = modName ? Process.getModuleByName(modName) : mem.mainModule();
    return mem.scan(pattern, m).map((a) => a.toString());
  },
  strings(q: string, cap?: number) { return stringslib.strings(q, { cap }); },
  hexdump(addr: string, len?: number) { return mem.dump(ptr(addr), len ?? 128); },
  memorySnapshot(addr: string, len = 256) {
    if (!Number.isInteger(len) || len < 1 || len > 4096) throw new Error("len must be an integer within 1..4096");
    const address = ptr(addr);
    const bytes = watchlib.snapshot(address, len);
    if (!bytes) throw new Error(`cannot read ${len} byte(s) at ${addr}`);
    while (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!);
    const id = `snap-${nextSnapshotId++}`;
    snapshots.set(id, { address, bytes, length: len });
    return { id, address: address.toString(), length: len };
  },
  memoryDiff(id: string) {
    const record = snapshots.get(id);
    if (!record) throw new Error(`snapshot ${JSON.stringify(id)} does not exist`);
    const changes = watchlib.diff(record.bytes, record.address, record.length);
    return {
      id,
      address: record.address.toString(),
      length: record.length,
      changed: changes.length,
      changes: changes.slice(0, 512),
      truncated: changes.length > 512,
    };
  },
  memorySnapshotList() {
    return [...snapshots].map(([id, record]) => ({ id, address: record.address.toString(), length: record.length }));
  },
  memorySnapshotDelete(id: string) { return { deleted: snapshots.delete(id), id }; },
  protectionsScan() {
    return protections.scanProtections().map((hit) => ({ id: hit.id, category: hit.category, detail: hit.detail }));
  },
  hookModuleLoad(modName: string, q?: string) {
    loader.hookNowOrOnLoad(modName, (mod) => {
      ok(`module ${mod.name} mapped @ ${mod.base}`);
      if (q) {
        try {
          const address = mod.getExportByName(q);
          hook.trace(address, {});
          ok(`tracing ${mod.name}!${q} @ ${address}`);
        } catch (e) {
          warn(`${mod.name}!${q} unresolved: ${(e as Error).message}`);
        }
      }
    });
    return Process.findModuleByName(modName) !== null
      ? `hooked already-loaded ${modName}`
      : `watching loader for ${modName}`;
  },
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
  instrumentStart(kind: unknown, addr: unknown, options?: unknown) {
    return instruments.instrumentStart(kind, addr, options);
  },
  instrumentList(state?: unknown) { return instruments.instrumentList(state); },
  instrumentStatus(id: unknown) { return instruments.instrumentStatus(id); },
  instrumentUpdate(id: unknown, patch: unknown) { return instruments.instrumentUpdate(id, patch); },
  instrumentStop(id: unknown) { return instruments.instrumentStop(id); },
  instrumentDelete(id: unknown) { return instruments.instrumentDelete(id); },
  instrumentStopAll() { return stopEverything(); },
  // --- 8 advanced-module demos (firing-verified; see appendix A of the plan) ---
  /** Stalker: capture events on the first enumerated thread for `ms`. */
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
      { name: "engines", doc: "Detected engines/managed runtimes", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "modules", args: [{ name: "q", type: "string" }], doc: "Modules matching substring", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "exports", args: [{ name: "q", type: "string" }, { name: "mod", type: "string?" }], doc: "Exports matching substring", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "imports", label: "Search imported functions", category: "Discovery", args: [{ name: "q", type: "string" }, { name: "mod", type: "string" }], doc: "Bounded imports matching a substring in one module", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "symbols", label: "Search debug symbols", category: "Discovery", args: [{ name: "q", type: "string" }, { name: "mod", type: "string" }], doc: "Bounded symbols matching a substring in one module", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "scan", args: [{ name: "pattern", type: "pattern" }, { name: "modName", type: "string?" }], doc: "Byte-pattern scan", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "strings", args: [{ name: "q", type: "string" }, { name: "cap", type: "integer?" }], doc: "String search", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "hexdump", args: [{ name: "addr", type: "address" }, { name: "len", type: "integer?" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "hex" },
      { name: "memorySnapshot", label: "Capture a memory baseline", category: "State diff", args: [{ name: "addr", type: "address" }, { name: "len", type: "integer?" }], doc: "Capture 1..4096 bytes under a stable session id; at most 32 baselines", capabilities: ["instrument", "analysis"], effect: "read", returns: "json", statusAction: "memorySnapshotList" },
      { name: "memoryDiff", label: "Compare with a baseline", category: "State diff", args: [{ name: "id", type: "string" }], doc: "Compare current memory with one captured baseline; returns at most 512 changes", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "memorySnapshotList", label: "List memory baselines", category: "State diff", doc: "List session-owned memory baselines", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "memorySnapshotDelete", label: "Delete a memory baseline", category: "State diff", args: [{ name: "id", type: "string" }], doc: "Delete one session-owned baseline", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "memorySnapshotList" },
      { name: "peek", args: [{ name: "addr", type: "address" }, { name: "type", type: "string?" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "scalar" },
      { name: "poke", args: [{ name: "addr", type: "address" }, { name: "value", type: "number" }, { name: "type", type: "string?" }], capabilities: ["instrument"], effect: "write", returns: "scalar" },
      { name: "freeze", args: [{ name: "addr", type: "address" }, { name: "value", type: "number" }, { name: "type", type: "string?" }], capabilities: ["instrument"], effect: "write", returns: "scalar" },
      { name: "unfreeze", args: [{ name: "addr", type: "address" }], capabilities: ["instrument"], effect: "control", returns: "scalar" },
      { name: "watch", args: [{ name: "addr", type: "address" }, { name: "type", type: "string?" }], capabilities: ["instrument"], effect: "hook", returns: "scalar" },
      { name: "trace", args: [{ name: "addr", type: "address" }, { name: "args", type: "integer?" }], capabilities: ["instrument"], effect: "hook", returns: "scalar" },
      { name: "instrumentStart", args: [{ name: "kind", type: "string" }, { name: "addr", type: "address" }, { name: "options", type: "json?" }], doc: "Create trace/watch/freeze. Options: trace {args,backtrace,log,label}; watch {type,label}; freeze {type,value,intervalMs,label}", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "instrumentStatus" },
      { name: "instrumentList", args: [{ name: "state", type: "string?" }], doc: "List managed instruments and their live verification state", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "instrumentStatus", args: [{ name: "id", type: "string" }], doc: "Inspect one managed instrument", capabilities: ["instrument", "analysis"], effect: "read", returns: "verification" },
      { name: "instrumentUpdate", args: [{ name: "id", type: "string" }, { name: "patch", type: "json" }], doc: "Edit address/options transactionally; the instrument keeps its stable id", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "instrumentStatus" },
      { name: "instrumentStop", args: [{ name: "id", type: "string" }], doc: "Stop an instrument but keep its history", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "instrumentStatus" },
      { name: "instrumentDelete", args: [{ name: "id", type: "string" }], doc: "Stop and permanently remove one managed instrument", capabilities: ["instrument"], effect: "control", returns: "scalar" },
      { name: "instrumentStopAll", doc: "Stop every managed instrument before detach or reload", capabilities: ["instrument"], effect: "control", returns: "table" },
      ...recording.recordingDescriptors(),
      { name: "protectionsScan", label: "Scan protection primitives", category: "Discovery", doc: "Report anti-debug / root-detect / SSL-pinning / crypto surfaces present in the process (detection only)", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "hookModuleLoad", label: "Hook on module load", category: "Discovery", args: [{ name: "modName", type: "string" }, { name: "q", type: "string?" }], doc: "Loader-aware hook: wait for a module to map (dlopen hook), optionally trace one export", capabilities: ["instrument"], effect: "hook", returns: "scalar" },
      { name: "detachAll", capabilities: ["instrument"], effect: "control", returns: "scalar" },
      { name: "demoStalker", args: [{ name: "ms", type: "integer?" }], doc: "Stalker block capture demo (firing-verified)", capabilities: ["instrument", "debug"], effect: "hook", returns: "verification" },
      { name: "demoMam", doc: "MemoryAccessMonitor hit demo", capabilities: ["instrument", "debug"], effect: "hook", returns: "verification" },
      { name: "demoSym", args: [{ name: "q", type: "string?" }], doc: "DebugSymbol resolve demo", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "demoObjcGate", doc: "ObjC bridge gate status", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "demoJavaGate", doc: "Java bridge gate status", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "demoHookVerified", doc: "Verified Interceptor attach, strict assertFired", capabilities: ["instrument", "debug"], effect: "hook", returns: "verification" },
      { name: "demoExcrashInstall", doc: "Exception-report install/uninstall demo", capabilities: ["debug"], effect: "control", returns: "json" },
      { name: "demoReplace", doc: "Interceptor.replace with JS implementation", capabilities: ["instrument", "debug"], effect: "hook", returns: "verification" },
    ];
    if (engines.some((e) => e.id === "unity-mono")) {
      d.push(
        { name: "monoAssemblies", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" }, { name: "monoClasses", args: [{ name: "re", type: "string" }, { name: "image", type: "string?" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
        { name: "monoMethods", args: [{ name: "ns", type: "string" }, { name: "klass", type: "string" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
        { name: "monoTrace", args: [{ name: "ns", type: "string" }, { name: "klass", type: "string" }, { name: "method", type: "string" }], capabilities: ["instrument"], effect: "hook", returns: "scalar" },
      );
    }
    if (engines.some((e) => e.id === "cocos2dx")) d.push({ name: "cocosSymbols", args: [{ name: "re", type: "string" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "table" });
    if (javaAvailable) {
      d.push(
        { name: "javaTraceClass", label: "Trace a Java class", category: "Discovery", args: [{ name: "className", type: "string" }], doc: "Trace every declared method (all overloads) of one Java class", capabilities: ["instrument"], effect: "hook", returns: "scalar" },
        { name: "javaWatchCrypto", label: "Watch crypto operations", category: "Discovery", doc: "Observe Cipher/MessageDigest keys, plaintext, and digests (observation only)", capabilities: ["instrument", "analysis"], effect: "hook", returns: "scalar" },
        { name: "javaWatchWebViews", label: "Watch WebViews", category: "Discovery", doc: "Enable contents debugging; observe loadUrl and addJavascriptInterface bridges", capabilities: ["instrument", "analysis"], effect: "hook", returns: "scalar" },
        { name: "javaDumpPrefs", label: "Dump SharedPreferences", category: "Discovery", doc: "Dump every SharedPreferences file in the app's private storage", capabilities: ["instrument", "analysis"], effect: "read", returns: "scalar" },
        { name: "javaWatchIntents", label: "Watch intents", category: "Discovery", doc: "Log startActivity and sendBroadcast with extras", capabilities: ["instrument", "analysis"], effect: "hook", returns: "scalar" },
      );
    }
    d.push({ name: "__describe", doc: "This descriptor" });
    const metadata = new Map(d.map((item) => [String((item as { name: string }).name), item]));
    return Object.keys(rpcSurface).map((name) => metadata.get(name) ?? {
      name,
      doc: "Exported RPC without explicit metadata",
      capabilities: ["instrument"],
      effect: "control",
      returns: "json",
    });
  },
  detachAll(): string {
    stopEverything();
    return "detached";
  },
};

// Engine-specific surface, layered on top when detected.
const extra: RpcExports = {};

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

if (javaAvailable) {
  extra.javaTraceClass = (className: string) => {
    const count = jtrace.traceClass(className);
    return count > 0 ? `tracing ${count} overload(s) in ${className}` : `cannot trace ${className} (VM or class unavailable)`;
  };
  extra.javaWatchCrypto = () => jtrace.watchCrypto() ? "crypto watch installed" : "no Java runtime";
  extra.javaWatchWebViews = () => jtrace.watchWebViews() ? "webview watch installed" : "no Java runtime";
  extra.javaDumpPrefs = () => jtrace.dumpSharedPreferences() ? "preferences dumped to log" : "no Java runtime";
  extra.javaWatchIntents = () => jtrace.watchIntents() ? "intent watch installed" : "no Java runtime";
}

if (engines.some((e) => e.id === "unreal")) {
  warn("_probe: UE game — lib/ue is lazy since Phase B but its queries are game-specific, so it is not exercised here; write a real target importing ../../lib/ue");
}

rpcSurface = { ...base, ...extra };
rpc.exports = rpcSurface;
