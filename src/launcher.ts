// flab launcher — a tiny compiled wrapper that finds bun and runs the real
// CLI. Frida's native binding can't be bundled into a bun-compiled binary,
// so the binary is a launcher, not the whole tool.
//
// Resolution order:
//   1. `bun` on PATH
//   2. ~/.bun/bin/bun
//   3. Auto-install via https://bun.sh (user confirms first)
//
// Everything else (commands, TUI, session engine) lives in src/ and is
// executed by bun with full node_modules access.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

// In a compiled binary import.meta.url points into the bunfs bundle; use
// the executable's real location instead.
const exeDir = dirname(process.execPath);
const srcBin = join(exeDir, "src", "bin.ts");

if (!existsSync(srcBin)) {
  console.error(`flab: src/bin.ts not found next to the binary (looked at ${srcBin}).`);
  console.error("The flab binary is a launcher — keep it in the repo root (or an unpacked release with src/ intact).");
  process.exit(1);
}

function findBun(): string | null {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split("\n")[0]!;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const local = join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  return existsSync(local) ? local : null;
}

function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

const bun = findBun();
if (!bun) {
  console.error("flab needs the bun runtime (Frida's native binding can't be statically bundled).");
  const a = await ask("install bun now via https://bun.sh? [y/N] ");
  if (a.trim().toLowerCase() === "y") {
    const cmd = process.platform === "win32"
      ? "powershell -c \"irm bun.sh/install.ps1 | iex\""
      : "curl -fsSL https://bun.sh/install | bash";
    spawnSync(cmd, { stdio: "inherit", shell: true });
    const retry = findBun();
    if (!retry) { console.error("bun installed but not on PATH — restart your shell and retry."); process.exit(1); }
    process.exit(spawnSync(retry, [srcBin, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 0);
  }
  process.exit(1);
}

process.exit(spawnSync(bun, [srcBin, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 0);
