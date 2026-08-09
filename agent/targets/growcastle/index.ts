// GrowCastle 1.50.14 — authorized single-player Android target.
// Online rankings, purchases, ads, and remote state are explicitly excluded.

import { perform } from "../../lib/il2cpp.js";
import { ActivityWindowController } from "../../lib/android-activity.js";
import { FrameMeter } from "../../lib/frame-meter.js";
import { ok } from "../../lib/log.js";
import { recordingDescriptors, recordingRpcSurface } from "../../lib/recording.js";

const ACTIVITY = "com.raongames.player.MainActivity";
const windowControl = new ActivityWindowController(ACTIVITY);
const frameMeter = new FrameMeter();
let originalTimeScale: number | null = null;
let originalTargetFrameRate: number | null = null;
let timeScaleLock: number | null = null;
let timeScaleListener: InvocationListener | null = null;
let timeScaleAddress: string | null = null;
let timeScaleInterceptedWrites = 0;
let targetFrameRateLock: number | null = null;
let targetFrameRateListener: InvocationListener | null = null;
let targetFrameRateAddress: string | null = null;
let targetFrameRateInterceptedWrites = 0;
let originalGold: string | null = null;
let originalPlayerLevel: number | null = null;
let originalSkillPoints: number | null = null;
let originalPause: boolean | null = null;
let cooldownEnabled = false;
let cooldownFires = 0;
let lastCooldownFires = 0;
let cooldownMethods: Il2Cpp.Method[] = [];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedQuery(value: string): string {
  const query = String(value ?? "").trim();
  if (query.length < 1 || query.length > 64) throw new Error("query must be 1-64 characters");
  return query.toLowerCase();
}

function scriptsAssembly(): Il2Cpp.Assembly {
  for (const name of ["Scripts", "Scripts.dll", "Assembly-CSharp"]) {
    const assembly = Il2Cpp.domain.tryAssembly(name);
    if (assembly) return assembly;
  }
  throw new Error("GrowCastle scripts assembly is not loaded");
}

function scriptsClass(fullName: string): Il2Cpp.Class {
  const klass = scriptsAssembly().image.classes.find((candidate) => candidate.fullName === fullName);
  if (!klass) throw new Error(`class not found: ${fullName}`);
  return klass;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function cooldownState(): unknown {
  const fired = cooldownEnabled ? cooldownFires : lastCooldownFires;
  return {
    enabled: cooldownEnabled,
    fired,
    verified: fired > 0,
    state: fired > 0 ? "verified" : "unverified",
    hooks: cooldownMethods.map((method) => `${method.class.fullName}::${method.name}`),
  };
}

function stopCooldownHooks(): string[] {
  const errors: string[] = [];
  lastCooldownFires = cooldownFires;
  for (const method of cooldownMethods) {
    try { Interceptor.revert(method.virtualAddress); } catch (error) {
      errors.push(`${method.class.fullName}::${method.name}: ${errorText(error)}`);
    }
  }
  try { Interceptor.flush(); } catch (error) { errors.push(`flush: ${errorText(error)}`); }
  cooldownMethods = [];
  cooldownEnabled = false;
  cooldownFires = 0;
  return errors;
}

function targetFpsLockState(): unknown {
  return {
    active: targetFrameRateListener !== null,
    target: targetFrameRateLock,
    address: targetFrameRateAddress,
    interceptedWrites: targetFrameRateInterceptedWrites,
  };
}

function timeScaleLockState(): unknown {
  return {
    active: timeScaleListener !== null,
    target: timeScaleLock,
    address: timeScaleAddress,
    interceptedWrites: timeScaleInterceptedWrites,
  };
}

function stopTimeScaleLock(): void {
  try { timeScaleListener?.detach(); } catch { /* already detached */ }
  timeScaleListener = null;
  timeScaleLock = null;
  timeScaleAddress = null;
  timeScaleInterceptedWrites = 0;
}

function stopTargetFpsLock(): void {
  try { targetFrameRateListener?.detach(); } catch { /* already detached */ }
  targetFrameRateListener = null;
  targetFrameRateLock = null;
  targetFrameRateAddress = null;
  targetFrameRateInterceptedWrites = 0;
}

function methodRow(method: Il2Cpp.Method): unknown {
  return {
    class: method.class.fullName,
    name: method.name,
    parameters: method.parameters.map((parameter) => ({ name: parameter.name, type: parameter.type.name })),
    returnType: method.returnType.name,
    static: method.isStatic,
    address: method.virtualAddress.toString(),
  };
}

function classRows(query: string, cap = 200): unknown[] {
  const needle = boundedQuery(query);
  return scriptsAssembly().image.classes
    .filter((klass) => klass.fullName.toLowerCase().includes(needle))
    .slice(0, cap)
    .map((klass) => ({
      name: klass.fullName,
      fields: klass.fields.length,
      methods: klass.methods.length,
      parent: klass.parent?.fullName ?? null,
    }));
}

async function unityState(): Promise<unknown> {
  return perform(() => {
    const core = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
    const time = core.class("UnityEngine.Time");
    const application = core.class("UnityEngine.Application");
    return {
      timeScale: Number(time.method<number>("get_timeScale", 0).invoke()),
      targetFrameRate: Number(application.method<number>("get_targetFrameRate", 0).invoke()),
      originalTimeScale,
      originalTargetFrameRate,
      timeScaleLock: timeScaleLockState(),
      targetFpsLock: targetFpsLockState(),
    };
  });
}

async function activityState(): Promise<unknown> {
  try {
    return await windowControl.status();
  } catch (error) {
    return { activityClass: ACTIVITY, visible: false, error: errorText(error) };
  }
}

async function progressState(): Promise<unknown> {
  return perform(() => {
    const inventory = scriptsClass("Inventory");
    const player = scriptsClass("Player");
    const gameMap = scriptsClass("GameMap");
    const gameManager = scriptsClass("GameManager");
    return {
      gold: inventory.method<Int64>("get_Gold", 0).invoke().toString(),
      playerLevel: Number(player.method<number>("get_Level", 0).invoke()),
      skillPoints: Number(player.method<number>("get_SkillPoint", 0).invoke()),
      playerWave: Number(player.method<number>("get_Wave", 0).invoke()),
      battle: {
        active: Boolean(gameMap.field<boolean>("IsBattle").value),
        waveMode: Boolean(gameMap.method<boolean>("get_IsWaveMode", 0).invoke()),
        currentWave: gameMap.method<Int64>("get_CurrentWave", 0).invoke().toString(),
        queuedSkip: Number(gameMap.method<number>("get_SkippingWave", 0).invoke()),
      },
      paused: Boolean(gameManager.method<boolean>("get_Pause", 0).invoke()),
      captured: {
        gold: originalGold,
        playerLevel: originalPlayerLevel,
        skillPoints: originalSkillPoints,
        pause: originalPause,
      },
      noCooldown: cooldownState(),
    };
  });
}

async function setGold(value: number): Promise<unknown> {
  const amount = boundedInteger(value, "gold", 0, 1_000_000_000_000);
  return perform(() => {
    const inventory = scriptsClass("Inventory");
    const getter = inventory.method<Int64>("get_Gold", 0);
    const setter = inventory.method<void>("set_Gold", 1);
    const before = getter.invoke().toString();
    if (originalGold === null) originalGold = before;
    setter.invoke(int64(amount));
    return { before, gold: getter.invoke().toString(), original: originalGold, reversible: true };
  });
}

async function setPlayerLevel(value: number): Promise<unknown> {
  const level = boundedInteger(value, "level", 1, 10_000);
  return perform(() => {
    const player = scriptsClass("Player");
    const getter = player.method<number>("get_Level", 0);
    const setter = player.method<void>("set_Level", 1);
    const before = Number(getter.invoke());
    if (originalPlayerLevel === null) originalPlayerLevel = before;
    setter.invoke(level);
    return { before, playerLevel: Number(getter.invoke()), original: originalPlayerLevel, reversible: true };
  });
}

async function setSkillPoints(value: number): Promise<unknown> {
  const points = boundedInteger(value, "points", 0, 100_000);
  return perform(() => {
    const player = scriptsClass("Player");
    const getter = player.method<number>("get_SkillPoint", 0);
    const setter = player.method<void>("set_SkillPoint", 1);
    const before = Number(getter.invoke());
    if (originalSkillPoints === null) originalSkillPoints = before;
    setter.invoke(points);
    return { before, skillPoints: Number(getter.invoke()), original: originalSkillPoints, reversible: true };
  });
}

async function setPause(enabled: boolean): Promise<unknown> {
  return perform(() => {
    const gameManager = scriptsClass("GameManager");
    const getter = gameManager.method<boolean>("get_Pause", 0);
    const setter = gameManager.method<void>("set_Pause", 1);
    const before = Boolean(getter.invoke());
    if (originalPause === null) originalPause = before;
    setter.invoke(Boolean(enabled));
    return { before, paused: Boolean(getter.invoke()), original: originalPause, reversible: true };
  });
}

async function setNoCooldown(enabled: boolean): Promise<unknown> {
  if (!enabled) {
    const errors = stopCooldownHooks();
    return { ...cooldownState() as object, restored: errors.length === 0, errors };
  }
  return perform(() => {
    if (cooldownEnabled) return cooldownState();
    const specs = [
      ["SpellUpdater", "ReduceActiveSkillCooldown"],
      ["SpellUpdater", "ReduceAutoSkillCooldown"],
      ["UIInfiniteSkillButton", "ReduceCooldown"],
    ] as const;
    const installed: Il2Cpp.Method[] = [];
    try {
      for (const [className, methodName] of specs) {
        const method = scriptsClass(className).method(methodName, 1);
        method.implementation = function (
          this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType,
          ...args: unknown[]
        ): Il2Cpp.Method.ReturnType {
          cooldownFires += 1;
          const forwarded = [...args];
          if (cooldownEnabled) forwarded[0] = 86_400;
          return this.method(method.name, 1).invoke(...(forwarded as Il2Cpp.Parameter.Type[]));
        };
        installed.push(method);
      }
      cooldownMethods = installed;
      cooldownEnabled = true;
      cooldownFires = 0;
      lastCooldownFires = 0;
      return cooldownState();
    } catch (error) {
      for (const method of installed) {
        try { Interceptor.revert(method.virtualAddress); } catch { /* best effort rollback */ }
      }
      try { Interceptor.flush(); } catch { /* no pending replacements */ }
      throw error;
    }
  });
}

async function waveState(): Promise<unknown> {
  return perform(() => {
    const gameMap = scriptsClass("GameMap");
    return {
      active: Boolean(gameMap.field<boolean>("IsBattle").value),
      waveMode: Boolean(gameMap.method<boolean>("get_IsWaveMode", 0).invoke()),
      currentWave: gameMap.method<Int64>("get_CurrentWave", 0).invoke().toString(),
      queuedSkip: Number(gameMap.method<number>("get_SkippingWave", 0).invoke()),
    };
  });
}

async function skipWaves(count: number, offlineConfirmed: boolean): Promise<unknown> {
  const waves = boundedInteger(count, "count", 1, 20);
  if (offlineConfirmed !== true) {
    throw new Error("offlineConfirmed must be true; wave progress must never be used with rankings or cloud sync");
  }
  return perform(() => {
    const gameMap = scriptsClass("GameMap");
    const active = Boolean(gameMap.field<boolean>("IsBattle").value);
    const waveMode = Boolean(gameMap.method<boolean>("get_IsWaveMode", 0).invoke());
    if (!active || !waveMode) throw new Error("start a normal wave battle before using waveSkip");
    const before = {
      currentWave: gameMap.method<Int64>("get_CurrentWave", 0).invoke().toString(),
      queuedSkip: Number(gameMap.method<number>("get_SkippingWave", 0).invoke()),
    };
    // Use the game's own local skip path without crystals, bonus bosses, or
    // monster-stat changes. The battle itself owns reward/UI reconciliation.
    gameMap.method<void>("AddSkip", 6).invoke(waves, false, 0, true, false, 0);
    return {
      before,
      currentWave: gameMap.method<Int64>("get_CurrentWave", 0).invoke().toString(),
      queuedSkip: Number(gameMap.method<number>("get_SkippingWave", 0).invoke()),
      requested: waves,
      reversible: false,
      warning: "Current-battle progression cannot be undone by resetAll",
    };
  });
}

async function resetAll(): Promise<unknown> {
  const restoreTimeScale = originalTimeScale;
  const restoreTargetFrameRate = originalTargetFrameRate;
  const restoreGold = originalGold;
  const restorePlayerLevel = originalPlayerLevel;
  const restoreSkillPoints = originalSkillPoints;
  const restorePause = originalPause;
  const hadCooldownHooks = cooldownEnabled || cooldownMethods.length > 0;
  // Detach first so restoration cannot be clamped by our own hooks. This also
  // guarantees listener cleanup even if the IL2CPP scheduler is unavailable.
  stopTimeScaleLock();
  stopTargetFpsLock();
  const cooldownErrors = stopCooldownHooks();
  const performance = frameMeter.reset();
  const errors = cooldownErrors.map((error) => `noCooldown: ${error}`);
  let unity: unknown = {
    timeScale: restoreTimeScale,
    targetFrameRate: restoreTargetFrameRate,
    restored: restoreTimeScale === null && restoreTargetFrameRate === null,
  };
  let progression: unknown = {
    gold: restoreGold,
    playerLevel: restorePlayerLevel,
    skillPoints: restoreSkillPoints,
    pause: restorePause,
    restored: restoreGold === null && restorePlayerLevel === null && restoreSkillPoints === null && restorePause === null,
  };
  const needsIl2CppRestore = restoreTimeScale !== null
    || restoreTargetFrameRate !== null
    || restoreGold !== null
    || restorePlayerLevel !== null
    || restoreSkillPoints !== null
    || restorePause !== null;
  if (needsIl2CppRestore) {
    try {
      const restored = await perform(() => {
        const core = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
        const time = core.class("UnityEngine.Time");
        const application = core.class("UnityEngine.Application");
        const inventory = scriptsClass("Inventory");
        const player = scriptsClass("Player");
        const gameManager = scriptsClass("GameManager");
        const restoreErrors: string[] = [];
        if (restoreTimeScale !== null) {
          try {
            time.method<void>("set_timeScale", 1).invoke(restoreTimeScale);
            originalTimeScale = null;
          } catch (error) {
            restoreErrors.push(`timeScale: ${errorText(error)}`);
          }
        }
        if (restoreTargetFrameRate !== null) {
          try {
            application.method<void>("set_targetFrameRate", 1).invoke(restoreTargetFrameRate);
            originalTargetFrameRate = null;
          } catch (error) {
            restoreErrors.push(`targetFrameRate: ${errorText(error)}`);
          }
        }
        if (restoreGold !== null) {
          try {
            inventory.method<void>("set_Gold", 1).invoke(int64(restoreGold));
            originalGold = null;
          } catch (error) {
            restoreErrors.push(`gold: ${errorText(error)}`);
          }
        }
        if (restorePlayerLevel !== null) {
          try {
            player.method<void>("set_Level", 1).invoke(restorePlayerLevel);
            originalPlayerLevel = null;
          } catch (error) {
            restoreErrors.push(`playerLevel: ${errorText(error)}`);
          }
        }
        if (restoreSkillPoints !== null) {
          try {
            player.method<void>("set_SkillPoint", 1).invoke(restoreSkillPoints);
            originalSkillPoints = null;
          } catch (error) {
            restoreErrors.push(`skillPoints: ${errorText(error)}`);
          }
        }
        if (restorePause !== null) {
          try {
            gameManager.method<void>("set_Pause", 1).invoke(restorePause);
            originalPause = null;
          } catch (error) {
            restoreErrors.push(`pause: ${errorText(error)}`);
          }
        }
        return {
          unity: {
            timeScale: restoreTimeScale,
            targetFrameRate: restoreTargetFrameRate,
            restored: !restoreErrors.some((message) => message.startsWith("timeScale:") || message.startsWith("targetFrameRate:")),
          },
          progression: {
            gold: restoreGold,
            playerLevel: restorePlayerLevel,
            skillPoints: restoreSkillPoints,
            pause: restorePause,
            restored: !restoreErrors.some((message) => /^(gold|playerLevel|skillPoints|pause):/.test(message)),
          },
          errors: restoreErrors,
        };
      });
      unity = restored.unity;
      progression = restored.progression;
      errors.push(...restored.errors);
    } catch (error) {
      errors.push(`runtime: ${errorText(error)}`);
      unity = { timeScale: restoreTimeScale, targetFrameRate: restoreTargetFrameRate, restored: false };
      progression = {
        gold: restoreGold,
        playerLevel: restorePlayerLevel,
        skillPoints: restoreSkillPoints,
        pause: restorePause,
        restored: false,
      };
    }
  }
  let activity: unknown;
  try {
    activity = await windowControl.reset();
  } catch (error) {
    const message = errorText(error);
    errors.push(`activity: ${message}`);
    activity = { error: message };
  }
  return {
    progression,
    noCooldown: { restored: cooldownErrors.length === 0, wasEnabled: hadCooldownHooks, errors: cooldownErrors },
    unity,
    performance,
    activity,
    clean: errors.length === 0,
    errors,
  };
}

const surface = {
  ...recordingRpcSurface(),
  modInfo(): unknown {
    return {
      game: "GrowCastle",
      package: "com.raongames.growcastle",
      testedVersion: "1.50.14",
      device: "R3CWB0GCWMX",
      runtime: "Unity IL2CPP / libil2cpp.so",
      scriptsAssembly: "Scripts.dll",
      safety: "Authorized offline/single-player runtime only; no rankings, cloud sync, purchases, ads, crystals, or remote state.",
    };
  },
  async modState(): Promise<unknown> {
    return {
      progression: await progressState(),
      unity: await unityState(),
      activity: await activityState(),
      performance: frameMeter.status(),
    };
  },
  progressRead: progressState,
  inventorySetGold: setGold,
  progressSetPlayerLevel: setPlayerLevel,
  progressSetSkillPoints: setSkillPoints,
  battleSetPause: setPause,
  skillsSetNoCooldown: setNoCooldown,
  skillsCooldownStatus: cooldownState,
  waveState,
  waveSkip: skipWaves,
  async assemblies(): Promise<unknown> {
    return perform(() => Il2Cpp.domain.assemblies.slice(0, 200).map((assembly) => ({
      name: assembly.name,
      image: assembly.image.name,
      classes: assembly.image.classCount,
    })));
  },
  async gameCatalog(): Promise<unknown> {
    return perform(() => {
      const groups = [
        ["Player", "player|hero|character"],
        ["World", "castle|stage|wave|world|map"],
        ["Combat", "enemy|monster|damage|health|attack"],
        ["Inventory", "inventory|item|equipment|weapon"],
        ["Progression", "skill|quest|level|upgrade|gold"],
        ["QoL", "speed|camera|input|ui|save"],
      ] as const;
      const all = scriptsAssembly().image.classes;
      return groups.map(([category, pattern]) => {
        const regex = new RegExp(pattern, "i");
        const matches = all.filter((klass) => regex.test(klass.fullName));
        return { category, total: matches.length, sample: matches.slice(0, 20).map((klass) => klass.fullName) };
      });
    });
  },
  async classSearch(query: string): Promise<unknown> {
    return perform(() => classRows(query));
  },
  async methodSearch(query: string): Promise<unknown> {
    const needle = boundedQuery(query);
    return perform(() => scriptsAssembly().image.classes
      .flatMap((klass) => klass.methods.filter((method) => method.name.toLowerCase().includes(needle)))
      .slice(0, 200)
      .map(methodRow));
  },
  async classDescribe(fullName: string): Promise<unknown> {
    const name = String(fullName ?? "").trim();
    if (!name || name.length > 160) throw new Error("fullName must be 1-160 characters");
    return perform(() => {
      const klass = scriptsAssembly().image.classes.find((candidate) => candidate.fullName === name);
      if (!klass) throw new Error(`class not found: ${name}`);
      return {
        name: klass.fullName,
        parent: klass.parent?.fullName ?? null,
        fields: klass.fields.slice(0, 120).map((field) => ({
          name: field.name,
          type: field.type.name,
          offset: field.offset,
          static: field.isStatic,
        })),
        methods: klass.methods.slice(0, 120).map(methodRow),
        truncated: klass.fields.length > 120 || klass.methods.length > 120,
      };
    });
  },
  timeRead: unityState,
  async timeSetScale(scale: number): Promise<unknown> {
    const value = Number(scale);
    if (!Number.isFinite(value) || value < 0.25 || value > 3) throw new Error("scale must be between 0.25 and 3");
    return perform(() => {
      if (Process.arch !== "arm64") throw new Error(`persistent time-scale control is not implemented for ${Process.arch}`);
      const time = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Time");
      const getter = time.method<number>("get_timeScale", 0);
      if (originalTimeScale === null) originalTimeScale = Number(getter.invoke());
      const setter = time.method<void>("set_timeScale", 1);
      timeScaleLock = value;
      if (!timeScaleListener) {
        const address = setter.virtualAddress;
        if (address.isNull()) throw new Error("Unity time-scale setter has no native address");
        timeScaleAddress = address.toString();
        timeScaleInterceptedWrites = 0;
        timeScaleListener = Interceptor.attach(address, {
          onEnter() {
            if (timeScaleLock === null) return;
            // AArch64 passes the first float argument in S0.
            (this.context as Arm64CpuContext).s0 = timeScaleLock;
            timeScaleInterceptedWrites += 1;
          },
        });
      }
      setter.invoke(value);
      return {
        timeScale: Number(getter.invoke()),
        original: originalTimeScale,
        owned: true,
        lock: timeScaleLockState(),
      };
    });
  },
  async qolSetTargetFps(fps: number): Promise<unknown> {
    const value = Number(fps);
    if (!Number.isInteger(value) || value < 15 || value > 240) throw new Error("fps must be an integer between 15 and 240");
    return perform(() => {
      const application = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Application");
      const getter = application.method<number>("get_targetFrameRate", 0);
      if (originalTargetFrameRate === null) originalTargetFrameRate = Number(getter.invoke());
      const setter = application.method<void>("set_targetFrameRate", 1);
      targetFrameRateLock = value;
      if (!targetFrameRateListener) {
        const address = setter.virtualAddress;
        if (address.isNull()) throw new Error("Unity target-frame-rate setter has no native address");
        targetFrameRateAddress = address.toString();
        targetFrameRateInterceptedWrites = 0;
        targetFrameRateListener = Interceptor.attach(address, {
          onEnter(args) {
            if (targetFrameRateLock === null) return;
            args[0] = ptr(targetFrameRateLock);
            targetFrameRateInterceptedWrites += 1;
          },
        });
      }
      setter.invoke(value);
      return {
        targetFrameRate: Number(getter.invoke()),
        original: originalTargetFrameRate,
        owned: true,
        lock: targetFpsLockState(),
      };
    });
  },
  async qolKeepAwake(enabled: boolean): Promise<unknown> { return windowControl.setKeepScreenOn(enabled); },
  performanceStart(): unknown { return frameMeter.start(); },
  performanceStatus(): unknown { return frameMeter.status(); },
  performanceStop(): unknown { return frameMeter.stop(); },
  resetAll,
  async dispose(): Promise<unknown> { return resetAll(); },
  __describe(): unknown {
    return [
      { name: "modInfo", label: "About this game mod", category: "Start here", doc: "Tested build, runtime, and offline-only safety boundary", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modState", label: "Show every active change", category: "Start here", doc: "Progress, battle, hooks, Unity values, and cleanup captures", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "progressRead", label: "Read gold and progress", category: "Progress", doc: "Read local gold, player level, skill points, wave, battle, and captured reset values", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "inventorySetGold", label: "Set local gold", category: "Inventory", args: [{ name: "gold", type: "integer", ui: { control: "input", label: "Gold", placeholder: "0..1000000000000" } }], doc: "Set 0..1,000,000,000,000 local gold through Inventory.set_Gold; resetAll restores the first captured value", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "progressRead" },
      { name: "progressSetPlayerLevel", label: "Set player level", category: "Progress", args: [{ name: "level", type: "integer", ui: { control: "slider", label: "Player level", min: 1, max: 10000, step: 1, default: 100 } }], doc: "Set local player level from 1..10,000 through Player.set_Level; resetAll restores it", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "progressRead" },
      { name: "progressSetSkillPoints", label: "Set skill points", category: "Progress", args: [{ name: "points", type: "integer", ui: { control: "slider", label: "Skill points", min: 0, max: 100000, step: 100, default: 1000 } }], doc: "Set 0..100,000 local skill points through Player.set_SkillPoint; resetAll restores them", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "progressRead" },
      { name: "battleSetPause", label: "Pause battle", category: "Battle", args: [{ name: "enabled", type: "boolean", ui: { control: "checkbox", label: "Battle paused" } }], doc: "Pause or resume the local battle through GameManager; resetAll restores the first state", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "progressRead" },
      { name: "skillsSetNoCooldown", label: "Unlimited skill use", category: "Skills", args: [{ name: "enabled", type: "boolean", ui: { control: "checkbox", label: "No cooldown" } }], doc: "Accelerate active, auto, and infinite-skill cooldown reducers; status counts live hook firings", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "skillsCooldownStatus" },
      { name: "skillsCooldownStatus", label: "Skill hook status", category: "Skills", doc: "Show installed cooldown hooks and live firing count", capabilities: ["instrument", "analysis"], effect: "read", returns: "verification" },
      { name: "waveState", label: "Read wave battle", category: "Battle", doc: "Read active wave battle and queued skip state", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "waveSkip", label: "Skip current waves", category: "Battle", args: [{ name: "count", type: "integer", ui: { control: "slider", label: "Waves", min: 1, max: 20, step: 1, default: 1 } }, { name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } }], doc: "Queue 1..20 waves through GameMap.AddSkip without crystals; requires active normal battle and explicit offline confirmation; one-shot and not resettable", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "waveState" },
      { name: "assemblies", label: "Loaded assemblies", category: "Discovery", doc: "Bounded IL2CPP assembly and class counts", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "gameCatalog", label: "Map game systems", category: "Discovery", doc: "Group live Scripts.dll classes by game subsystem", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "classSearch", label: "Find game classes", category: "Discovery", args: [{ name: "query", type: "string" }], doc: "Case-insensitive bounded class search in Scripts.dll", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "methodSearch", label: "Find game methods", category: "Discovery", args: [{ name: "query", type: "string" }], doc: "Bounded method search with signatures and live addresses", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "classDescribe", label: "Inspect one class", category: "Discovery", args: [{ name: "fullName", type: "string" }], doc: "Fields, methods, types, offsets, and addresses", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "timeRead", label: "Read game speed", category: "World", doc: "Read Unity time scale and target frame rate", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "timeSetScale", label: "Set game speed", category: "World", args: [{ name: "scale", type: "number", ui: { control: "slider", label: "Game speed", min: 0.25, max: 3, step: 0.25, default: 1 } }], doc: "Set local Unity time scale from 0.25 to 3; resetAll restores the captured value", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "timeRead" },
      { name: "qolSetTargetFps", label: "Set target FPS", category: "QoL", args: [{ name: "fps", type: "integer", ui: { control: "slider", label: "Target FPS", min: 15, max: 240, step: 15, default: 60 } }], doc: "Set Unity target frame rate from 15 to 240; resetAll restores the captured value", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "timeRead" },
      { name: "qolKeepAwake", label: "Keep screen awake", category: "QoL", args: [{ name: "enabled", type: "boolean", ui: { control: "checkbox", label: "Keep screen awake" } }], doc: "Toggle the game Activity window flag; resetAll restores its original value", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "performanceStart", label: "Start FPS meter", category: "QoL", doc: "Observe EGL frames without changing rendering", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "performanceStatus" },
      { name: "performanceStatus", label: "FPS meter status", category: "QoL", doc: "Frame count, measured FPS, and firing verification", capabilities: ["instrument", "analysis"], effect: "read", returns: "verification" },
      { name: "performanceStop", label: "Stop FPS meter", category: "QoL", doc: "Detach the owned EGL listener", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "performanceStatus" },
      { name: "resetAll", label: "Reset every reversible change", category: "Start here", doc: "Restore gold, level, skill points, pause, Unity/window values, and detach every owned hook/listener", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose mod", category: "Debug", doc: "Cleanup alias used before reload or detach", capabilities: ["instrument", "debug"], effect: "control", returns: "json" },
      ...recordingDescriptors(),
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

rpc.exports = surface;
ok("[growcastle] real game APIs ready: gold, level, skills, pause, cooldown, waves");
