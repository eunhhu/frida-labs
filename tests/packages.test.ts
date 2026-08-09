import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInstrumentPackage,
  inspectInstrumentPackage,
  INSTRUMENT_PACKAGE_SCHEMA,
} from "../src/core/index.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flab-package-"));
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

test("Instrument packages are deterministic, portable, and checksummed", async () => {
  const root = fixture();
  try {
    const compile = async () => "rpc.exports = { ping() { return 'pong'; } };\n";
    const first = await buildInstrumentPackage("fixture", { root, compile });
    const firstText = readFileSync(join(root, first.path), "utf8");
    const second = await buildInstrumentPackage("fixture", { root, compile });
    const secondText = readFileSync(join(root, second.path), "utf8");

    expect(first.path).toBe("dist/instruments/fixture.flab.json");
    expect(first.sha256).toBe(second.sha256);
    expect(firstText).toBe(secondText);
    expect(inspectInstrumentPackage(firstText)).toMatchObject({
      schema: INSTRUMENT_PACKAGE_SCHEMA,
      instrument: { name: "fixture" },
      bundle: { format: "frida-agent-javascript" },
    });

    const tampered = firstText.replace("Fixture.exe", "Other.exe");
    expect(() => inspectInstrumentPackage(tampered)).toThrow("integrity mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Instrument package output cannot escape the workspace", async () => {
  const root = fixture();
  try {
    await expect(buildInstrumentPackage("fixture", {
      root,
      out: "../escaped.flab.json",
      compile: async () => "bundle",
    })).rejects.toThrow("escapes the workspace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
