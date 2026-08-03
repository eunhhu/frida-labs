// Target entry: A Dance of Fire and Ice (Unity, Mono backend).
// Build/run:  flab run adofai
//
// All the heavy lifting is in ../../lib/mono — this only exposes rpc for the REPL.

import { ok } from "../../lib/log.js";
import { mono } from "../../lib/mono/index.js";

rpc.exports = {
  info() {
    const asms = mono.assemblies();
    const cs = mono.image("Assembly-CSharp");
    return { assemblies: asms.length, hasAssemblyCSharp: !!cs, classes: cs ? mono.classes(cs).length : 0 };
  },
  assemblies() { return mono.assemblies(); },

  /** All Assembly-CSharp class names, or those matching a regex. */
  classes(pattern?: string) {
    const all = mono.classes();
    const names = all.map((c) => (c.ns ? `${c.ns}.${c.name}` : c.name));
    if (!pattern) return { total: names.length, names };
    const re = new RegExp(pattern, "i");
    return names.filter((n) => re.test(n));
  },

  methods(className: string, ns = "") {
    return mono.methods(mono.classByName(ns, className)).map((m) => m.full);
  },
  fields(className: string, ns = "") {
    return mono.fields(mono.classByName(ns, className)).map((f) => `+0x${f.offset.toString(16)} ${f.name}`);
  },

  /** Native (JIT) address of a managed method — feed to disassemble/decompile. */
  address(className: string, method: string, ns = "") {
    return mono.addressOf(mono.method(ns, className, method))?.toString() ?? null;
  },
  /** Log every call to a managed method. */
  trace(className: string, method: string, ns = "") {
    return mono.trace(mono.method(ns, className, method)) ? `tracing ${className}.${method}` : "method not found";
  },
};

ok(`adofai (mono) ready — ${mono.assemblies().length} assemblies`);
