// Target entry: MECCHA CHAMELEON (PenguinHotel-Win64-Shipping.exe).
// Build:  flab build mecchachameleon   (frida-compile -> _agent.js)
// Drive:  flab run mecchachameleon     (REPL over rpc.exports)
//
// Everything here is game-specific glue; the heavy lifting lives in ../../lib.

import { ok } from "../../lib/log.js";
import * as ue from "../../lib/ue/index.js";

const ACTOR_CLASSES = /Hunter|Survivor|BigPen|AI_Base/;
const PLAYER_CONTROLLER_CLASS = "BP_PlayerController_cLeon_C";
type Role = "HUNTER" | "SURVIVOR";
const roleOf = (className: string): Role => /Hunter|BigPen/.test(className) ? "HUNTER" : "SURVIVOR";
const COLORS: Record<Role, readonly [number, number, number, number]> = {
  HUNTER: [1, 0.1, 0.1, 1],
  SURVIVOR: [0.1, 1, 0.1, 1],
};

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
  modInfo() {
    return {
      game: "MECCHA CHAMELEON",
      runtime: "Unreal Engine",
      safety: "Authorized offline/single-player training only",
      aimAssist: "not shipped: engagement, visibility, and control paths are not live-verified",
    };
  },
  modHelp() {
    return [
      "1. espSnapshot() to inspect classified actors",
      "2. espInstall() / espRemove() for the owned overlay",
      "3. moveRead(), moveApply({...}), moveEnforce(true), moveReset()",
      "4. resetAll() before detach or reload",
    ];
  },
  modState() { return { esp: esp.status(), movement: ue.movement.status() }; },
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

  // --- movement trainer ---
  moveRead() { return ue.movement.read(); },
  moveApply(opts: Record<string, number>, offlineConfirmed: boolean) {
    requireOffline(offlineConfirmed, "moveApply");
    return ue.movement.apply(opts);
  },
  moveFly(on: boolean, offlineConfirmed?: boolean) {
    if (on) requireOffline(offlineConfirmed, "moveFly");
    return ue.movement.fly(!!on);
  },
  moveEnforce(on: boolean, offlineConfirmed?: boolean, ms?: number) {
    if (on) requireOffline(offlineConfirmed, "moveEnforce");
    return ue.movement.enforce(!!on, ms);
  },
  moveStatus() { return ue.movement.status(); },
  moveReset() { return ue.movement.reset(); },

  async resetAll() {
    const overlay = await esp.remove();
    const movement = ue.movement.reset();
    return { overlay, movement, clean: movement.clean && !esp.status().installed };
  },
  async dispose() {
    const overlay = await esp.dispose();
    const movement = ue.movement.dispose();
    return { overlay, movement, clean: movement.clean && !esp.status().installed };
  },

  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this game mod", category: "Start here", doc: "Runtime, safety boundary, and unsupported aim path", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modHelp", label: "Show the quick guide", category: "Start here", doc: "ESP, movement, and cleanup flow", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "modState", label: "Show every active change", category: "Start here", doc: "Owned overlay and movement state", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "info", label: "Read UE runtime facts", category: "Discovery", doc: "UE object array / module facts", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "classes", label: "List package classes", category: "Discovery", args: [{ name: "pkg", type: "string?" }], doc: "Classes in a UE package", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "espSnapshot", label: "Preview classified actors", category: "Visual", args: [{ name: "w", type: "integer?" }, { name: "h", type: "integer?" }], doc: "Bounded one-shot ESP data without drawing", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "espInstall", label: "Enable awareness overlay", category: "Visual", args: [{ name: "offlineConfirmed", type: "boolean" }], doc: "Install the owned ESP render hook in an explicitly confirmed offline scene", capabilities: ["instrument", "debug"], effect: "hook", returns: "scalar", statusAction: "espStatus" },
      { name: "espRemove", label: "Disable awareness overlay", category: "Visual", doc: "Remove the ESP hook and refresh timer", capabilities: ["instrument", "debug"], effect: "control", returns: "scalar", statusAction: "espStatus" },
      { name: "espTest", label: "Toggle overlay test box", category: "Debug", args: [{ name: "on", type: "boolean" }, { name: "offlineConfirmed", type: "boolean?" }], doc: "Draw a test box at screen center; confirmation is required when enabling", capabilities: ["instrument", "debug"], effect: "control", returns: "scalar", statusAction: "espStatus" },
      { name: "espStatus", label: "Read awareness status", category: "Visual", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "moveRead", label: "Read movement values", category: "Movement", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "moveApply", label: "Apply a movement profile", category: "Movement", args: [{ name: "opts", type: "json" }, { name: "offlineConfirmed", type: "boolean" }], doc: "Bounded values; originals are captured before first write", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "moveStatus" },
      { name: "moveFly", label: "Toggle flying movement", category: "Movement", args: [{ name: "on", type: "boolean" }, { name: "offlineConfirmed", type: "boolean?" }], doc: "Capture and restore the live MovementMode; confirmation is required when enabling", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "moveStatus" },
      { name: "moveEnforce", label: "Keep movement profile active", category: "Movement", args: [{ name: "on", type: "boolean" }, { name: "offlineConfirmed", type: "boolean?" }, { name: "ms", type: "integer?" }], doc: "Re-resolve components across respawns; confirmation is required when enabling", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "moveStatus" },
      { name: "moveStatus", label: "Read movement trainer status", category: "Movement", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "moveReset", label: "Restore original movement", category: "Movement", doc: "Restore captured live values, not assumed engine defaults", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "moveStatus" },
      { name: "resetAll", label: "Reset every reversible change", category: "Start here", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose every owned handle", category: "Start here", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

ok(`mecchachameleon agent ready — ${ue.oa().num} objects @ ${ue.gameModule().name}`);
