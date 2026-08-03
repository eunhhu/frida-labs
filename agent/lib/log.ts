/// <reference path="../globals.d.ts" />
// Logging that works both under the frida CLI (console) and the host
// (structured send). Prefer send(): the host session engine pretty-prints
// and tags it. console.log is the fallback for contexts without a message
// channel — emitting both would double every line on the host.

export function log(...args: unknown[]): void {
  try {
    send({ type: "log", line: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ") });
  } catch {
    // send() unavailable (e.g. gum script without a channel): fall back.
    console.log(...(args as string[]));
  }
}

export const ok = (...a: unknown[]): void => log("[+]", ...a);
export const warn = (...a: unknown[]): void => log("[!]", ...a);
export const err = (...a: unknown[]): void => log("[x]", ...a);
