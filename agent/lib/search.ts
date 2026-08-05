// Native discovery helpers — modules, exports, symbols, imports.
// Target-agnostic; works on any process.

import { ok } from "./log.js";

const LOG_SAMPLE = 20;

function includes(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function logSample<T>(summary: string, results: readonly T[], format: (item: T, index: number) => string): void {
  ok(`${summary}: ${results.length}`);
  results.slice(0, LOG_SAMPLE).forEach((item, index) => ok(format(item, index)));
  if (results.length > LOG_SAMPLE) {
    ok(`… ${results.length - LOG_SAMPLE} more returned to caller (per-row agent logging capped)`);
  }
}

export function modules(q: string): Module[] {
  const results = Process.enumerateModules().filter((m) => includes(m.name, q));
  logSample(`modules containing ${JSON.stringify(q)}`, results, (m, i) => `[${i}] ${m.name} ${m.version ?? ""} @ ${m.base}`);
  return results;
}

export function exports(q: string, moduleName?: string): ModuleExportDetails[] {
  const mods = moduleName
    ? Process.enumerateModules().filter((m) => m.name.toLowerCase() === moduleName.toLowerCase())
    : Process.enumerateModules();
  const results = mods.flatMap((m) =>
    m.enumerateExports().filter((e) => includes(e.name, q)).map((e) => ({ ...e, module: m })),
  );
  logSample(`exports containing ${JSON.stringify(q)}`, results, (e, i) => `[${i}] ${e.module.name}!${e.name} @ ${e.address}`);
  return results;
}

export function imports(q: string, moduleName: string): ModuleImportDetails[] {
  const m = Process.getModuleByName(moduleName);
  const results = m.enumerateImports().filter((e) => includes(e.name, q));
  logSample(`imports of ${moduleName} containing ${JSON.stringify(q)}`, results, (e, i) => `[${i}] ${e.module ?? "?"}!${e.name} @ ${e.address ?? "?"}`);
  return results;
}

/** Debug symbols (works when the module ships a symbol table / DWARF / PDB is loaded). */
export function symbols(q: string, moduleName: string): ModuleSymbolDetails[] {
  const m = Process.getModuleByName(moduleName);
  const results = m.enumerateSymbols().filter((s) => includes(s.name, q));
  logSample(`symbols of ${moduleName} containing ${JSON.stringify(q)}`, results, (s, i) => `[${i}] ${s.name} @ ${s.address}`);
  return results;
}
