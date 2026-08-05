// Whole-process string scan — find interesting literals (debug tags, URLs,
// cheat flags) without knowing which module they live in. For a single-module
// scan use mem.scanText instead.

export interface StringHit {
  address: string;
  text: string;
}

const MIN_LEN = 4;
const PRINTABLE = (b: number): boolean => b >= 0x20 && b < 0x7f;
const PRINTABLE_UTF16 = (u: number): boolean =>
  u >= 0x20 && !(u >= 0x7f && u < 0xa0) && u !== 0xfffe && u !== 0xffff;

function test(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

function chars(values: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < values.length; i += 4096) {
    const part: number[] = [];
    for (let j = i; j < Math.min(values.length, i + 4096); j++) part.push(values[j]!);
    out += String.fromCharCode(...part);
  }
  return out;
}

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
          const s = chars(bytes.subarray(start, i));
          if (test(re, s)) out.push({ address: base.add(off + start).toString(), text: s });
        }
        start = -1;
      }
    }
    off += n;
  }
}

function scanRangeForUtf16(base: NativePointer, size: number, re: RegExp, out: StringHit[], cap: number): void {
  const CHUNK = 1024 * 1024;
  let off = 0;
  while (off < size && out.length < cap) {
    const n = Math.min(CHUNK, size - off);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(base.add(off).readByteArray(n)!); } catch { off += n; continue; }
    // Scan both byte alignments: UTF-16 data is usually aligned, but packed
    // blobs and file-backed resources may begin at an odd address.
    for (const alignment of [0, 1]) {
      let start = -1;
      const units: number[] = [];
      for (let i = alignment; i <= bytes.length; i += 2) {
        const hasUnit = i + 1 < bytes.length;
        const unit = hasUnit ? bytes[i]! | (bytes[i + 1]! << 8) : 0;
        if (hasUnit && PRINTABLE_UTF16(unit)) {
          if (start < 0) start = i;
          units.push(unit);
        } else if (start >= 0) {
          if (units.length >= MIN_LEN) {
            const s = chars(units);
            if (test(re, s)) out.push({ address: base.add(off + start).toString(), text: s });
          }
          start = -1;
          units.length = 0;
        }
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
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
    if (opts.utf16 && out.length < cap) scanRangeForUtf16(m.base, m.size, re, out, cap);
  }
  return out;
}
