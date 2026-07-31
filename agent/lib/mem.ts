// Generic memory helpers — reusable across every target.
// Guarded reads return null instead of throwing: RE code walks half-valid
// pointers constantly, so a failed read is data, not an exception.

export const mainModule = (): Module => Process.enumerateModules()[0];

export const moduleByPattern = (re: RegExp): Module | undefined =>
  Process.enumerateModules().find((m) => re.test(m.name));

// --- guarded reads ----------------------------------------------------------
export const rP = (p: NativePointer): NativePointer | null => {
  try { const v = p.readPointer(); return v.isNull() ? null : v; } catch { return null; }
};
export const rU8 = (p: NativePointer): number | null => { try { return p.readU8(); } catch { return null; } };
export const rU16 = (p: NativePointer): number | null => { try { return p.readU16(); } catch { return null; } };
export const rU32 = (p: NativePointer): number | null => { try { return p.readU32(); } catch { return null; } };
export const rU64 = (p: NativePointer): UInt64 | null => { try { return p.readU64(); } catch { return null; } };
export const rS32 = (p: NativePointer): number | null => { try { return p.readS32(); } catch { return null; } };
export const rF = (p: NativePointer): number | null => { try { return p.readFloat(); } catch { return null; } };
export const rD = (p: NativePointer): number | null => { try { return p.readDouble(); } catch { return null; } };
export const rCStr = (p: NativePointer, max = 256): string | null => { try { return p.readCString(max); } catch { return null; } };
export const rUtf16 = (p: NativePointer, len = -1): string | null => { try { return p.readUtf16String(len); } catch { return null; } };

// --- guarded writes ---------------------------------------------------------
export const wF = (p: NativePointer, v: number): boolean => { try { p.writeFloat(v); return true; } catch { return false; } };
export const wU32 = (p: NativePointer, v: number): boolean => { try { p.writeU32(v); return true; } catch { return false; } };
export const wU8 = (p: NativePointer, v: number): boolean => { try { p.writeU8(v); return true; } catch { return false; } };
export const wP = (p: NativePointer, v: NativePointer): boolean => { try { p.writePointer(v); return true; } catch { return false; } };

/** Pretty hex dump around an address, e.g. hexdump(ptr, 64). */
export function dump(p: NativePointer, len = 128): string {
  try { return hexdump(p, { length: len, ansi: false, header: true }); } catch (e) { return `<unreadable: ${(e as Error).message}>`; }
}

export interface ScanHit { address: NativePointer; }

/** AOB / byte-pattern scan over a module (default: main module). Pattern e.g. "48 8B ?? ?? 89". */
export function scan(pattern: string, module: Module = mainModule(), limit = 64): NativePointer[] {
  try {
    return Memory.scanSync(module.base, module.size, pattern).slice(0, limit).map((m) => m.address);
  } catch {
    return [];
  }
}

/** Scan for a UTF-8 (and optionally UTF-16LE) string literal in a module. */
export function scanText(text: string, module: Module = mainModule(), opts: { utf16?: boolean; limit?: number } = {}): NativePointer[] {
  const bytes = text.split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"));
  const hits: NativePointer[] = [];
  const push = (pat: string) => { try { Memory.scanSync(module.base, module.size, pat).forEach((m) => hits.push(m.address)); } catch { /* */ } };
  push(bytes.join(" "));
  if (opts.utf16) push(bytes.map((b) => `${b} 00`).join(" "));
  return hits.slice(0, opts.limit ?? 64);
}
