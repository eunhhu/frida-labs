// Target entry: MECCHA CHAMELEON (PenguinHotel-Win64-Shipping.exe).
// Build:  flab build mecchachameleon   (frida-compile -> _agent.js)
// Drive:  flab run mecchachameleon     (advanced console over rpc.exports)
//
// Everything here is game-specific glue; the heavy lifting lives in ../../lib.

import { ok } from "../../lib/log.js";
import * as ue from "../../lib/ue/index.js";
import { recordingDescriptors, recordingRpcSurface } from "../../lib/recording.js";

const ACTOR_CLASSES = /Hunter|Survivor|BigPen|AI_Base/;
const PLAYER_CONTROLLER_CLASS = "BP_PlayerController_cLeon_C";
type Role = "HUNTER" | "SURVIVOR";
const roleOf = (className: string): Role => /Hunter|BigPen/.test(className) ? "HUNTER" : "SURVIVOR";
const COLORS: Record<Role, readonly [number, number, number, number]> = {
  HUNTER: [1, 0.1, 0.1, 1],
  SURVIVOR: [0.1, 1, 0.1, 1],
};

function pointerChildren(owner: NativePointer, span = 0x1_000): Array<{ offset: number; pointer: string; className: string | null; name: string | null }> {
  const out: Array<{ offset: number; pointer: string; className: string | null; name: string | null }> = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < span && out.length < 128; offset += Process.pointerSize) {
    let candidate: NativePointer | null = null;
    try { candidate = owner.add(offset).readPointer(); } catch { continue; }
    if (!candidate || candidate.isNull() || seen.has(candidate.toString())) continue;
    try {
      const className = ue.classNameOf(candidate);
      if (!className || className.length > 128 || !/^[\x20-\x7e]+$/.test(className)) continue;
      seen.add(candidate.toString());
      out.push({ offset, pointer: candidate.toString(), className, name: ue.nameOf(candidate) });
    } catch { /* not a UObject */ }
  }
  return out;
}

function movementProperties(object: NativePointer): Array<{ owner: string | null; name: string; offset: number | null }> {
  const out: Array<{ owner: string | null; name: string; offset: number | null }> = [];
  let cls = ue.classOf(object);
  for (let generation = 0; cls && generation < 40 && out.length < 256; generation++) {
    let field: NativePointer | null = null;
    try { field = cls.add(ue.O.CHILDPROPS).readPointer(); } catch { field = null; }
    for (let index = 0; field && index < 1_000 && out.length < 256; index++) {
      let name: string | null = null;
      let offset: number | null = null;
      try {
        name = ue.fname(field.add(ue.O.FIELD_NAME));
        offset = field.add(ue.O.PROP_OFFSET).readU32();
      } catch { /* malformed field */ }
      if (name && /movement|speed|jump|gravity|air|walk|fly|force|dash/i.test(name)) {
        out.push({ owner: ue.nameOf(cls), name, offset });
      }
      try { field = field.add(ue.O.FIELD_NEXT).readPointer(); } catch { field = null; }
    }
    cls = ue.superOf(cls);
  }
  return out;
}

function objectProperties(object: NativePointer): Array<{ owner: string | null; name: string; offset: number | null }> {
  const out: Array<{ owner: string | null; name: string; offset: number | null }> = [];
  let cls = ue.classOf(object);
  for (let generation = 0; cls && generation < 40 && out.length < 256; generation++) {
    let field: NativePointer | null = null;
    try { field = cls.add(ue.O.CHILDPROPS).readPointer(); } catch { field = null; }
    for (let index = 0; field && index < 1_000 && out.length < 256; index++) {
      try {
        const name = ue.fname(field.add(ue.O.FIELD_NAME));
        if (name) out.push({ owner: ue.nameOf(cls), name, offset: field.add(ue.O.PROP_OFFSET).readU32() });
      } catch { /* malformed field */ }
      try { field = field.add(ue.O.FIELD_NEXT).readPointer(); } catch { field = null; }
    }
    cls = ue.superOf(cls);
  }
  return out;
}

function ownedObjects(owner: NativePointer): Array<{ pointer: string; className: string | null; name: string | null }> {
  const out: Array<{ pointer: string; className: string | null; name: string | null }> = [];
  for (let index = 0; index < ue.oa().num && out.length < 128; index++) {
    const object = ue.objAt(index);
    if (!object) continue;
    try {
      if (ue.outerOf(object)?.equals(owner)) out.push({ pointer: object.toString(), className: ue.classNameOf(object), name: ue.nameOf(object) });
    } catch { /* stale UObject */ }
  }
  return out;
}

function interestingFieldReads(object: NativePointer): Record<string, { offset: number; float: number | null; double: number | null; int: number | null; pointer: string | null; pointerClass: string | null }> {
  const out: Record<string, { offset: number; float: number | null; double: number | null; int: number | null; pointer: string | null; pointerClass: string | null }> = {};
  for (const property of objectProperties(object)) {
    if (property.offset == null || !/speed|accel|movement|gravity|jump|character$|settings/i.test(property.name) || Object.keys(out).length >= 64) continue;
    const address = object.add(property.offset);
    let pointer: NativePointer | null = null;
    let pointerClass: string | null = null;
    try { pointer = address.readPointer(); pointerClass = pointer.isNull() ? null : ue.classNameOf(pointer); } catch { pointer = null; }
    let float: number | null = null, double: number | null = null, int: number | null = null;
    try { float = address.readFloat(); } catch { /* unavailable */ }
    try { double = address.readDouble(); } catch { /* unavailable */ }
    try { int = address.readS32(); } catch { /* unavailable */ }
    out[`${property.owner ?? "?"}.${property.name}`] = { offset: property.offset, float, double, int, pointer: pointer?.toString() ?? null, pointerClass };
  }
  return out;
}

function containerObjects(object: NativePointer, property: string): { offset: number | null; data: string | null; count: number | null; capacity: number | null; objects: Array<{ dataOffset: number; pointer: string; className: string; name: string | null }> } {
  const offset = ue.propOff(object, property);
  if (offset == null) return { offset, data: null, count: null, capacity: null, objects: [] };
  let data: NativePointer | null = null, count: number | null = null, capacity: number | null = null;
  try { data = object.add(offset).readPointer(); count = object.add(offset + 8).readS32(); capacity = object.add(offset + 12).readS32(); } catch { data = null; }
  const objects: Array<{ dataOffset: number; pointer: string; className: string; name: string | null }> = [];
  const seen = new Set<string>();
  if (data && !data.isNull()) {
    for (let dataOffset = 0; dataOffset < 0x1_000 && objects.length < 128; dataOffset += Process.pointerSize) {
      let candidate: NativePointer | null = null;
      try { candidate = data.add(dataOffset).readPointer(); } catch { continue; }
      if (!candidate || candidate.isNull() || seen.has(candidate.toString())) continue;
      try {
        const className = ue.classNameOf(candidate);
        if (!className || className.length > 128 || !/^[\x20-\x7e]+$/.test(className)) continue;
        seen.add(candidate.toString());
        objects.push({ dataOffset, pointer: candidate.toString(), className, name: ue.nameOf(candidate) });
      } catch { /* not a UObject */ }
    }
  }
  return { offset, data: data?.toString() ?? null, count, capacity, objects };
}

function movementFieldValues(object: NativePointer): Record<string, { offset: number; float: number; byte: number }> {
  const out: Record<string, { offset: number; float: number; byte: number }> = {};
  for (const name of ["DefaultSpeed", "MoveSpeedMultiply", "EnableMovement", "GlobalSpeed", "DefaultMaxWalkSpeed", "DefaultJumpSpeed", "ClimbingSpeed", "BoostSpeed", "MaxBoostSpeed"]) {
    const offset = ue.propOff(object, name);
    if (offset == null) continue;
    try { out[name] = { offset, float: object.add(offset).readFloat(), byte: object.add(offset).readU8() }; } catch { /* unavailable */ }
  }
  return out;
}

const esp = ue.createEsp({
  actorClasses: ACTOR_CLASSES,
  controllerClass: PLAYER_CONTROLLER_CLASS,
  classify(_actor, className) {
    const role = roleOf(className);
    return { label: role, color: COLORS[role], hostile: role === "HUNTER" };
  },
  maxEntities: 128,
  refreshMs: 2_000,
});

function requireOffline(confirmed: boolean | undefined, action: string): void {
  if (confirmed !== true) throw new Error(`${action} requires offlineConfirmed=true`);
}

// rpc.exports — callable from the host client as `await api.<name>(...)`.
rpc.exports = {
  ...recordingRpcSurface(),
  modInfo() {
    return {
      game: "MECCHA CHAMELEON",
      runtime: "Unreal Engine 5 Mover",
      safety: "Authorized offline/single-player training only",
      aimAssist: "not shipped: engagement, visibility, and control paths are not live-verified",
      flight: "not exposed: this build uses Mover rather than CharacterMovementComponent",
    };
  },
  modState() { return { esp: esp.status(), movement: ue.moverMovement.status() }; },
  info() {
    return {
      module: ue.gameModule().name,
      base: ue.gameModule().base.toString(),
      objects: ue.oa().num,
      gobjects: ue.oa().objects.toString(),
      gnames: ue.gnames().toString(),
    };
  },
  classes(pkg = "/Script/PenguinHotel") {
    return ue.classesInPackage(pkg);
  },
  moveProbe() {
    const controller = ue.localPlayerController();
    const pawn = ue.controlledPawn();
    const pawnChildren = pawn ? pointerChildren(pawn) : [];
    const moverObjects = pawnChildren.filter((child) => /mover|force.?move/i.test(`${child.className} ${child.name}`)).map((child) => {
      const object = ptr(child.pointer);
      const containers = {
        movementModes: containerObjects(object, "MovementModes"),
        sharedSettings: containerObjects(object, "SharedSettings"),
        transitions: containerObjects(object, "Transitions"),
      };
      const related = [...containers.movementModes.objects, ...containers.sharedSettings.objects]
        .filter((candidate) => /mode|settings/i.test(candidate.className))
        .slice(0, 16)
        .map((candidate) => {
          const relatedObject = ptr(candidate.pointer);
          return { ...candidate, properties: objectProperties(relatedObject), fieldReads: interestingFieldReads(relatedObject) };
        });
      return { ...child, children: pointerChildren(object), properties: objectProperties(object), fieldReads: interestingFieldReads(object), containers, related };
    });
    return {
      controller: controller ? { pointer: controller.toString(), className: ue.classNameOf(controller), name: ue.nameOf(controller), children: pointerChildren(controller) } : null,
      pawn: pawn ? { pointer: pawn.toString(), className: ue.classNameOf(pawn), name: ue.nameOf(pawn), children: pawnChildren, owned: ownedObjects(pawn), moverObjects, movementProperties: movementProperties(pawn), movementFieldValues: movementFieldValues(pawn) } : null,
    };
  },

  // --- ESP overlay ---
  espSnapshot(w?: number, h?: number) { return esp.snapshot(w, h); },
  espInstall(offlineConfirmed: boolean) { requireOffline(offlineConfirmed, "espInstall"); return esp.install(); },
  espRemove() { return esp.remove(); },
  espTest(on: boolean, offlineConfirmed?: boolean) {
    if (on) requireOffline(offlineConfirmed, "espTest");
    esp.test = !!on;
    return `test=${esp.test}`;
  },
  espStatus() { return esp.status(); },

  // --- movement Instrument ---
  moveRead() { return ue.moverMovement.read(); },
  moveApply(opts: Record<string, number>, offlineConfirmed: boolean) {
    requireOffline(offlineConfirmed, "moveApply");
    return ue.moverMovement.apply(opts);
  },
  moveFly(on: boolean, offlineConfirmed?: boolean) {
    if (on) requireOffline(offlineConfirmed, "moveFly");
    return { ok: false, supported: false, enabled: false, reason: "UE5 Mover flight switching is not live-verified in this build" };
  },
  moveEnforce(on: boolean, offlineConfirmed?: boolean, ms?: number) {
    if (on) requireOffline(offlineConfirmed, "moveEnforce");
    return ue.moverMovement.enforce(!!on, ms);
  },
  moveStatus() { return ue.moverMovement.status(); },
  moveReset() { return ue.moverMovement.reset(); },

  async resetAll() {
    const overlay = await esp.remove();
    const movement = ue.moverMovement.reset();
    return { overlay, movement, clean: movement.clean && !esp.status().installed };
  },
  async dispose() {
    const overlay = await esp.dispose();
    const movement = ue.moverMovement.dispose();
    return { overlay, movement, clean: movement.clean && !esp.status().installed };
  },

  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this game mod", category: "Start here", doc: "Runtime, safety boundary, and unsupported aim path", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modState", label: "Show every active change", category: "Start here", doc: "Owned overlay and movement state", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "info", label: "Read UE runtime facts", category: "Discovery", doc: "UE object array / module facts", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "classes", label: "List package classes", category: "Discovery", args: [{ name: "pkg", type: "string?" }], doc: "Classes in a UE package", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "moveProbe", label: "Inspect the controlled pawn", category: "Discovery", doc: "Bounded controller/pawn UObject graph used to calibrate movement on a live build", capabilities: ["analysis"], effect: "read", returns: "json" },
      { name: "espSnapshot", label: "Preview classified actors", category: "Visual", args: [{ name: "w", type: "integer?" }, { name: "h", type: "integer?" }], doc: "Bounded one-shot ESP data without drawing", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "espInstall", label: "Enable awareness overlay", category: "Visual", args: [{ name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Install the owned ESP render hook in an explicitly confirmed offline scene", capabilities: ["instrument", "debug"], effect: "hook", returns: "scalar", statusAction: "espStatus" },
      { name: "espRemove", label: "Disable awareness overlay", category: "Visual", doc: "Remove the ESP hook and refresh timer", capabilities: ["instrument", "debug"], effect: "control", returns: "scalar", statusAction: "espStatus" },
      { name: "espTest", label: "Toggle overlay test box", category: "Debug", args: [{ name: "on", type: "boolean", ui: { control: "checkbox", label: "Test box" } }, { name: "offlineConfirmed", type: "boolean?", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Draw a test box at screen center; confirmation is required when enabling", capabilities: ["instrument", "debug"], effect: "control", returns: "scalar", statusAction: "espStatus" },
      { name: "espStatus", label: "Read awareness status", category: "Visual", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "moveRead", label: "Read movement values", category: "Movement", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "moveApply", label: "Apply a movement profile", category: "Movement", args: [{ name: "opts", type: "json", ui: { control: "input", label: "Movement values", default: "{\"walk\":900}", placeholder: "{\"walk\":900,\"jump\":700}" } }, { name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "UE5 Mover fields: walk, accel, jump, air, friction, brake; originals are captured before first write", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "moveStatus" },
      { name: "moveEnforce", label: "Keep movement profile active", category: "Movement", args: [{ name: "on", type: "boolean", ui: { control: "checkbox", label: "Continuous enforcement" } }, { name: "offlineConfirmed", type: "boolean?", ui: { control: "checkbox", label: "Owned offline session" } }, { name: "ms", type: "integer?", ui: { control: "slider", label: "Refresh interval (ms)", min: 50, max: 5000, step: 50, default: 250 } }], doc: "Re-resolve components across respawns; confirmation is required when enabling", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "moveStatus" },
      { name: "moveStatus", label: "Read movement Instrument status", category: "Movement", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "moveReset", label: "Restore original movement", category: "Movement", doc: "Restore captured live values, not assumed engine defaults", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "moveStatus" },
      { name: "resetAll", label: "Reset every reversible change", category: "Start here", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose every owned handle", category: "Start here", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      ...recordingDescriptors(),
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

ok(`mecchachameleon agent ready — ${ue.oa().num} objects @ ${ue.gameModule().name}`);
