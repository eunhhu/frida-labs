/// <reference path="../globals.d.ts" />
// Logging that works both under the frida CLI (console) and the host client
// (structured send). Every line is also mirrored to send() so host/client.ts
// can pretty-print and tag it.

export function log(...args: unknown[]): void {
  console.log(...(args as string[]));
  try {
    send({ type: "log", line: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  } catch {
    /* send unavailable in some contexts */
  }
}

export const ok = (...a: unknown[]): void => log("[+]", ...a);
export const warn = (...a: unknown[]): void => log("[!]", ...a);
export const err = (...a: unknown[]): void => log("[x]", ...a);
