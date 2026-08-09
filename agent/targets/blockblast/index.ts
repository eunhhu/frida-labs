// Block Blast! 10.4.9 — authorized offline/single-player Android target.
// The game exposes its Cocos JS runtime through JsCallJava.evalString() and
// persists typed progression values through Cocos2dxLocalStorage. Mutations
// below use those game-owned APIs, capture originals, and fail closed.

import { detectAll } from "../../lib/detect.js";
import { ActivityWindowController } from "../../lib/android-activity.js";
import { FrameMeter } from "../../lib/frame-meter.js";
import { api, perform as javaPerform } from "../../lib/java.js";
import { ok } from "../../lib/log.js";
import { recordingDescriptors, recordingRpcSurface } from "../../lib/recording.js";

const ACTIVITY = "org.cocos2dx.javascript.AppActivity";
const JS_BRIDGE = "org.cocos2dx.javascript.JsCallJava";
const STORAGE = "org.cocos2dx.lib.Cocos2dxLocalStorage";
const BRIDGE_PREFIX = "__flab_mod_result_";

const SCORE_KEYS = {
  current: "block-blast-classScore",
  last: "block-blast-classLastScore",
  best: "block-blast-classHighScore",
  record: "block-blast-classHighRecordScore",
} as const;

const CHAPTER_KEYS = {
  total: "block-blast-ChapterConfig_Proxy_chapterAllNum",
  current: "block-blast-chapterNum",
  last: "block-blast-lastChapterNum",
} as const;

const SURVIVAL_TRAITS = [
  { name: "NoFailBlockTrait", config: { id: 329752001, feature_key: "NoFailBlock", round: 1_000_000, firing: 1 } },
  { name: "UnlimitedReviveBeforeHighScoreTrait", config: { id: 329600001, feature_key: "UnlimitedReviveBeforeHighScore", highScoreLimitNum: 1_000_000, firing: 1 } },
  { name: "InfiniteReviveTrait", config: { id: 331221001, feature_key: "InfiniteRevive", firing: 1 } },
  { name: "TravelReviveUnlimitedTrait", config: { id: 328712001, feature_key: "TravelReviveUnlimited", firing: 1 } },
] as const;

const windowControl = new ActivityWindowController(ACTIVITY);
const frameMeter = new FrameMeter();
const originalStorage = new Map<string, string | null>();
let bridgeSequence = 0;
let survivalOwned = false;

const discoveredTraits = [
  { category: "Player", feature: "No-fail block generation", evidence: "NoFailBlockTrait / id 329752001", status: "live callable" },
  { category: "Player", feature: "Unlimited revive before high score", evidence: "UnlimitedReviveBeforeHighScoreTrait / id 329600001", status: "live callable" },
  { category: "Player", feature: "Infinite classic revive", evidence: "InfiniteReviveTrait / id 331221001", status: "live callable" },
  { category: "Player", feature: "Infinite adventure revive", evidence: "TravelReviveUnlimitedTrait / id 328712001", status: "live callable" },
  { category: "World", feature: "Immediate classic-board clear", evidence: "OverHighScoreClearBoardTrait.clearAllBlocksImmediate", status: "runtime resolved; guarded to a live classic score proxy" },
  { category: "Progression", feature: "Score and best-score storage", evidence: "classScore/classHighScore/classHighRecordScore", status: "live callable; reversible until reset" },
  { category: "Content", feature: "Adventure chapter unlock", evidence: "chapterNum/lastChapterNum", status: "live callable; reversible until reset" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requireOffline(offlineConfirmed: boolean): void {
  if (offlineConfirmed !== true) {
    throw new Error("offlineConfirmed must be true; never use progression mods with rankings, cloud sync, or online events");
  }
}

async function onJava<T>(fn: () => T): Promise<T> {
  const wrapped = await javaPerform(() => ({ value: fn() }));
  if (wrapped === null) throw new Error("Android Java runtime is unavailable");
  return wrapped.value;
}

function rawStorageValue(storage: ReturnType<ReturnType<typeof api>["use"]>, key: string): string | null {
  const value = storage.getItem(key);
  return value === null || value === undefined ? null : String(value);
}

async function storageRead(keys: readonly string[]): Promise<Record<string, string | null>> {
  return onJava(() => {
    const storage = api().use(STORAGE);
    return Object.fromEntries(keys.map((key) => [key, rawStorageValue(storage, key)]));
  });
}

function removeBridgeKeys(storage: ReturnType<ReturnType<typeof api>["use"]>): string[] {
  const removed: string[] = [];
  const iterator = storage.getAllItems().keySet().iterator();
  while (iterator.hasNext()) {
    const key = String(iterator.next());
    if (!key.startsWith(BRIDGE_PREFIX)) continue;
    storage.removeItem(key);
    removed.push(key);
  }
  return removed;
}

async function storageMutate(entries: readonly (readonly [string, string])[]): Promise<unknown> {
  return onJava(() => {
    const storage = api().use(STORAGE);
    const before = entries.map(([key]) => [key, rawStorageValue(storage, key)] as const);
    const applied: typeof before = [];
    try {
      for (let index = 0; index < entries.length; index += 1) {
        const [key, value] = entries[index];
        storage.setItem(key, value);
        applied.push(before[index]);
      }
      for (const [key, expected] of entries) {
        const actual = rawStorageValue(storage, key);
        if (actual !== expected) throw new Error(`storage verification failed for ${key}`);
      }
    } catch (error) {
      for (const [key, value] of applied.reverse()) {
        try {
          if (value === null) storage.removeItem(key);
          else storage.setItem(key, value);
        } catch { /* best-effort transaction rollback */ }
      }
      throw error;
    }
    for (const [key, value] of before) {
      if (!originalStorage.has(key)) originalStorage.set(key, value);
    }
    return {
      before: Object.fromEntries(before),
      after: Object.fromEntries(entries.map(([key]) => [key, rawStorageValue(storage, key)])),
      capturedKeys: Array.from(originalStorage.keys()),
      reversible: true,
      reloadRequired: true,
    };
  });
}

async function restoreStorage(): Promise<{ restored: string[]; errors: string[] }> {
  if (originalStorage.size === 0) return { restored: [], errors: [] };
  const pending = Array.from(originalStorage.entries());
  const result = await onJava(() => {
    const storage = api().use(STORAGE);
    const restored: string[] = [];
    const errors: string[] = [];
    for (const [key, value] of pending) {
      try {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
        restored.push(key);
      } catch (error) {
        errors.push(`${key}: ${errorText(error)}`);
      }
    }
    return { restored, errors };
  });
  for (const key of result.restored) originalStorage.delete(key);
  return result;
}

function decodeStored(raw: string | null): string | number | boolean | null {
  if (raw === null) return null;
  const separator = raw.indexOf("^_^");
  if (separator < 0) return raw;
  const type = raw.slice(0, separator);
  const value = raw.slice(separator + 3);
  if (type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === "boolean") return value === "true";
  return value;
}

function typedNumber(value: number): string {
  return `number^_^${value}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evalGame<T>(body: string): Promise<T> {
  bridgeSequence += 1;
  const resultKey = `${BRIDGE_PREFIX}${Process.id}_${bridgeSequence}`;
  const key = JSON.stringify(resultKey);
  const source = `(function(){try{var result=(function(){${body}})();Promise.resolve(result).then(function(value){cc.sys.localStorage.setItem(${key},JSON.stringify({ok:true,value:value}));},function(error){cc.sys.localStorage.setItem(${key},JSON.stringify({ok:false,error:String(error&&error.stack||error)}));});}catch(error){cc.sys.localStorage.setItem(${key},JSON.stringify({ok:false,error:String(error&&error.stack||error)}));}})();`;

  await onJava(() => {
    const storage = api().use(STORAGE);
    removeBridgeKeys(storage);
    api().use(JS_BRIDGE).evalString(source);
  });

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const raw = (await storageRead([resultKey]))[resultKey];
      if (raw !== null) {
        let parsed: { ok?: boolean; value?: T; error?: string };
        try {
          parsed = JSON.parse(raw) as { ok?: boolean; value?: T; error?: string };
        } catch {
          throw new Error(`game JS returned malformed JSON: ${raw.slice(0, 200)}`);
        }
        if (!parsed.ok) throw new Error(parsed.error ?? "game JS action failed");
        return parsed.value as T;
      }
      await wait(100);
    }
    throw new Error("Cocos JS runtime did not answer within 8 seconds; wait for the game scene and retry");
  } finally {
    try {
      await onJava(() => api().use(STORAGE).removeItem(resultKey));
    } catch { /* the temporary result key is also removed on the next call */ }
  }
}

function traitStatusBody(): string {
  return `var names=${JSON.stringify(SURVIVAL_TRAITS.map(({ name }) => name))};return names.map(function(name){var instance=null;try{instance=TRAIT(name);}catch(error){}return {name:name,exists:!!instance,active:!!(instance&&Trait.traitIsActive(instance)),dynamicActive:!!(instance&&instance._dynamicActive),props:instance&&instance._props||null};});`;
}

async function survivalStatus(): Promise<unknown> {
  const traits = await evalGame<Array<{ name: string; exists: boolean; active: boolean; dynamicActive: boolean; props: unknown }>>(traitStatusBody());
  const activeCount = traits.filter((trait) => trait.active).length;
  return {
    owned: survivalOwned,
    enabled: activeCount === SURVIVAL_TRAITS.length,
    activeCount,
    expectedCount: SURVIVAL_TRAITS.length,
    traits,
  };
}

async function setSurvival(enabled: boolean): Promise<unknown> {
  if (!enabled && !survivalOwned) return survivalStatus();
  if (enabled && survivalOwned) return survivalStatus();
  if (enabled) {
    const names = JSON.stringify(SURVIVAL_TRAITS.map(({ name }) => name));
    const configs = JSON.stringify(SURVIVAL_TRAITS.map(({ config }) => config));
    const body = `var root=window;var names=${names};var configs=${configs};var state=root.__flabSurvivalOriginal;if(!state){state={};names.forEach(function(name){var instance=null;try{instance=TRAIT(name);}catch(error){}state[name]={active:!!(instance&&Trait.traitIsActive(instance)),dynamicActive:!!(instance&&instance._dynamicActive),props:instance&&instance._props||null};});root.__flabSurvivalOriginal=state;}var pending=configs.filter(function(config,index){return !state[names[index]].active;});return Promise.resolve(pending.length?Trait.dynamicEnableTraitsAsync(pending):null).then(function(){${traitStatusBody()}});`;
    survivalOwned = true;
    const traits = await evalGame<Array<{ name: string; active: boolean }>>(body);
    const activeCount = traits.filter((trait) => trait.active).length;
    return {
      owned: true,
      enabled: activeCount === SURVIVAL_TRAITS.length,
      activeCount,
      expectedCount: SURVIVAL_TRAITS.length,
      traits,
      reversible: true,
    };
  }

  const names = JSON.stringify(SURVIVAL_TRAITS.map(({ name }) => name));
  const body = `var root=window;var names=${names};var state=root.__flabSurvivalOriginal||{};var disable=names.filter(function(name){return !state[name]||!state[name].active;});disable.forEach(function(name){Trait.dynamicDisableTraitsByName(name);});return Promise.resolve().then(function(){names.forEach(function(name){var original=state[name];var instance=null;try{instance=TRAIT(name);}catch(error){}if(original&&original.active&&instance){instance._props=original.props;instance._dynamicActive=original.dynamicActive;}});delete root.__flabSurvivalOriginal;${traitStatusBody()}});`;
  const traits = await evalGame<Array<{ name: string; active: boolean }>>(body);
  survivalOwned = false;
  const activeCount = traits.filter((trait) => trait.active).length;
  return { owned: false, enabled: activeCount === SURVIVAL_TRAITS.length, activeCount, traits, restored: true };
}

async function progressState(): Promise<unknown> {
  const keys = [...Object.values(SCORE_KEYS), ...Object.values(CHAPTER_KEYS)];
  const raw = await storageRead(keys);
  const decodedCurrentChapter = decodeStored(raw[CHAPTER_KEYS.current]);
  const decodedLastChapter = decodeStored(raw[CHAPTER_KEYS.last]);
  const currentChapter = typeof decodedCurrentChapter === "number" ? decodedCurrentChapter : Number.NaN;
  const lastChapter = typeof decodedLastChapter === "number" ? decodedLastChapter : Number.NaN;
  return {
    score: {
      current: decodeStored(raw[SCORE_KEYS.current]),
      last: decodeStored(raw[SCORE_KEYS.last]),
      best: decodeStored(raw[SCORE_KEYS.best]),
      record: decodeStored(raw[SCORE_KEYS.record]),
    },
    adventure: {
      currentLevel: Number.isFinite(currentChapter) ? currentChapter + 1 : null,
      unlockedThrough: Number.isFinite(lastChapter) ? lastChapter + 1 : null,
      totalLevels: decodeStored(raw[CHAPTER_KEYS.total]),
    },
    capturedKeys: Array.from(originalStorage.keys()),
    reloadRequiredAfterWrite: true,
  };
}

async function setScore(value: number, offlineConfirmed: boolean): Promise<unknown> {
  requireOffline(offlineConfirmed);
  const score = boundedInteger(value, "score", 0, 999_999_999);
  return storageMutate(Object.values(SCORE_KEYS).map((key) => [key, typedNumber(score)] as const));
}

async function unlockAdventure(level: number, offlineConfirmed: boolean): Promise<unknown> {
  requireOffline(offlineConfirmed);
  const progress = await progressState() as { adventure?: { totalLevels?: unknown } };
  const total = Number(progress.adventure?.totalLevels ?? 96);
  const maximum = Number.isSafeInteger(total) && total > 0 ? total : 96;
  const unlocked = boundedInteger(level, "level", 1, maximum);
  const index = unlocked - 1;
  return storageMutate([
    [CHAPTER_KEYS.current, typedNumber(index)],
    [CHAPTER_KEYS.last, typedNumber(index)],
  ]);
}

async function clearBoard(offlineConfirmed: boolean): Promise<unknown> {
  requireOffline(offlineConfirmed);
  return evalGame(`var trait=null;try{trait=TRAIT("OverHighScoreClearBoardTrait");}catch(error){}if(!trait||typeof trait.clearAllBlocksImmediate!=="function")throw new Error("classic board-clear trait is not loaded");var proxy=null;try{proxy=trait.getClassScoreProxyInstance();}catch(error){}if(!proxy)throw new Error("classic score board is not active; adventure scenes are intentionally rejected");trait.clearAllBlocksImmediate();return {called:true,trait:"OverHighScoreClearBoardTrait",method:"clearAllBlocksImmediate",scene:"classic",oneShot:true,reversible:false};`);
}

async function reloadGame(): Promise<unknown> {
  return onJava(() => {
    api().use(ACTIVITY).reLoadGame();
    return { requested: true, note: "Cocos scene is reloading; wait until the board appears before the next action" };
  });
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
  const engines = detectAll();
  return {
    processId: Process.id,
    arch: Process.arch,
    platform: Process.platform,
    engines: engines.map((engine) => ({ id: engine.id, label: engine.label, module: engine.module.name })),
    gameModule: module ? { name: module.name, base: module.base.toString(), size: module.size } : null,
    gameApi: { js: `${JS_BRIDGE}.evalString`, storage: STORAGE, traitLoader: "Trait.dynamicEnableTraitsAsync" },
    gameplayWritesEnabled: true,
  };
}

async function resetAll(): Promise<unknown> {
  const errors: string[] = [];
  let survival: unknown = { restored: true, wasOwned: survivalOwned };
  if (survivalOwned) {
    try { survival = await setSurvival(false); } catch (error) { errors.push(`survival: ${errorText(error)}`); }
  }
  let bridge: unknown = { removed: [] };
  try {
    bridge = { removed: await onJava(() => removeBridgeKeys(api().use(STORAGE))) };
  } catch (error) {
    bridge = { error: errorText(error) };
    errors.push(`bridge: ${errorText(error)}`);
  }
  let progression: unknown = { restored: [], errors: [] };
  try {
    progression = await restoreStorage();
    errors.push(...(progression as { errors: string[] }).errors.map((error) => `progression: ${error}`));
  } catch (error) {
    errors.push(`progression: ${errorText(error)}`);
  }
  const performance = frameMeter.reset();
  let activity: unknown;
  try { activity = await windowControl.reset(); } catch (error) {
    activity = { error: errorText(error) };
    errors.push(`activity: ${errorText(error)}`);
  }
  return {
    survival,
    bridge,
    progression,
    performance,
    activity,
    reloadRequired: (progression as { restored?: string[] }).restored?.length !== 0,
    clean: errors.length === 0 && originalStorage.size === 0 && !survivalOwned,
    errors,
  };
}

const surface = {
  ...recordingRpcSurface(),
  modInfo(): unknown {
    return {
      game: "Block Blast!",
      package: "com.block.juggle",
      testedVersion: "10.4.9",
      device: "R3CWB0GCWMX",
      runtime: "Cocos2d-x / game JS traits / typed local storage",
      safety: "Authorized offline single-player only. No rankings, cloud state, purchases, ads, or remote values.",
      cleanup: "Score/chapter and survival mode are resettable. Clear-board is an explicit one-shot board action.",
    };
  },
  async modState(): Promise<unknown> {
    let survival: unknown;
    try { survival = await survivalStatus(); } catch (error) { survival = { available: false, error: errorText(error) }; }
    return {
      progress: await progressState(),
      survival,
      activity: await activityState(),
      performance: frameMeter.status(),
      clean: originalStorage.size === 0 && !survivalOwned && !frameMeter.status().running,
    };
  },
  progressRead: progressState,
  scoreSet: setScore,
  adventureUnlockThrough: unlockAdventure,
  survivalSetEnabled: setSurvival,
  survivalStatus,
  classicBoardClearNow: clearBoard,
  gameReload: reloadGame,
  runtimeRead,
  featureCatalog(): unknown { return discoveredTraits; },
  async qolKeepAwake(enabled: boolean): Promise<unknown> { return windowControl.setKeepScreenOn(enabled); },
  performanceStart(): unknown { return frameMeter.start(); },
  performanceStatus(): unknown { return frameMeter.status(); },
  performanceStop(): unknown { return frameMeter.stop(); },
  resetAll,
  async dispose(): Promise<unknown> { return resetAll(); },
  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this game mod", category: "Start here", doc: "Tested build, runtime APIs, safety boundary, and reset coverage", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modState", label: "Show every active change", category: "Start here", doc: "Score, chapters, survival traits, window, FPS meter, and reset ownership", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "progressRead", label: "Read score and unlocked levels", category: "Progress", doc: "Read live typed save values without changing them", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "scoreSet", label: "Set current and best score", category: "Progress", args: [{ name: "score", type: "integer", ui: { control: "input", label: "Score", placeholder: "0..999999999" } }, { name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Set 0..999,999,999 through the game's four local score keys; resetAll restores every original; reload required", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "progressRead" },
      { name: "adventureUnlockThrough", label: "Unlock adventure through level", category: "Content", args: [{ name: "level", type: "integer", ui: { control: "slider", label: "Adventure level", min: 1, max: 96, step: 1, default: 1 } }, { name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Unlock levels 1..96 through the game's chapter save API; resetAll restores the original; reload required", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "progressRead" },
      { name: "survivalSetEnabled", label: "Toggle no-fail + unlimited revives", category: "Gameplay", args: [{ name: "enabled", type: "boolean", ui: { control: "checkbox", label: "No-fail + unlimited revives" } }], doc: "Dynamically activate four shipped classic/adventure survival traits; resetAll removes only traits owned by this session", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "survivalStatus" },
      { name: "survivalStatus", label: "Check survival traits", category: "Gameplay", doc: "Verify each shipped trait exists and is active in the live Cocos runtime", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "classicBoardClearNow", label: "Clear a classic board now", category: "Gameplay", args: [{ name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Require a live classic score proxy, then call clearAllBlocksImmediate; adventure is rejected before mutation; one-shot and not undone by resetAll", capabilities: ["instrument"], effect: "write", returns: "json" },
      { name: "gameReload", label: "Reload game to apply save changes", category: "Progress", doc: "Call AppActivity.reLoadGame after score/chapter writes or restoration", capabilities: ["instrument"], effect: "control", returns: "json" },
      { name: "runtimeRead", label: "Show hooked game APIs", category: "Discovery", doc: "Live Cocos module, exact Java bridges, engine, process, and architecture", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "featureCatalog", label: "Show mapped game systems", category: "Discovery", doc: "Runtime function/trait/storage evidence and callable status", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "qolKeepAwake", label: "Keep screen awake", category: "QoL", args: [{ name: "enabled", type: "boolean", ui: { control: "checkbox", label: "Keep screen awake" } }], doc: "Toggle the Activity flag; resetAll restores its original value", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "performanceStart", label: "Start FPS meter", category: "QoL", doc: "Observe EGL frames without changing gameplay", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "performanceStatus" },
      { name: "performanceStatus", label: "Check FPS meter", category: "QoL", doc: "Frame count, elapsed time, measured FPS, and callback evidence", capabilities: ["instrument", "analysis"], effect: "read", returns: "verification" },
      { name: "performanceStop", label: "Stop FPS meter", category: "QoL", doc: "Detach the owned EGL listener", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "performanceStatus" },
      { name: "resetAll", label: "Reset every reversible change", category: "Start here", doc: "Restore score/chapter values, survival traits, Activity flags, and listeners", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose safely", category: "Debug", doc: "Cleanup alias used before reload or detach", capabilities: ["instrument", "debug"], effect: "control", returns: "json" },
      ...recordingDescriptors(),
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

rpc.exports = surface;
ok("[blockblast] real game APIs ready: score, chapters, survival traits, board clear");
