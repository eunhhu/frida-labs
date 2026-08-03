// Whole-process string scan — find interesting literals (debug tags, URLs,
// cheat flags) without knowing which module they live in. For a single-module
// scan use mem.scanText instead.

export interface StringHit {
  address: string;
  text: string;
}

const MIN_LEN = 4;
const PRINTABLE = (b: number): boolean => b >= 0x20 && b < 0x7f;

function scanRangeForAscii(base: NativePointer, size: number, re: RegExp, out: StringHit[], cap: number): void {
  const CHUNK = 1024 * 1024;
  let off = 0;
  while (off < size && out.length < cap) {
    const n = Math.min(CHUNK, size - off);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(base.add(off).readByteArray(n)!); } catch { off += n; continue; }
    let start = -1;
    for (let i = 0; i <= bytes.length; i++) {
      const okByte = i < bytes.length && PRINTABLE(bytes[i]!);
      if (okByte && start < 0) start = i;
      if (!okByte && start >= 0) {
        if (i - start >= MIN_LEN) {
          const s = String.fromCharCode(...bytes.subarray(start, i));
          if (re.test(s)) out.push({ address: base.add(off + start).toString(), text: s });
        }
        start = -1;
      }
    }
    off += n;
  }
}

/**
 * Scan every readable module for ASCII strings matching `re` (case-insensitive
 * substring by default — pass a RegExp for full control). Returns at most
 * `cap` hits. UTF-16 strings are covered too when `utf16` is set.
 */
export function strings(query: string | RegExp, opts: { utf16?: boolean; cap?: number } = {}): StringHit[] {
  const re = typeof query === "string" ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : query;
  const cap = opts.cap ?? 100;
  const out: StringHit[] = [];
  for (const m of Process.enumerateModules()) {
    if (out.length >= cap) break;
    scanRangeForAscii(m.base, m.size, re, out, cap);
  }
  return out;
}
