// Target entry: A Dance of Fire and Ice (Unity, Mono backend).
// Build/run:  flab run adofai
//
// All the heavy lifting is in ../../lib/mono — this only exposes target RPC glue.

import { ok } from "../../lib/log.js";
import type { Verification } from "../../lib/hook.js";
import { mono } from "../../lib/mono/index.js";
import { control, defineInstrument, field, hook, read, write } from "../../lib/instrument.js";
import { recordingInstrumentActions } from "../../lib/recording.js";

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

rpc.exports = defineInstrument({
  info: read({
    label: "About this Instrument",
    category: "Start here",
    doc: "Runtime, safety boundary, and live discovery coverage",
  }, () => ({
      game: "A Dance of Fire and Ice",
      runtime: "Unity Mono",
      safety: "Owned offline play only; gameplay assistance requires explicit confirmation",
      coverage: "managed discovery/Record plus live-verified no-fail controller fields",
      facts: runtimeInfo(),
  })),
  state: read({
    label: "Active Instrument state",
    category: "Start here",
    doc: "Owned traces, assistance, enforcement, and clean state",
  }, () => ({
      traces: [...traces].map((trace) => trace.status()),
      traceCount: traces.size,
      assist: assistRead(),
      clean: traces.size === 0 && enforceTimer === null && Object.keys(wanted).length === 0,
  })),
  actions: {
    assistApply: write({
      label: "Gameplay assistance",
      category: "Gameplay",
      args: [
        field.json("opts", { label: "Assistance values", default: "{\"noFail\":true}", placeholder: "{\"noFail\":true}" }),
        field.offline(),
      ],
      doc: "Apply no-fail, infinite margin, or freeroam invulnerability with immediate readback",
      returns: "verification",
      status: "assistRead",
    }, (opts: Record<string, boolean>, offlineConfirmed: boolean) => {
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
    }),
    assistEnforce: control({
      label: "Continuous assistance",
      category: "Gameplay",
      args: [
        field.checkbox("on", { label: "Continuous enforcement" }),
        field.offline({ optional: true }),
        field.slider("intervalMs", { label: "Refresh interval (ms)", optional: true, integer: true, min: 50, max: 5000, step: 50, default: 250 }),
      ],
      doc: "Re-resolve the live controller across level transitions",
      status: "assistRead",
    }, (on: boolean, offlineConfirmed?: boolean, intervalMs?: number) => {
      if (on && offlineConfirmed !== true) throw new Error("assistEnforce requires offlineConfirmed=true when enabling");
      return setEnforcement(!!on, intervalMs);
    }),
    assistReset: control({
      label: "Restore gameplay assistance",
      category: "Gameplay",
      doc: "Stop enforcement and restore captured live values",
      status: "assistRead",
    }, resetAssist),
    assistRead: read({
      label: "Gameplay assistance status",
      category: "Gameplay",
      doc: "Live controller readiness, values, enforcement, and write receipts",
    }, assistRead),
    trace: hook({
      label: "Trace managed method",
      category: "Debug",
      args: [field.text("className"), field.text("method"), field.text("ns", { optional: true })],
      doc: "Owned firing-verified trace; resetAll detaches it",
      capabilities: ["instrument", "debug"],
      returns: "verification",
      status: "modState",
    }, (className: string, method: string, ns?: string | null) => {
      const trace = mono.trace(mono.method(ns ?? "", className, method));
      if (!trace) return { ok: false, error: "method not found" };
      traces.add(trace);
      return { ok: true, method: `${className}.${method}`, verification: trace.status(), traceCount: traces.size };
    }),
    info: read({ label: "Mono runtime facts", category: "Discovery", doc: "Assembly/image/class counts" }, runtimeInfo),
    assemblies: read({ label: "Loaded assemblies", category: "Discovery", doc: "Loaded assembly image names", returns: "table" }, () => mono.assemblies()),
    classes: read({
      label: "Managed classes",
      category: "Discovery",
      args: [field.text("pattern", { optional: true, label: "Class filter", placeholder: "optional regex" })],
      doc: "Assembly-CSharp classes with optional regex filter",
    }, (pattern?: string) => {
      const names = mono.classes().map((candidate) => candidate.ns ? `${candidate.ns}.${candidate.name}` : candidate.name);
      if (!pattern) return { total: names.length, names };
      const regex = new RegExp(pattern, "i");
      return names.filter((name) => regex.test(name));
    }),
    methods: read({ label: "Class methods", category: "Discovery", args: [field.text("className"), field.text("ns", { optional: true })], returns: "table" },
      (className: string, ns?: string | null) => mono.methods(mono.classByName(ns ?? "", className)).map((method) => method.full)),
    fields: read({ label: "Class fields", category: "Discovery", args: [field.text("className"), field.text("ns", { optional: true })], returns: "table" },
      (className: string, ns?: string | null) => mono.fields(mono.classByName(ns ?? "", className)).map((item) => `+0x${item.offset.toString(16)} ${item.name}`)),
    address: read({ label: "Method address", category: "Discovery", args: [field.text("className"), field.text("method"), field.text("ns", { optional: true })], returns: "scalar" },
      (className: string, method: string, ns?: string | null) => mono.addressOf(mono.method(ns ?? "", className, method))?.toString() ?? null),
    ...recordingInstrumentActions(),
  },
  reset: control({ label: "Reset every change", category: "Start here", status: "modState" }, stopTraces),
  dispose: control({ label: "Dispose owned handles", category: "Start here", status: "modState" }, stopTraces),
});

ok(`adofai (mono) ready — ${mono.assemblies().length} assemblies`);
