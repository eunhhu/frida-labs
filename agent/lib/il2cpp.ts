// IL2CPP (Unity) helpers. Target-agnostic across Unity games. Call inside
// Il2Cpp.perform(). Importing this module brings in the IL2CPP bridge, so only
// Unity targets should import it (never the shared lib barrel).

import "frida-il2cpp-bridge";
import { ok } from "./log.js";

export function classes(q: string, assembly = "Assembly-CSharp"): Il2Cpp.Class[] {
  const image = Il2Cpp.domain.assembly(assembly).image;
  const results = image.classes.filter((c) => new RegExp(q, "i").test(c.fullName));
  ok(`il2cpp classes matching /${q}/i: ${results.length}`);
  results.forEach((c, i) => ok(`[${i}] ${c.fullName}`));
  return results;
}

export function methods(q: string, assembly = "Assembly-CSharp"): Il2Cpp.Method[] {
  const image = Il2Cpp.domain.assembly(assembly).image;
  const results = image.classes.flatMap((c) => c.methods.filter((m) => new RegExp(q, "i").test(m.name)));
  ok(`il2cpp methods matching /${q}/i: ${results.length}`);
  results.forEach((m, i) => ok(`[${i}] ${m.class.fullName}::${m.name}`));
  return results;
}

/** Trace-hook one or many IL2CPP methods, logging args/return; optionally override args/return. */
export function hook(m: Il2Cpp.Method | Il2Cpp.Method[], overrideArgs?: unknown[], overrideRet?: unknown): void {
  if (Array.isArray(m)) { m.forEach((x) => hook(x, overrideArgs, overrideRet)); return; }
  ok(`hook ${m.class.fullName}::${m.name}`);
  m.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: unknown[]): Il2Cpp.Method.ReturnType {
    const ret = this.method(m.name).invoke(...((overrideArgs ?? args) as Il2Cpp.Parameter.Type[]));
    ok(`${m.name}() args=${JSON.stringify(args)} ret=${ret}`);
    return (overrideRet ?? ret) as Il2Cpp.Method.ReturnType;
  };
}
