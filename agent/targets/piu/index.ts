// Target entry: PIU (Unity / IL2CPP rhythm game) — judgment correction.
// Build:  flab build piu   ·   Run:  flab run piu
//
// Demonstrates the IL2CPP side of the lib. Rebalances hit judgments toward
// PERFECT with a weighted table.

// The bridge itself is loaded by ../../lib/il2cpp.js (single import site, so
// targets never touch node_modules directly — enforced by depcheck).
import { ok } from "../../lib/log.js";
import * as il2cpp from "../../lib/il2cpp.js";

let enabled = true;

// original judgment (oj) -> { corrected judgment: probability }
// -1 MISS(→4), 0 PERFECT, 1 GREAT, 2 GOOD, 3 BAD
const table: Record<number, Record<number, number>> = {
  0: { 0: 1.0 },
  1: { 0: 0.99, 1: 0.01 },
  2: { 0: 0.95, 1: 0.04, 2: 0.01 },
  3: { 0: 0.8, 1: 0.15, 2: 0.03, 3: 0.02 },
  4: { 0: 1.0 },
};

function roll(oj: number): number {
  const weights = table[oj];
  if (!weights) return oj;
  const r = Math.random();
  let sum = 0;
  for (const [k, w] of Object.entries(weights)) { sum += w; if (r < sum) return Number(k); }
  return oj;
}

Il2Cpp.perform(() => {
  ok("IL2CPP bridge loaded");
  const judgeUnit = il2cpp.methods("^JudgeUnit$")[0];
  judgeUnit.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: unknown[]) {
    const oj = +(args[1] as number) === -1 ? 4 : +(args[1] as number);
    const jud = enabled ? roll(oj) : oj;
    const finalArgs = enabled
      ? [0, jud === 4 ? -1 : jud, true, false, 1, 0, 0, true]
      : args;
    return this.method(judgeUnit.name).invoke(...(finalArgs as Il2Cpp.Parameter.Type[]));
  };
});

rpc.exports = {
  toggle(on: boolean) { enabled = !!on; return `enabled=${enabled}`; },
  __describe(): unknown {
    return [
      { name: "toggle", args: [{ name: "on", type: "boolean" }], doc: "Enable/disable judgment correction" },
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};
