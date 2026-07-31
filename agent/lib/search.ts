// Native discovery helpers — modules, exports, symbols, imports.
// Target-agnostic; works on any process.

import { ok } from "./log.js";

export function modules(q: string): Module[] {
  const results = Process.enumerateModules().filter((m) => new RegExp(q, "i").test(m.name));
  ok(`modules matching /${q}/i: ${results.length}`);
  results.forEach((m, i) => ok(`[${i}] ${m.name} ${m.version ?? ""} @ ${m.base}`));
  return results;
}

export function exports(q: string, moduleName?: string): ModuleExportDetails[] {
  const mods = moduleName
    ? Process.enumerateModules().filter((m) => m.name.toLowerCase() === moduleName.toLowerCase())
    : Process.enumerateModules();
  const re = new RegExp(q, "i");
  const results = mods.flatMap((m) =>
    m.enumerateExports().filter((e) => re.test(e.name)).map((e) => ({ ...e, module: m })),
  );
  ok(`exports matching /${q}/i: ${results.length}`);
  results.forEach((e, i) => ok(`[${i}] ${e.module.name}!${e.name} @ ${e.address}`));
  return results;
}

export function imports(q: string, moduleName: string): ModuleImportDetails[] {
  const m = Process.getModuleByName(moduleName);
  const re = new RegExp(q, "i");
  const results = m.enumerateImports().filter((e) => re.test(e.name));
  ok(`imports of ${moduleName} matching /${q}/i: ${results.length}`);
  results.forEach((e, i) => ok(`[${i}] ${e.module ?? "?"}!${e.name} @ ${e.address ?? "?"}`));
  return results;
}

/** Debug symbols (works when the module ships a symbol table / DWARF / PDB is loaded). */
export function symbols(q: string, moduleName: string): ModuleSymbolDetails[] {
  const m = Process.getModuleByName(moduleName);
  const re = new RegExp(q, "i");
  const results = m.enumerateSymbols().filter((s) => re.test(s.name));
  ok(`symbols of ${moduleName} matching /${q}/i: ${results.length}`);
  results.forEach((s, i) => ok(`[${i}] ${s.name} @ ${s.address}`));
  return results;
}
