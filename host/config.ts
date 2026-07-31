// Single source of truth for every target: process to hook, attach/spawn mode,
// and the agent entry to compile. `client.ts` reads this — nothing else needed.

export interface TargetConfig {
  /** Process name (attach) or executable path (spawn). */
  process: string;
  mode: "attach" | "spawn";
  /** Agent TypeScript entry, compiled to the bundle at runtime. */
  entry: string;
}

export const targets = {
  mecchachameleon: {
    process: "PenguinHotel-Win64-Shipping.exe",
    mode: "attach",
    entry: "agent/targets/mecchachameleon/index.ts",
  },
  piu: {
    // set to the real Unity player process name
    process: "PUMP IT UP RISE.exe",
    mode: "attach",
    entry: "agent/targets/piu/index.ts",
  },
  adofai: {
    process: "A Dance of Fire and Ice.exe",
    mode: "attach",
    entry: "agent/targets/adofai/index.ts",
  },
} satisfies Record<string, TargetConfig>;

export type TargetName = keyof typeof targets;
export const DEFAULT_TARGET: TargetName = "mecchachameleon";
export const AGENT_OUT = "_agent.js";
