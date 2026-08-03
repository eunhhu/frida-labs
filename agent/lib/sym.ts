// Symbol / debugger helpers — DebugSymbol wrapper, target-agnostic.
// Side-effect free at import; everything resolves on call.

/** Symbolicate one address; falls back to the raw pointer when unresolved. */
export function fromAddress(addr: NativePointer): string {
  try {
    return DebugSymbol.fromAddress(addr).toString();
  } catch {
    return addr.toString();
  }
}

/** Symbolicate an address list (e.g. a backtrace) into display strings. */
export function symbolicate(addrs: NativePointer[]): string[] {
  return addrs.map(fromAddress);
}

/** Backtrace the current thread, symbolicated. */
export function backtrace(accurate = true): string[] {
  return symbolicate(
    Thread.backtrace(undefined, accurate ? Backtracer.ACCURATE : Backtracer.FUZZY),
  );
}

/** Resolve a function by exact name across all modules (dbghelp-level). */
export function findFunctionsNamed(name: string): NativePointer[] {
  try {
    return DebugSymbol.findFunctionsNamed(name);
  } catch {
    return [];
  }
}

/** Resolve functions by glob pattern (e.g. "*!open*"). */
export function findFunctionsMatching(glob: string): NativePointer[] {
  try {
    return DebugSymbol.findFunctionsMatching(glob);
  } catch {
    return [];
  }
}

/** Look up one exported symbol by name, globally or inside one module. */
export function lookupExport(name: string, moduleName?: string): NativePointer | null {
  if (moduleName !== undefined) {
    const m = Process.findModuleByName(moduleName);
    return m ? m.findExportByName(name) : null;
  }
  return Module.findGlobalExportByName(name);
}

/** Full symbol info for an address, or null when the platform cannot resolve it. */
export function infoAt(addr: NativePointer): DebugSymbol | null {
  try {
    const s = DebugSymbol.fromAddress(addr);
    return s.address.isNull() ? null : s;
  } catch {
    return null;
  }
}
