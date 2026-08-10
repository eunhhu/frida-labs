// Android Java-layer runtime inspection — reusable across every ART target.
//
// Instrumentation, not neutralization: these helpers observe or instrument
// Java surfaces (method calls, crypto operations, WebView bridges, intents)
// and report through the structured log channel. Detection-only is the
// default; nothing here suppresses security checks.
//
// Technique coverage follows the standard Android app-testing surfaces:
// class method tracing with overload handling, Cipher/KeySpec/MessageDigest
// capture, WebView URL/bridge observation, SharedPreferences dump, and
// intent sniffing. See docs/analysis-playbooks.md.
//
// ART access goes through the lib-owned java.js gate (never the ambient Java
// global), so importing this module is side-effect free off-Android.

import { ok, err } from "./log.js";
import * as java from "./java.js";

function bytesToHex(bytes: unknown): string {
  if (bytes === null || bytes === undefined) return "null";
  try {
    const arr = bytes as number[];
    let out = "";
    for (let i = 0; i < arr.length; i++) out += (arr[i] & 0xff).toString(16).padStart(2, "0");
    return out;
  } catch {
    return String(bytes);
  }
}

// Loose view of the frida-java-bridge surface these helpers use. The bridge
// runtime arrives from java.api(); typing every dynamic wrapper precisely
// would require importing bridge types into non-Android bundles.
type AnyClass = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function withVm(run: (J: { use(name: string): AnyClass }) => void): boolean {
  if (!java.available()) {
    err("jtrace: no Java runtime in this process");
    return false;
  }
  try {
    const J = java.api();
    J.perform(() => run(J as unknown as { use(name: string): AnyClass }));
    return true;
  } catch (e) {
    err(`jtrace: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Trace every declared method of `className` (all overloads), logging
 * arguments on entry and the return value on exit. Returns the number of
 * overloads instrumented (0 when the VM or class is unavailable).
 */
export function traceClass(className: string): number {
  let count = 0;
  withVm((J) => {
    const clazz = J.use(className);
    const methods = clazz.class.getDeclaredMethods();
    for (const method of methods) {
      const name: string = method.getName();
      for (const overload of clazz[name].overloads) {
        overload.implementation = function (this: AnyClass, ...args: unknown[]) {
          ok(`[trace] ${className}.${name}(${args.map((a) => String(a)).join(", ")})`);
          const ret = this[name](...args);
          ok(`[trace] ${className}.${name} => ${String(ret)}`);
          return ret;
        };
        count++;
      }
    }
    ok(`tracing ${count} overload(s) in ${className}`);
  });
  return count;
}

/**
 * Observe javax.crypto operations: Cipher.init (algorithm, mode, key bytes),
 * Cipher.doFinal (plaintext/ciphertext), and MessageDigest input/output. The
 * standard way to recover how an app derives or applies its encryption on an
 * authorized build. Returns false when ART is unavailable.
 */
export function watchCrypto(): boolean {
  return withVm((J) => {
    const Cipher = J.use("javax.crypto.Cipher");
    Cipher.init.overload("int", "java.security.Key").implementation = function (
      this: AnyClass,
      mode: number,
      key: { getEncoded(): unknown },
    ) {
      ok(`[crypto] Cipher.init algo=${this.getAlgorithm()} mode=${mode === 1 ? "ENCRYPT" : "DECRYPT"} key=${bytesToHex(key.getEncoded())}`);
      return this.init(mode, key);
    };
    Cipher.doFinal.overload("[B").implementation = function (this: AnyClass, data: unknown) {
      ok(`[crypto] doFinal in=${bytesToHex(data)}`);
      const result = this.doFinal(data);
      ok(`[crypto] doFinal out=${bytesToHex(result)}`);
      return result;
    };
    try {
      const Digest = J.use("java.security.MessageDigest");
      Digest.digest.overload("[B").implementation = function (this: AnyClass, data: unknown) {
        const result = this.digest(data);
        ok(`[crypto] ${this.getAlgorithm()}.digest ${bytesToHex(data)} -> ${bytesToHex(result)}`);
        return result;
      };
    } catch { /* MessageDigest not always loadable as a class literal */ }
    ok("crypto watch installed");
  });
}

/**
 * Enable WebView contents debugging and observe loadUrl /
 * addJavascriptInterface on every WebView. Bridge enumeration is the point:
 * exposed Java interfaces are the injection surface to audit.
 */
export function watchWebViews(): boolean {
  return withVm((J) => {
    const WebView = J.use("android.webkit.WebView");
    WebView.setWebContentsDebuggingEnabled(true);
    WebView.loadUrl.overload("java.lang.String").implementation = function (this: AnyClass, url: string) {
      ok(`[webview] loadUrl ${url}`);
      return this.loadUrl(url);
    };
    WebView.addJavascriptInterface.implementation = function (this: AnyClass, obj: AnyClass, name: string) {
      ok(`[webview] bridge ${name} -> ${obj.getClass().getName()}`);
      return this.addJavascriptInterface(obj, name);
    };
    ok("webview watch installed (contents debugging enabled)");
  });
}

/** Dump every SharedPreferences file in the app's private storage to the log. */
export function dumpSharedPreferences(): boolean {
  return withVm((J) => {
    const ctx = J.use("android.app.ActivityThread").currentApplication().getApplicationContext();
    const dir = ctx.getFilesDir().getParentFile().getAbsolutePath() + "/shared_prefs/";
    const File = J.use("java.io.File");
    const files = File.$new(dir).listFiles();
    if (!files) { ok("no shared_prefs directory"); return; }
    for (const file of files) {
      const name = String(file.getName()).replace(/\.xml$/, "");
      const entries = ctx.getSharedPreferences(name, 0).getAll().entrySet().iterator();
      ok(`[prefs] ${name}`);
      while (entries.hasNext()) {
        const entry = entries.next();
        ok(`  ${entry.getKey()} = ${entry.getValue()}`);
      }
    }
  });
}

/** Log every startActivity / sendBroadcast with extras. */
export function watchIntents(): boolean {
  return withVm((J) => {
    const Activity = J.use("android.app.Activity");
    Activity.startActivity.overload("android.content.Intent").implementation = function (this: AnyClass, intent: AnyClass) {
      const extras = intent.getExtras();
      ok(`[intent] startActivity ${intent}${extras ? ` extras=${extras}` : ""}`);
      return this.startActivity(intent);
    };
    const Wrapper = J.use("android.content.ContextWrapper");
    Wrapper.sendBroadcast.overload("android.content.Intent").implementation = function (this: AnyClass, intent: AnyClass) {
      ok(`[intent] sendBroadcast ${intent}`);
      return this.sendBroadcast(intent);
    };
    ok("intent watch installed");
  });
}
