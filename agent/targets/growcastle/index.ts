// GrowCastle 1.50.14 — authorized single-player Android target.
// Online rankings, purchases, ads, and remote state are explicitly excluded.

import { perform } from "../../lib/il2cpp.js";
import { ActivityWindowController } from "../../lib/android-activity.js";
import { FrameMeter } from "../../lib/frame-meter.js";
import { ok } from "../../lib/log.js";

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

async function resetAll(): Promise<unknown> {
  const restoreTimeScale = originalTimeScale;
  const restoreTargetFrameRate = originalTargetFrameRate;
  // Detach first so restoration cannot be clamped by our own hooks. This also
  // guarantees listener cleanup even if the IL2CPP scheduler is unavailable.
  stopTimeScaleLock();
  stopTargetFpsLock();
  const performance = frameMeter.reset();
  const errors: string[] = [];
  let unity: unknown = {
    timeScale: restoreTimeScale,
    targetFrameRate: restoreTargetFrameRate,
    restored: restoreTimeScale === null && restoreTargetFrameRate === null,
  };
  if (restoreTimeScale !== null || restoreTargetFrameRate !== null) {
    try {
      unity = await perform(() => {
        const core = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
        const time = core.class("UnityEngine.Time");
        const application = core.class("UnityEngine.Application");
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
        return {
          timeScale: restoreTimeScale,
          targetFrameRate: restoreTargetFrameRate,
          restored: restoreErrors.length === 0,
          errors: restoreErrors,
        };
      });
      errors.push(...((unity as { errors?: string[] }).errors ?? []));
    } catch (error) {
      errors.push(`unity: ${errorText(error)}`);
      unity = { timeScale: restoreTimeScale, targetFrameRate: restoreTargetFrameRate, restored: false };
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
  return { unity, performance, activity, clean: errors.length === 0, errors };
}

const surface = {
  modInfo(): unknown {
    return {
      game: "GrowCastle",
      package: "com.raongames.growcastle",
      testedVersion: "1.50.14",
      device: "R3CWB0GCWMX",
      runtime: "Unity IL2CPP / libil2cpp.so",
      scriptsAssembly: "Scripts.dll",
      safety: "Single-player runtime and reversible QoL only; no rankings, purchases, ads, or remote state.",
    };
  },
  modHelp(): unknown {
    return [
      "Game speed: timeSetScale(0.25..3), timeRead()",
      "Rendering: qolSetTargetFps(15..240), performanceStart()",
      "Discovery: gameCatalog(), classSearch(name), methodSearch(name), classDescribe(fullName)",
      "Cleanup: resetAll() restores captured values and listeners",
    ];
  },
  async modState(): Promise<unknown> {
    return { unity: await unityState(), activity: await activityState(), performance: frameMeter.status() };
  },
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
      { name: "modInfo", label: "About this mod", category: "System", doc: "Tested build, runtime, and safety boundary", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "modHelp", label: "How to use", category: "System", doc: "Action examples and reset command", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "modState", label: "Current mod state", category: "System", doc: "Unity values, window flag, and frame meter", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "assemblies", label: "Loaded assemblies", category: "Discovery", doc: "Bounded IL2CPP assembly and class counts", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "gameCatalog", label: "Map game systems", category: "Discovery", doc: "Group live Scripts.dll classes by game subsystem", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "classSearch", label: "Find game classes", category: "Discovery", args: [{ name: "query", type: "string" }], doc: "Case-insensitive bounded class search in Scripts.dll", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "methodSearch", label: "Find game methods", category: "Discovery", args: [{ name: "query", type: "string" }], doc: "Bounded method search with signatures and live addresses", capabilities: ["instrument", "analysis"], effect: "read", returns: "table" },
      { name: "classDescribe", label: "Inspect one class", category: "Discovery", args: [{ name: "fullName", type: "string" }], doc: "Fields, methods, types, offsets, and addresses", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "timeRead", label: "Read game speed", category: "World", doc: "Read Unity time scale and target frame rate", capabilities: ["instrument", "analysis"], effect: "read", returns: "json" },
      { name: "timeSetScale", label: "Set game speed", category: "World", args: [{ name: "scale", type: "number" }], doc: "Set local Unity time scale from 0.25 to 3; resetAll restores the captured value", capabilities: ["instrument"], effect: "write", returns: "json", statusAction: "timeRead" },
      { name: "qolSetTargetFps", label: "Set target FPS", category: "QoL", args: [{ name: "fps", type: "integer" }], doc: "Set Unity target frame rate from 15 to 240; resetAll restores the captured value", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "timeRead" },
      { name: "qolKeepAwake", label: "Keep screen awake", category: "QoL", args: [{ name: "enabled", type: "boolean" }], doc: "Toggle the game Activity window flag; resetAll restores its original value", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "performanceStart", label: "Start FPS meter", category: "QoL", doc: "Observe EGL frames without changing rendering", capabilities: ["instrument"], effect: "hook", returns: "verification", statusAction: "performanceStatus" },
      { name: "performanceStatus", label: "FPS meter status", category: "QoL", doc: "Frame count, measured FPS, and firing verification", capabilities: ["instrument", "analysis"], effect: "read", returns: "verification" },
      { name: "performanceStop", label: "Stop FPS meter", category: "QoL", doc: "Detach the owned EGL listener", capabilities: ["instrument"], effect: "control", returns: "verification", statusAction: "performanceStatus" },
      { name: "resetAll", label: "Reset all changes", category: "System", doc: "Restore Unity values/window flags and detach listeners", capabilities: ["instrument"], effect: "control", returns: "json", statusAction: "modState" },
      { name: "dispose", label: "Dispose mod", category: "Debug", doc: "Cleanup alias used before reload or detach", capabilities: ["instrument", "debug"], effect: "control", returns: "json" },
      { name: "__describe", doc: "This descriptor" },
    ];
  },
};

rpc.exports = surface;
ok("[growcastle] IL2CPP discovery and reversible QoL target ready");
