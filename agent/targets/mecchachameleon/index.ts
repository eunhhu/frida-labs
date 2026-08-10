// Target entry: MECCHA CHAMELEON (PenguinHotel-Win64-Shipping.exe).
// Build:  flab build mecchachameleon   (frida-compile -> _agent.js)
// Drive:  flab run mecchachameleon     (human controls + live status)
//
// Everything here is game-specific glue; the heavy lifting lives in ../../lib.

import { ok } from "../../lib/log.js";
import * as ue from "../../lib/ue/index.js";
import { analyze, control, defineInstrument, field, hook, read, write } from "../../lib/instrument.js";
import { recordingInstrumentActions } from "../../lib/recording.js";

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

rpc.exports = defineInstrument({
  info: read({
    label: "About this Instrument",
    category: "Start here",
    doc: "Runtime, safety boundary, and unsupported aim path",
  }, () => ({
      game: "MECCHA CHAMELEON",
      runtime: "Unreal Engine 5 Mover",
      safety: "Authorized offline/single-player training only",
      aimAssist: "not shipped: engagement, visibility, and control paths are not live-verified",
      flight: "not exposed: this build uses Mover rather than CharacterMovementComponent",
  })),
  state: read({
    label: "Active changes",
    category: "Start here",
    doc: "Owned overlay and movement state",
  }, () => ({ esp: esp.status(), movement: ue.moverMovement.status() })),
  actions: {
    espInstall: hook({
      label: "Awareness overlay",
      category: "Visual",
      args: [field.offline()],
      doc: "Install the owned ESP render hook in an explicitly confirmed offline scene",
      capabilities: ["instrument", "debug"],
      returns: "scalar",
      status: "espStatus",
    }, (offlineConfirmed: boolean) => { requireOffline(offlineConfirmed, "espInstall"); return esp.install(); }),
    espTest: control({
      label: "Overlay test box",
      category: "Visual",
      args: [field.checkbox("on", { label: "Test box" }), field.offline({ optional: true })],
      doc: "Draw a test box at screen center; confirmation is required when enabling",
      capabilities: ["instrument", "debug"],
      returns: "scalar",
      status: "espStatus",
    }, (on: boolean, offlineConfirmed?: boolean) => {
      if (on) requireOffline(offlineConfirmed, "espTest");
      esp.test = !!on;
      return `test=${esp.test}`;
    }),
    espRemove: control({
      label: "Disable awareness overlay",
      category: "Visual",
      doc: "Remove the ESP hook and refresh timer",
      capabilities: ["instrument", "debug"],
      returns: "scalar",
      status: "espStatus",
    }, () => esp.remove()),
    moveApply: write({
      label: "Movement profile",
      category: "Movement",
      args: [
        field.json("opts", { label: "Movement values", default: "{\"walk\":900}", placeholder: "{\"walk\":900,\"jump\":700}" }),
        field.offline(),
      ],
      doc: "Mover walk, acceleration, jump, air, friction, and brake values; originals are captured before first write",
      status: "moveStatus",
    }, (opts: Record<string, number>, offlineConfirmed: boolean) => {
      requireOffline(offlineConfirmed, "moveApply");
      return ue.moverMovement.apply(opts);
    }),
    moveEnforce: control({
      label: "Continuous movement profile",
      category: "Movement",
      args: [
        field.checkbox("on", { label: "Continuous enforcement" }),
        field.offline({ optional: true }),
        field.slider("ms", { label: "Refresh interval (ms)", optional: true, integer: true, min: 50, max: 5000, step: 50, default: 250 }),
      ],
      doc: "Re-resolve components across respawns; confirmation is required when enabling",
      status: "moveStatus",
    }, (on: boolean, offlineConfirmed?: boolean, ms?: number) => {
      if (on) requireOffline(offlineConfirmed, "moveEnforce");
      return ue.moverMovement.enforce(!!on, ms);
    }),
    moveReset: control({
      label: "Restore original movement",
      category: "Movement",
      doc: "Restore captured live values, not assumed engine defaults",
      status: "moveStatus",
    }, () => ue.moverMovement.reset()),
    espStatus: read({ label: "Awareness status", category: "Visual" }, () => esp.status()),
    moveRead: read({ label: "Movement values", category: "Movement" }, () => ue.moverMovement.read()),
    moveStatus: read({ label: "Movement status", category: "Movement" }, () => ue.moverMovement.status()),
    espSnapshot: read({
      label: "Preview classified actors",
      category: "Visual",
      args: [field.integer("w", { optional: true, label: "Width" }), field.integer("h", { optional: true, label: "Height" })],
      doc: "Bounded one-shot ESP data without drawing",
      returns: "table",
    }, (w?: number, h?: number) => esp.snapshot(w, h)),
    info: read({ label: "UE runtime facts", category: "Discovery", doc: "UE object array and module facts" }, () => ({
      module: ue.gameModule().name,
      base: ue.gameModule().base.toString(),
      objects: ue.oa().num,
      gobjects: ue.oa().objects.toString(),
      gnames: ue.gnames().toString(),
    })),
    classes: read({
      label: "Package classes",
      category: "Discovery",
      args: [field.text("pkg", { optional: true, default: "/Script/PenguinHotel" })],
      returns: "table",
    }, (pkg = "/Script/PenguinHotel") => ue.classesInPackage(pkg)),
    moveProbe: analyze({
      label: "Inspect controlled pawn",
      category: "Discovery",
      doc: "Bounded controller/pawn graph used to calibrate movement on a live build",
    }, () => {
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
    }),
    ...recordingInstrumentActions(),
  },
  reset: control({
    label: "Reset every reversible change",
    category: "Start here",
    status: "modState",
  }, async () => {
    const overlay = await esp.remove();
    const movement = ue.moverMovement.reset();
    return { overlay, movement, clean: movement.clean && !esp.status().installed };
  }),
  dispose: control({
    label: "Dispose every owned handle",
    category: "Start here",
    status: "modState",
  }, async () => {
    const overlay = await esp.dispose();
    const movement = ue.moverMovement.dispose();
    return { overlay, movement, clean: movement.clean && !esp.status().installed };
  }),
});

ok(`mecchachameleon agent ready — ${ue.oa().num} objects @ ${ue.gameModule().name}`);
