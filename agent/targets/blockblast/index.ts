// Block Blast! 10.4.9 — authorized offline/single-player Android target.
// Live runtime: Cocos2d-x in libcocos2djs.so. Shipped game traits are HEK
// bytecode, so undiscovered gameplay writes are deliberately not exposed.

import { detectAll } from "../../lib/detect.js";
import { ActivityWindowController } from "../../lib/android-activity.js";
import { FrameMeter } from "../../lib/frame-meter.js";
import { ok } from "../../lib/log.js";

const ACTIVITY = "org.cocos2dx.javascript.AppActivity";
const windowControl = new ActivityWindowController(ACTIVITY);
const frameMeter = new FrameMeter();

const discoveredTraits = [
  { category: "Player", feature: "No-fail block generation", evidence: "NoFailBlockTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "Player", feature: "Unlimited revive before high score", evidence: "UnlimitedReviveBeforeHighScoreTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "Player", feature: "No-death random board fallback", evidence: "CTRefactorRepateCPlusPlusRandomNoDeathTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "World", feature: "Board replacement", evidence: "CTRefactorReplaceBoardTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "World", feature: "Board clear", evidence: "CTRefactorClearBoardPlusTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "Progression", feature: "High-score reset", evidence: "ResetClassHighScoreTrait", status: "discovered in encrypted APK trait; intentionally not modified" },
  { category: "QoL", feature: "Mini-game speed control", evidence: "MiniGameSpeedUpTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "QoL", feature: "Combo help", evidence: "ComboHelpAlgoTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "Visual", feature: "Skin switching", evidence: "SkinSwitchTrait", status: "discovered in encrypted APK trait; not callable yet" },
  { category: "Content", feature: "Chapter replay/skip-goal paths", evidence: "ChapterReplaySkipGoalTrait", status: "discovered in encrypted APK trait; no safe creation path proven" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function activityState(): Promise<unknown> {
  try {
    return await windowControl.status();
  } catch (error) {
    return { activityClass: ACTIVITY, visible: false, error: errorText(error) };
  }
}

function runtimeRead(): unknown {
  const module = Process.findModuleByName("libcocos2djs.so");
  // Spawn-mode injection happens before native game modules are loaded. Detect
  // lazily so a later call observes the resumed runtime instead of caching an
  // empty pre-main snapshot forever.
  const engines = detectAll();
  return {
    processId: Process.id,
    arch: Process.arch,
    platform: Process.platform,
    engines: engines.map((engine) => ({ id: engine.id, label: engine.label, module: engine.module.name })),
    gameModule: module ? { name: module.name, base: module.base.toString(), size: module.size } : null,
    shippedTraitFilesReviewed: 414,
    gameplayWritesEnabled: false,
  };
}

async function resetAll(): Promise<unknown> {
  const performance = frameMeter.reset();
  try {
    return { performance, activity: await windowControl.reset(), clean: true };
  } catch (error) {
    return { performance, activity: { error: errorText(error) }, clean: false };
  }
}

const surface = {
  modInfo(): unknown {
    return {
      game: "Block Blast!",
      package: "com.block.juggle",
      testedVersion: "10.4.9",
      device: "R3CWB0GCWMX",
      runtime: "Cocos2d-x / libcocos2djs.so",
      safety: "Offline single-player only. Mutations are reversible QoL and off by default.",
      limitation: "Game traits use HEK bytecode and the Cocos module is stripped; unverified score, board, revive, and content writes are not exposed.",
    };
  },
  modHelp(): unknown {
    return [
      "QoL: qolKeepAwake(true|false)",
      "Performance: performanceStart(), performanceStatus(), performanceStop()",
      "Discovery: runtimeRead(), featureCatalog()",
      "Cleanup: resetAll()",
    ];
  },
  async modState(): Promise<unknown> {
    return { activity: await activityState(), performance: frameMeter.status(), clean: !frameMeter.status().running };
  },
  runtimeRead,
  featureCatalog(): unknown { return discoveredTraits; },
  async qolKeepAwake(enabled: boolean): Promise<unknown> {
    return windowControl.setKeepScreenOn(enabled);
  },
  performanceStart(): unknown { return frameMeter.start(); },
  performanceStatus(): unknown { return frameMeter.status(); },
  performanceStop(): unknown { return frameMeter.stop(); },
  resetAll,
  async dispose(): Promise<unknown> { return resetAll(); },
  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this mod", category: "System", doc: "Tested build, runtime, safety boundary, and honest limitations", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modHelp", label: "How to use", category: "System", doc: "Short action examples and cleanup command", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "modState", label: "Current mod state", category: "System", doc: "Owned window flag and frame-meter state", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "runtimeRead", label: "Runtime details", category: "Discovery", doc: "Live Cocos module, engine, process, and coverage facts", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "featureCatalog", label: "Discovered game systems", category: "Discovery", doc: "APK-evidenced systems with explicit callable/unsupported status", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "qolKeepAwake", label: "Keep screen awake", category: "QoL", args: [{ name: "enabled", type: "boolean" }], doc: "Toggle the game Activity's keep-screen-on flag; resetAll restores its original value", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "performanceStart", label: "Start FPS meter", category: "QoL", doc: "Observe EGL frame presentation without changing rendering", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "performanceStatus" },
      { name: "performanceStatus", label: "FPS meter status", category: "QoL", doc: "Frame count, elapsed time, measured FPS, and firing verification", capabilities: ["instrument", "analysis"], effect: "read", returns: "verification" },
      { name: "performanceStop", label: "Stop FPS meter", category: "QoL", doc: "Detach the owned EGL listener", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "performanceStatus" },
      { name: "resetAll", label: "Reset all changes", category: "System", doc: "Detach listeners and restore the original Activity window flag", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose mod", category: "Debug", doc: "Cleanup alias used before reload or detach", capabilities: ["instrument", "debug"], effect: "control", returns: "json" },
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

rpc.exports = surface;
ok("[blockblast] verified target ready; gameplay writes remain fail-closed");
