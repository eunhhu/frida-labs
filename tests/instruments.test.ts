import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importPath,
  libReference,
  linkInstrumentModule,
  readInstrumentSource,
  writeInstrumentSource,
} from "../src/core/index.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flab-instrument-"));
  mkdirSync(join(root, "agent", "targets", "fixture"), { recursive: true });
  writeFileSync(join(root, "agent", "targets", "fixture", "index.ts"), "rpc.exports = {};\n");
  writeFileSync(join(root, "frida-labs.json"), JSON.stringify({
    targets: {
      fixture: {
        process: "Fixture.exe",
        mode: "attach",
        entry: "agent/targets/fixture/index.ts",
      },
    },
  }));
  return root;
}

test("Instrument source writes use optimistic hashes", () => {
  const root = fixture();
  try {
    const current = readInstrumentSource("fixture", root);
    const next = writeInstrumentSource("fixture", "rpc.exports = { ping() { return true; } };\n", current.sha256, root);
    expect(next.sha256).not.toBe(current.sha256);
    expect(next.text).toContain("ping");
    expect(() => writeInstrumentSource("fixture", "stale", current.sha256, root)).toThrow("source changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("module links are valid, idempotent agent/lib imports", () => {
  const root = fixture();
  try {
    const selected = libReference().find((module) => module.module === "assist")!;
    expect(importPath(selected)).toBe("../../lib/assist.js");
    const first = linkInstrumentModule("fixture", "assist", undefined, root);
    const second = linkInstrumentModule("fixture", "assist", first.sha256, root);
    expect(first.alreadyLinked).toBe(false);
    expect(second.alreadyLinked).toBe(true);
    expect(second.text.match(/flab:module assist/g)).toHaveLength(1);
    expect(second.text).toContain('from "../../lib/assist.js"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
