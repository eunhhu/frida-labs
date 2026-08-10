// The Battle Cats KR 15.5.0 — authorized local Android target.
// The installed build currently stops at a 620 MB data-download prompt, so
// battle/save/currency mutations remain fail-closed until a playable scene exists.

import { ActivityWindowController } from "../../lib/android-activity.js";
import { FrameMeter } from "../../lib/frame-meter.js";
import { withVerification, type Verification, type VerificationStatus } from "../../lib/hook.js";
import { ok } from "../../lib/log.js";
import { control, defineInstrument, field, hook, read } from "../../lib/instrument.js";
import { recordingInstrumentActions } from "../../lib/recording.js";

const ACTIVITY = "jp.co.ponos.battlecats.MyActivity";
const TOUCH_EXPORT = "Java_jp_co_ponos_battlecats_MyActivity_appTouch";
const windowControl = new ActivityWindowController(ACTIVITY);
const frameMeter = new FrameMeter();
let touchVerification: Verification | null = null;
let touchAddress: string | null = null;
let lastTouchStatus: VerificationStatus = { fired: 0, verified: false, state: "unverified" };

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

function touchStatus(): unknown {
  const status = touchVerification?.status() ?? lastTouchStatus;
  return { running: touchVerification !== null, address: touchAddress, ...status };
}

function touchStart(): unknown {
  if (touchVerification) return touchStatus();
  // On Android, this JNI symbol is visible in the owning module's export
  // table but is not necessarily returned by Frida's global export lookup.
  const address = Process.findModuleByName("libnative-lib.so")?.findExportByName(TOUCH_EXPORT) ?? null;
  if (!address) throw new Error(`${TOUCH_EXPORT} is not loaded`);
  let verification: Verification | null = null;
  const listener = Interceptor.attach(address, {
    onEnter() { verification?.note(); },
  });
  verification = withVerification(listener, "Battle Cats touch input");
  touchVerification = verification;
  touchAddress = address.toString();
  lastTouchStatus = verification.status();
  return touchStatus();
}

function touchStop(): unknown {
  if (touchVerification) {
    lastTouchStatus = touchVerification.status();
    touchVerification.detach();
    touchVerification = null;
  }
  return touchStatus();
}

function runtimeRead(): unknown {
  const module = Process.findModuleByName("libnative-lib.so");
  const jni = module
    ? module.enumerateExports()
      .filter((entry) => entry.name.startsWith("Java_jp_co_ponos_battlecats_"))
      .slice(0, 100)
      .map((entry) => ({ name: entry.name, address: entry.address.toString() }))
    : [];
  return {
    processId: Process.id,
    arch: Process.arch,
    platform: Process.platform,
    nativeModule: module ? { name: module.name, base: module.base.toString(), size: module.size } : null,
    jniExports: jni,
    jniExportCount: jni.length,
    playableScene: false,
    blocker: "The installed build requests a 620 MB game-data download before gameplay.",
  };
}

async function resetAll(): Promise<unknown> {
  const touch = touchStop();
  const performance = frameMeter.reset();
  try {
    return { touch, performance, activity: await windowControl.reset(), clean: true };
  } catch (error) {
    return { touch, performance, activity: { error: errorText(error) }, clean: false };
  }
}

rpc.exports = defineInstrument({
  info: read({
    label: "About this Instrument",
    category: "Start here",
    doc: "Tested build, runtime, safety boundary, and required game-data step",
  }, () => ({
      game: "The Battle Cats KR",
      package: "jp.co.ponos.battlecatskr",
      testedVersion: "15.5.0",
      device: "R3CWB0GCWMX",
      runtime: "Java Activity + custom native libnative-lib.so",
      safety: "Read-only discovery and reversible local QoL only; no currency, purchase, event, or server-state modification.",
      liveBlocker: "620 MB game-data download is required before a battle scene can be tested.",
  })),
  state: read({
    label: "Active changes",
    category: "Start here",
    doc: "Window flag, FPS meter, touch monitor, and clean state",
  }, async () => ({ activity: await activityState(), performance: frameMeter.status(), touch: touchStatus() })),
  actions: {
    qolKeepAwake: control({
      label: "Keep screen awake",
      category: "QoL",
      args: [field.checkbox("enabled", { label: "Keep screen awake" })],
      doc: "Toggle the Activity window flag; reset restores its original value",
      status: "modState",
    }, (enabled: boolean) => windowControl.setKeepScreenOn(enabled)),
    performanceStart: hook({
      label: "FPS meter",
      category: "QoL",
      doc: "Observe EGL frames without changing rendering",
      returns: "verification",
      status: "performanceStatus",
    }, () => frameMeter.start()),
    performanceStop: control({
      label: "Stop FPS meter",
      category: "QoL",
      doc: "Detach the owned EGL listener",
      returns: "verification",
      status: "performanceStatus",
    }, () => frameMeter.stop()),
    performanceStatus: read({
      label: "FPS meter status",
      category: "QoL",
      doc: "Frame count, measured FPS, and firing verification",
      returns: "verification",
    }, () => frameMeter.status()),
    touchMonitorStart: hook({
      label: "Touch monitor",
      category: "Debug",
      doc: "Count native appTouch calls without changing input",
      capabilities: ["instrument", "debug"],
      returns: "verification",
      status: "touchMonitorStatus",
    }, touchStart),
    touchMonitorStop: control({
      label: "Stop touch monitor",
      category: "Debug",
      doc: "Detach the owned touch listener",
      capabilities: ["instrument", "debug"],
      returns: "verification",
      status: "touchMonitorStatus",
    }, touchStop),
    touchMonitorStatus: read({
      label: "Touch monitor status",
      category: "Debug",
      doc: "Hook address, event count, and firing verification",
      capabilities: ["instrument", "analysis", "debug"],
      returns: "verification",
    }, touchStatus),
    runtimeRead: read({
      label: "Native runtime details",
      category: "Discovery",
      doc: "Live module and bounded JNI export inventory",
    }, runtimeRead),
    dataCatalog: read({
      label: "Discovered game systems",
      category: "Discovery",
      doc: "APK/native evidence and explicit unsupported mutation rows",
      returns: "table",
    }, () => [
      { subsystem: "Units", evidence: "UnitLocal.list / unit*.csv", read: true, modify: false, reason: "runtime format not yet mapped" },
      { subsystem: "Enemies", evidence: "Enemyname.tsv / EnemyPictureBook*.csv", read: true, modify: false, reason: "playable data not downloaded" },
      { subsystem: "Stages", evidence: "MapLocal.list / stage*.csv", read: true, modify: false, reason: "playable data not downloaded" },
      { subsystem: "Items", evidence: "DataLocal.list / itemShopData.tsv", read: true, modify: false, reason: "purchase and server state excluded" },
      { subsystem: "Battle", evidence: "BattleInit/BattleFinish/battle_* native strings", read: true, modify: false, reason: "no live battle scene" },
      { subsystem: "Save", evidence: "SAVE_DATA / SaveDataTransfer native strings", read: true, modify: false, reason: "save mutation intentionally excluded" },
      { subsystem: "Content", evidence: "pack/list asset pipeline", read: true, create: false, reason: "no runtime factory or supported asset-registration path proven" },
    ]),
    ...recordingInstrumentActions(),
  },
  reset: control({
    label: "Reset every reversible change",
    category: "Start here",
    doc: "Detach listeners and restore the Activity window flag",
    status: "modState",
  }, resetAll),
  dispose: control({
    label: "Dispose Instrument",
    category: "Debug",
    doc: "Cleanup alias used before reload or detach",
    capabilities: ["instrument", "debug"],
  }, resetAll),
});
ok("[battlecatskr] native discovery/QoL target ready; gameplay writes blocked until data is installed");
