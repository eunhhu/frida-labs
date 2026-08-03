// Target entry: MECCHA CHAMELEON (PenguinHotel-Win64-Shipping.exe).
// Build:  flab build mecchachameleon   (frida-compile -> _agent.js)
// Drive:  flab run mecchachameleon     (REPL over rpc.exports)
//
// Everything here is game-specific glue; the heavy lifting lives in ../../lib.

import { ok, ue } from "../../lib/index.js";

const esp = new ue.Esp();

// rpc.exports — callable from the host client as `await api.<name>(...)`.
rpc.exports = {
  info() {
    return {
      module: ue.gameModule.name,
      base: ue.gameModule.base.toString(),
      objects: ue.OA.num,
      gobjects: ue.OA.objects.toString(),
      gnames: ue.GNAMES.toString(),
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
};

ok(`mecchachameleon agent ready — ${ue.OA.num} objects @ ${ue.gameModule.name}`);
