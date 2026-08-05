import { afterEach, describe, expect, test } from "bun:test";
import { scanText } from "../agent/lib/mem.js";
import { strings } from "../agent/lib/strings.js";

const globals = globalThis as Record<string, unknown>;
const originalMemory = globals.Memory;
const originalProcess = globals.Process;

afterEach(() => {
  if (originalMemory === undefined) delete globals.Memory;
  else globals.Memory = originalMemory;
  if (originalProcess === undefined) delete globals.Process;
  else globals.Process = originalProcess;
});

class FakePointer {
  constructor(private readonly bytes: Uint8Array, private readonly offset = 0) {}
  add(delta: number): FakePointer { return new FakePointer(this.bytes, this.offset + delta); }
  readByteArray(length: number): ArrayBuffer { return this.bytes.slice(this.offset, this.offset + length).buffer; }
  toString(): string { return `0x${this.offset.toString(16)}`; }
}

describe("string scanning", () => {
  test("scanText emits correct UTF-8 and UTF-16LE patterns", () => {
    const patterns: string[] = [];
    globals.Memory = {
      scanSync(_base: unknown, _size: number, pattern: string) {
        patterns.push(pattern);
        return [];
      },
    };

    scanText("가", { base: {}, size: 16 } as never, { utf16: true });

    expect(patterns).toEqual(["ea b0 80", "00 ac"]);
  });

  test("whole-process scanner honors utf16", () => {
    const text = "가나다라";
    const bytes = new Uint8Array(text.length * 2 + 2);
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      bytes[i * 2] = unit & 0xff;
      bytes[i * 2 + 1] = unit >>> 8;
    }
    const base = new FakePointer(bytes);
    globals.Process = { enumerateModules: () => [{ base, size: bytes.length }] };

    expect(strings(text)).toEqual([]);
    expect(strings(text, { utf16: true })).toEqual([{ address: "0x0", text }]);
  });

  test("utf16 scanner handles odd alignment and an unterminated final string", () => {
    const text = "테스트문자";
    const bytes = new Uint8Array(1 + text.length * 2);
    bytes[0] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      bytes[1 + i * 2] = unit & 0xff;
      bytes[2 + i * 2] = unit >>> 8;
    }
    const base = new FakePointer(bytes);
    globals.Process = { enumerateModules: () => [{ base, size: bytes.length }] };

    expect(strings(text, { utf16: true })).toEqual([{ address: "0x1", text }]);
  });
});
