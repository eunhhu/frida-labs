// Android Activity-scoped QoL controls shared by mobile game targets.
// Every mutation is opt-in and restores the Activity's original window flag.

import { api, perform } from "./java.js";
import type Java from "frida-java-bridge";

const FLAG_KEEP_SCREEN_ON = 0x80;

export interface ActivityWindowState {
  activityClass: string;
  visible: boolean;
  keepScreenOn: boolean;
  owned: boolean;
}

async function chooseActivity(className: string): Promise<Java.Wrapper> {
  const activity = await perform(() => new Promise<Java.Wrapper>((resolve, reject) => {
    let retained: Java.Wrapper | null = null;
    api().choose(className, {
      onMatch(instance) {
        if (!retained) retained = api().retain(instance);
      },
      onComplete() {
        if (retained) resolve(retained);
        else reject(new Error(`Activity ${className} is not live; bring the game to the foreground`));
      },
    });
  }));
  if (!activity) throw new Error("Android Java runtime is unavailable");
  return activity;
}

function windowFlags(activity: Java.Wrapper): number {
  return Number(activity.getWindow().getAttributes().flags.value);
}

function onMainThread<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    api().scheduleOnMainThread(() => {
      try {
        resolve(fn());
      } catch (error) {
        reject(error);
      }
    });
  });
}

export class ActivityWindowController {
  private originalKeepScreenOn: boolean | null = null;
  private owned = false;

  constructor(readonly activityClass: string) {}

  async status(): Promise<ActivityWindowState> {
    const activity = await chooseActivity(this.activityClass);
    try {
      return {
        activityClass: this.activityClass,
        visible: true,
        keepScreenOn: (windowFlags(activity) & FLAG_KEEP_SCREEN_ON) !== 0,
        owned: this.owned,
      };
    } finally {
      activity.$dispose();
    }
  }

  async setKeepScreenOn(enabled: boolean): Promise<ActivityWindowState> {
    const activity = await chooseActivity(this.activityClass);
    try {
      const before = (windowFlags(activity) & FLAG_KEEP_SCREEN_ON) !== 0;
      if (this.originalKeepScreenOn === null) this.originalKeepScreenOn = before;
      await onMainThread(() => {
        const window = activity.getWindow();
        if (enabled) window.addFlags(FLAG_KEEP_SCREEN_ON);
        else window.clearFlags(FLAG_KEEP_SCREEN_ON);
      });
      this.owned = true;
      return {
        activityClass: this.activityClass,
        visible: true,
        keepScreenOn: (windowFlags(activity) & FLAG_KEEP_SCREEN_ON) !== 0,
        owned: true,
      };
    } finally {
      activity.$dispose();
    }
  }

  async reset(): Promise<ActivityWindowState> {
    if (this.originalKeepScreenOn === null) return this.status();
    const activity = await chooseActivity(this.activityClass);
    try {
      const original = this.originalKeepScreenOn;
      await onMainThread(() => {
        const window = activity.getWindow();
        if (original) window.addFlags(FLAG_KEEP_SCREEN_ON);
        else window.clearFlags(FLAG_KEEP_SCREEN_ON);
      });
      this.originalKeepScreenOn = null;
      this.owned = false;
      return {
        activityClass: this.activityClass,
        visible: true,
        keepScreenOn: (windowFlags(activity) & FLAG_KEEP_SCREEN_ON) !== 0,
        owned: false,
      };
    } finally {
      activity.$dispose();
    }
  }
}
