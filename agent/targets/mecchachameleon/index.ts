// Target entry: MECCHA CHAMELEON (PenguinHotel-Win64-Shipping.exe).
// Build:  flab build mecchachameleon   (frida-compile -> _agent.js)
// Drive:  flab run mecchachameleon     (REPL over rpc.exports)
//
// Everything here is game-specific glue; the heavy lifting lives in ../../lib.

import { ok } from "../../lib/log.js";
import * as ue from "../../lib/ue/index.js";

const esp = new ue.Esp();

// rpc.exports — callable from the host client as `await api.<name>(...)`.
rpc.exports = {
  info() {
    return {
      module: ue.gameModule.name,
      base: ue.gameModule.base.toString(),
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
  espInstall() { return esp.install(); },
  espRemove() { return esp.remove(); },
  espTest(on: boolean) { esp.test = !!on; return `test=${esp.test}`; },
  espStatus() { return esp.status(); },

  // --- movement trainer ---
  moveRead() { return ue.movement.read(); },
  moveApply(opts: Record<string, number>) { return ue.movement.apply(opts); },
  moveFly(on: boolean) { return ue.movement.fly(!!on); },
  moveEnforce(on: boolean, ms?: number) { return ue.movement.enforce(!!on, ms); },
  moveReset() { return ue.movement.reset(); },

  __describe(): unknown {
    return [
      { name: "info", doc: "UE object array / module facts" },
      { name: "classes", args: [{ name: "pkg", type: "string?" }], doc: "Classes in a UE package" },
      { name: "espSnapshot", args: [{ name: "w", type: "number?" }, { name: "h", type: "number?" }], doc: "One-shot ESP data snapshot" },
      { name: "espInstall", doc: "Install ESP overlay" },
      { name: "espRemove", doc: "Remove ESP overlay" },
      { name: "espTest", args: [{ name: "on", type: "boolean" }], doc: "Draw a test box at screen center" },
      { name: "espStatus" },
      { name: "moveRead" },
      { name: "moveApply", args: [{ name: "opts", type: "object" }] },
      { name: "moveFly", args: [{ name: "on", type: "boolean" }] },
      { name: "moveEnforce", args: [{ name: "on", type: "boolean" }, { name: "ms", type: "number?" }] },
      { name: "moveReset" },
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

ok(`mecchachameleon agent ready — ${ue.oa().num} objects @ ${ue.gameModule.name}`);
