// Target entry: PIU (Unity / IL2CPP rhythm game) — judgment correction.
// Build:  flab build piu   ·   Run:  flab run piu
//
// Demonstrates the IL2CPP side of the lib. Rebalances hit judgments toward
// PERFECT with a weighted table.

// The bridge itself is loaded by ../../lib/il2cpp.js (single import site, so
// targets never touch node_modules directly — enforced by depcheck).
import { ok } from "../../lib/log.js";
import * as il2cpp from "../../lib/il2cpp.js";
import { recordingDescriptors, recordingRpcSurface } from "../../lib/recording.js";

let enabled = false;
let installed = false;
let judgeUnit: Il2Cpp.Method | null = null;
let lastError: string | null = null;
let calls = 0;
let corrected = 0;
let unchanged = 0;
let lastOriginal: number | null = null;
let lastCorrected: number | null = null;
let lastAt: string | null = null;
const originalDistribution: Record<string, number> = {};
const correctedDistribution: Record<string, number> = {};

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

function requireOffline(confirmed: boolean | undefined): void {
  if (confirmed !== true) throw new Error("enabling judgment correction requires offlineConfirmed=true");
}

function resetStats(): void {
  calls = 0;
  corrected = 0;
  unchanged = 0;
  lastOriginal = null;
  lastCorrected = null;
  lastAt = null;
  for (const key of Object.keys(originalDistribution)) delete originalDistribution[key];
  for (const key of Object.keys(correctedDistribution)) delete correctedDistribution[key];
}

function stats(): Record<string, unknown> {
  return {
    calls,
    corrected,
    unchanged,
    lastOriginal,
    lastCorrected,
    lastAt,
    originalDistribution: { ...originalDistribution },
    correctedDistribution: { ...correctedDistribution },
  };
}

async function setEnabled(on: boolean, offlineConfirmed?: boolean): Promise<Record<string, unknown>> {
  if (on) requireOffline(offlineConfirmed);
  if (on && !enabled) resetStats();
  enabled = !!on;
  if (!enabled && !installed) {
    lastError = null;
    return { ok: true, enabled, installed, clean: true };
  }
  try {
    await il2cpp.perform(() => {
      if (!judgeUnit) {
        judgeUnit = il2cpp.methods("^JudgeUnit$")[0] ?? null;
        if (!judgeUnit) throw new Error("JudgeUnit method not found");
      }
      const method = judgeUnit;
      if (enabled && !installed) {
        method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: unknown[]) {
          const oj = +(args[1] as number) === -1 ? 4 : +(args[1] as number);
          const judgment = roll(oj);
          calls++;
          if (judgment === oj) unchanged++; else corrected++;
          lastOriginal = oj;
          lastCorrected = judgment;
          lastAt = new Date().toISOString();
          originalDistribution[String(oj)] = (originalDistribution[String(oj)] ?? 0) + 1;
          correctedDistribution[String(judgment)] = (correctedDistribution[String(judgment)] ?? 0) + 1;
          const finalArgs = [0, judgment === 4 ? -1 : judgment, true, false, 1, 0, 0, true];
          return this.method(method.name).invoke(...(finalArgs as Il2Cpp.Parameter.Type[]));
        };
        installed = true;
        ok("PIU judgment correction installed");
      } else if (!enabled && installed) {
        method.implementation = null as never;
        installed = false;
        ok("PIU judgment correction removed");
      }
    });
    lastError = null;
  } catch (error) {
    enabled = false;
    lastError = (error as Error).message;
    throw error;
  }
  return { ok: true, enabled, installed, clean: !installed };
}

function state(): Record<string, unknown> {
  return {
    enabled,
    installed,
    method: judgeUnit ? `${judgeUnit.class.fullName}::${judgeUnit.name}` : null,
    lastError,
    stats: stats(),
    clean: !enabled && !installed,
  };
}

rpc.exports = {
  ...recordingRpcSurface(),
  modInfo() {
    return {
      game: "PUMP IT UP RISE",
      runtime: "Unity IL2CPP",
      safety: "Owned offline play only; correction starts disabled and requires explicit confirmation",
      feature: "bounded probabilistic local judgment correction",
    };
  },
  modHelp() {
    return [
      "1. modState() confirms correction is disabled by default",
      "2. toggle(true, true) only in an owned offline play session",
      "3. toggle(false) or resetAll() removes the IL2CPP implementation",
    ];
  },
  modState() { return state(); },
  judgmentStats() { return stats(); },
  async toggle(on: boolean, offlineConfirmed?: boolean) { return setEnabled(!!on, offlineConfirmed); },
  async resetAll() { return setEnabled(false); },
  async dispose() { return setEnabled(false); },
  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this Instrument", category: "Start here", doc: "Runtime, feature, and offline safety boundary", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modHelp", label: "Show the quick guide", category: "Start here", doc: "Explicit enable, disable, and cleanup flow", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "modState", label: "Show correction status", category: "Start here", doc: "Hook ownership, method identity, and clean state", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "judgmentStats", label: "Read judgment activity", category: "Training", doc: "Bounded call counts, original/corrected distributions, and latest invocation", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "toggle", label: "Toggle judgment correction", category: "Training", args: [{ name: "on", type: "boolean" }, { name: "offlineConfirmed", type: "boolean?" }], doc: "Enabling requires offlineConfirmed=true; disabling removes the implementation", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "resetAll", label: "Disable and restore", category: "Start here", doc: "Remove the owned IL2CPP implementation", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose owned handles", category: "Start here", doc: "Automatic detach cleanup", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      ...recordingDescriptors(),
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

ok("PIU Instrument ready (judgment correction disabled)");
