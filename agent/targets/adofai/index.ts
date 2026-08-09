// Target entry: A Dance of Fire and Ice (Unity, Mono backend).
// Build/run:  flab run adofai
//
// All the heavy lifting is in ../../lib/mono — this only exposes target RPC glue.

import { ok } from "../../lib/log.js";
import type { Verification } from "../../lib/hook.js";
import { mono } from "../../lib/mono/index.js";
import { recordingDescriptors, recordingRpcSurface } from "../../lib/recording.js";

const traces = new Set<Verification>();

type AssistKey = "noFail" | "infiniteMargin" | "freeroamInvulnerability";

const Controller = mono.klass("", "scrController");
const controllerRef = mono.staticRef(Controller, "_instance");
const assistFields = {
  noFail: mono.field(Controller, "noFail"),
  infiniteMargin: mono.field(Controller, "noFailInfiniteMargin"),
  freeroamInvulnerability: mono.field(Controller, "freeroamInvulnerability"),
} as const;
const sceneFields = {
  state: mono.field(Controller, "currentState"),
  floor: mono.field(Controller, "currentFloorID"),
  gameWorld: mono.field(Controller, "gameworld"),
  percentComplete: mono.field(Controller, "oldPercentComplete"),
} as const;
const levelName = mono.refField(Controller, "levelName");
const wanted: Partial<Record<AssistKey, boolean>> = {};
let capturedController: NativePointer = NULL;
let captured: Partial<Record<AssistKey, number>> = {};
let enforceTimer: ReturnType<typeof setInterval> | null = null;
let applied = 0;
let lastAppliedAt: string | null = null;

function liveController(): NativePointer {
  try { return controllerRef(); } catch { return NULL; }
}

function assistRead(): Record<string, unknown> {
  const controller = liveController();
  const values: Partial<Record<AssistKey, boolean | null>> = {};
  for (const key of Object.keys(assistFields) as AssistKey[]) {
    const field = assistFields[key];
    values[key] = controller.isNull() || !field.exists ? null : field.read(controller) !== 0;
  }
  return {
    ready: !controller.isNull(),
    controller: controller.isNull() ? null : controller.toString(),
    scene: controller.isNull() ? null : {
      level: levelName.exists ? mono.readString(levelName.read(controller)) : null,
      state: sceneFields.state.exists ? sceneFields.state.read(controller) : null,
      floor: sceneFields.floor.exists ? sceneFields.floor.read(controller) : null,
      gameWorld: sceneFields.gameWorld.exists ? sceneFields.gameWorld.read(controller) !== 0 : null,
      percentComplete: sceneFields.percentComplete.exists ? sceneFields.percentComplete.read(controller) : null,
    },
    values,
    wanted: { ...wanted },
    enforcing: enforceTimer !== null,
    applied,
    lastAppliedAt,
  };
}

function applyWanted(): { ok: boolean; verified: boolean; fired: number; state: "verified" | "unverified"; detail: string; readback: Record<string, unknown> } {
  const controller = liveController();
  if (controller.isNull()) {
    return { ok: false, verified: false, fired: 0, state: "unverified", detail: "load an offline level first", readback: assistRead() };
  }
  if (capturedController.isNull() || !capturedController.equals(controller)) {
    capturedController = controller;
    captured = {};
  }
  let writes = 0;
  for (const key of Object.keys(wanted) as AssistKey[]) {
    const field = assistFields[key];
    if (!field.exists) continue;
    if (captured[key] == null) captured[key] = field.read(controller);
    field.write(controller, wanted[key] ? 1 : 0);
    writes++;
  }
  let readback = assistRead();
  const values = readback.values as Record<string, boolean | null>;
  const verified = writes > 0 && (Object.keys(wanted) as AssistKey[]).every((key) => values[key] === wanted[key]);
  if (verified) {
    applied++;
    lastAppliedAt = new Date().toISOString();
    readback = assistRead();
  }
  return {
    ok: verified,
    verified,
    fired: verified ? 1 : 0,
    state: verified ? "verified" : "unverified",
    detail: verified ? `wrote and read back ${writes} live scrController fields` : "live field readback did not match",
    readback,
  };
}

function setEnforcement(on: boolean, intervalMs = 250): Record<string, unknown> {
  if (enforceTimer) clearInterval(enforceTimer);
  enforceTimer = null;
  if (on) {
    if (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 5_000) {
      throw new Error("intervalMs must be an integer within 50..5,000");
    }
    enforceTimer = setInterval(() => { try { applyWanted(); } catch { /* scene transition */ } }, intervalMs);
  }
  return assistRead();
}

function resetAssist(): { ok: boolean; restored: number; clean: boolean; failed: string[] } {
  setEnforcement(false);
  const controller = liveController();
  let restored = 0;
  const failed: string[] = [];
  if (!controller.isNull() && !capturedController.isNull() && capturedController.equals(controller)) {
    for (const key of Object.keys(captured) as AssistKey[]) {
      try {
        assistFields[key].write(controller, captured[key]!);
        if (assistFields[key].read(controller) !== captured[key]) throw new Error("readback mismatch");
        restored++;
      } catch { failed.push(key); }
    }
  }
  for (const key of Object.keys(wanted) as AssistKey[]) delete wanted[key];
  captured = {};
  capturedController = NULL;
  return { ok: failed.length === 0, restored, clean: failed.length === 0, failed };
}

function stopTraces(): { ok: boolean; stopped: number; assist: ReturnType<typeof resetAssist>; clean: boolean } {
  const stopped = traces.size;
  for (const trace of traces) trace.detach();
  traces.clear();
  const assist = resetAssist();
  return { ok: assist.ok, stopped, assist, clean: assist.clean };
}

function runtimeInfo(): { assemblies: number; hasAssemblyCSharp: boolean; classes: number } {
  const asms = mono.assemblies();
  const cs = mono.image("Assembly-CSharp");
  return { assemblies: asms.length, hasAssemblyCSharp: !!cs, classes: cs ? mono.classes(cs).length : 0 };
}

rpc.exports = {
  ...recordingRpcSurface(),
  modInfo() {
    return {
      game: "A Dance of Fire and Ice",
      runtime: "Unity Mono",
      safety: "Owned offline play only; gameplay assistance requires explicit confirmation",
      coverage: "managed discovery/Record plus live-verified no-fail controller fields",
      facts: runtimeInfo(),
    };
  },
  modState() {
    return {
      traces: [...traces].map((trace) => trace.status()),
      traceCount: traces.size,
      assist: assistRead(),
      clean: traces.size === 0 && enforceTimer === null && Object.keys(wanted).length === 0,
    };
  },
  info() { return runtimeInfo(); },
  assemblies() { return mono.assemblies(); },

  /** All Assembly-CSharp class names, or those matching a regex. */
  classes(pattern?: string) {
    const all = mono.classes();
    const names = all.map((c) => (c.ns ? `${c.ns}.${c.name}` : c.name));
    if (!pattern) return { total: names.length, names };
    const re = new RegExp(pattern, "i");
    return names.filter((n) => re.test(n));
  },

  methods(className: string, ns?: string | null) {
    return mono.methods(mono.classByName(ns ?? "", className)).map((m) => m.full);
  },
  fields(className: string, ns?: string | null) {
    return mono.fields(mono.classByName(ns ?? "", className)).map((f) => `+0x${f.offset.toString(16)} ${f.name}`);
  },

  /** Native (JIT) address of a managed method — feed to disassemble/decompile. */
  address(className: string, method: string, ns?: string | null) {
    return mono.addressOf(mono.method(ns ?? "", className, method))?.toString() ?? null;
  },
  /** Log every call to a managed method. */
  trace(className: string, method: string, ns?: string | null) {
    const trace = mono.trace(mono.method(ns ?? "", className, method));
    if (!trace) return { ok: false, error: "method not found" };
    traces.add(trace);
    return { ok: true, method: `${className}.${method}`, verification: trace.status(), traceCount: traces.size };
  },
  assistRead,
  assistApply(opts: Record<string, boolean>, offlineConfirmed: boolean) {
    if (offlineConfirmed !== true) throw new Error("assistApply requires offlineConfirmed=true");
    if (!opts || Array.isArray(opts) || typeof opts !== "object") throw new Error("assist options must be an object");
    const keys = Object.keys(opts);
    if (keys.length === 0) throw new Error("assist options must contain at least one field");
    for (const key of keys) {
      if (!(key in assistFields)) throw new Error(`unknown assist field ${JSON.stringify(key)}`);
      if (typeof opts[key] !== "boolean") throw new Error(`${key} must be boolean`);
      wanted[key as AssistKey] = opts[key];
    }
    return applyWanted();
  },
  assistEnforce(on: boolean, offlineConfirmed?: boolean, intervalMs?: number) {
    if (on && offlineConfirmed !== true) throw new Error("assistEnforce requires offlineConfirmed=true when enabling");
    return setEnforcement(!!on, intervalMs);
  },
  assistReset() { return resetAssist(); },
  resetAll() { return stopTraces(); },
  dispose() { return stopTraces(); },

  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this Instrument", category: "Start here", doc: "Runtime, safety boundary, and live discovery coverage", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modState", label: "Show active traces", category: "Start here", doc: "Firing state for every owned managed trace", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "info", label: "Read Mono runtime facts", category: "Discovery", doc: "Assembly/image/class counts", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "assemblies", label: "List loaded assemblies", category: "Discovery", doc: "Loaded assembly image names", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "classes", label: "List managed classes", category: "Discovery", args: [{ name: "pattern", type: "string?", ui: { control: "input", label: "Class filter", placeholder: "optional regex" } }], doc: "Assembly-CSharp classes with optional regex filter", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "methods", label: "List class methods", category: "Discovery", args: [{ name: "className", type: "string" }, { name: "ns", type: "string?" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "fields", label: "List class fields", category: "Discovery", args: [{ name: "className", type: "string" }, { name: "ns", type: "string?" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "address", label: "Resolve method address", category: "Discovery", args: [{ name: "className", type: "string" }, { name: "method", type: "string" }, { name: "ns", type: "string?" }], capabilities: ["instrument", "analysis"], effect: "read", returns: "scalar" },
      { name: "trace", label: "Trace managed method", category: "Debug", args: [{ name: "className", type: "string" }, { name: "method", type: "string" }, { name: "ns", type: "string?" }], doc: "Owned firing-verified trace; resetAll detaches it", capabilities: ["instrument", "debug"], effect: "hook", returns: "verification", statusAction: "modState" },
      { name: "assistRead", label: "Read gameplay assistance", category: "Gameplay", doc: "Live scrController readiness, values, enforcement, and write receipts", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "assistApply", label: "Apply gameplay assistance", category: "Gameplay", args: [{ name: "opts", type: "json", ui: { control: "input", label: "Assistance values", default: "{\"noFail\":true}", placeholder: "{\"noFail\":true}" } }, { name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Apply noFail, infiniteMargin, or freeroamInvulnerability with immediate readback", capabilities: ["instrument"], effect: "write", returns: "verification", statusAction: "assistRead" },
      { name: "assistEnforce", label: "Keep assistance active", category: "Gameplay", args: [{ name: "on", type: "boolean", ui: { control: "checkbox", label: "Continuous enforcement" } }, { name: "offlineConfirmed", type: "boolean?", ui: { control: "checkbox", label: "Owned offline session" } }, { name: "intervalMs", type: "integer?", ui: { control: "slider", label: "Refresh interval (ms)", min: 50, max: 5000, step: 50, default: 250 } }], doc: "Re-resolve the live controller across level transitions", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "assistRead" },
      { name: "assistReset", label: "Restore gameplay assistance", category: "Gameplay", doc: "Stop enforcement and restore captured live values", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "assistRead" },
      { name: "resetAll", label: "Stop every trace", category: "Start here", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose owned handles", category: "Start here", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      ...recordingDescriptors(),
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

ok(`adofai (mono) ready — ${mono.assemblies().length} assemblies`);
