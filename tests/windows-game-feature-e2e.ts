// Opt-in, scenario-driven Windows game feature runner. It must execute inside
// the logged-in desktop session so Frida and the game share one Windows
// session. Unlike windows-steam-e2e.ts, this runner invokes target actions and
// keeps their receipts as semantic evidence.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ActionService,
  startSession,
  type ActionMode,
  type ActionReceipt,
  type GameSession,
} from "../src/core/index.js";

interface ProcessInfo {
  pid: number;
  name: string;
  path: string;
  sessionId: number;
}

interface ScenarioStep {
  action: string;
  mode: ActionMode;
  rawArgs?: string[];
  waitAfterMs?: number;
}

interface ScenarioReport {
  schema: "flab.windows-game-feature-e2e.v1";
  authorization: "owned-offline";
  target: string;
  launcher: string;
  host: string;
  sessionId: number;
  startedAt: string;
  completedAt?: string;
  process?: ProcessInfo;
  descriptors?: string[];
  receipts: ActionReceipt[];
  logs: string[];
  cleanReattach?: unknown;
  ok: boolean;
  error?: string;
}

const AUTHORIZATION = "owned-offline";
const WAIT_MS = 60_000;
const STABLE_MS = 3_000;
const LOG_LIMIT = 200;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bounded(value: unknown, max = 4_096): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function powershell(script: string): Promise<string> {
  const source = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';${script}`;
  const child = Bun.spawn([
    "powershell.exe", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text",
    "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64"),
  ], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`PowerShell failed (${exit}): ${bounded(stderr || stdout)}`);
  return stdout.replace(/^#< CLIXML\s*/u, "").trim();
}

async function currentSessionId(): Promise<number> {
  return Number(await powershell("(Get-Process -Id $PID).SessionId"));
}

async function exactProcesses(launcher: string): Promise<ProcessInfo[]> {
  const output = await powershell([
    `$launcher=${psQuote(launcher)}`,
    "$items=@(Get-Process -ErrorAction SilentlyContinue|Where-Object{$_.Path -and $_.Path.Equals($launcher,[System.StringComparison]::OrdinalIgnoreCase)}|ForEach-Object{[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;path=$_.Path;sessionId=$_.SessionId}})",
    "[pscustomobject]@{items=$items}|ConvertTo-Json -Depth 4 -Compress",
  ].join(";"));
  const parsed = JSON.parse(output) as { items?: ProcessInfo | ProcessInfo[] | null };
  if (!parsed.items) return [];
  return Array.isArray(parsed.items) ? parsed.items : [parsed.items];
}

async function waitForProcess(launcher: string, before: Set<number>): Promise<ProcessInfo> {
  const started = Date.now();
  let candidate = 0;
  let candidateSince = 0;
  while (Date.now() - started < WAIT_MS) {
    const live = (await exactProcesses(launcher)).filter((process) => !before.has(process.pid));
    if (live.length) {
      const current = live[0]!;
      if (candidate !== current.pid) {
        candidate = current.pid;
        candidateSince = Date.now();
      }
      if (Date.now() - candidateSince >= STABLE_MS) return current;
    } else {
      candidate = 0;
      candidateSince = 0;
    }
    await Bun.sleep(500);
  }
  throw new Error(`game produced no stable process within ${WAIT_MS}ms`);
}

async function closeStarted(launcher: string, before: Set<number>): Promise<void> {
  const ids = (await exactProcesses(launcher)).filter((process) => !before.has(process.pid)).map((process) => process.pid);
  if (!ids.length) return;
  await powershell(`$ids=@(${ids.join(",")});foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p -and $p.Path.Equals(${psQuote(launcher)},[System.StringComparison]::OrdinalIgnoreCase)){if(-not $p.CloseMainWindow()){Stop-Process -Id $id -Force}}}`);
  await Bun.sleep(3_000);
  const remaining = (await exactProcesses(launcher)).filter((process) => !before.has(process.pid)).map((process) => process.pid);
  if (remaining.length) {
    await powershell(`$ids=@(${remaining.join(",")});foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p -and $p.Path.Equals(${psQuote(launcher)},[System.StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $id -Force}}`);
  }
}

function parseSteps(raw: string): ScenarioStep[] {
  const value = JSON.parse(raw) as unknown;
  check(Array.isArray(value) && value.length > 0 && value.length <= 100, "FLAB_FEATURE_E2E_STEPS must contain 1..100 steps");
  return value.map((candidate, index) => {
    check(candidate && typeof candidate === "object" && !Array.isArray(candidate), `step ${index} must be an object`);
    const record = candidate as Record<string, unknown>;
    check(typeof record.action === "string" && record.action.length > 0, `step ${index} action is required`);
    check(record.mode === "analysis" || record.mode === "debug" || record.mode === "instrument", `step ${index} mode is invalid`);
    const rawArgs = record.rawArgs ?? [];
    check(Array.isArray(rawArgs) && rawArgs.every((arg) => typeof arg === "string"), `step ${index} rawArgs must be strings`);
    const waitAfterMs = record.waitAfterMs ?? 0;
    check(Number.isInteger(waitAfterMs) && Number(waitAfterMs) >= 0 && Number(waitAfterMs) <= 30_000, `step ${index} waitAfterMs is invalid`);
    return { action: record.action, mode: record.mode, rawArgs, waitAfterMs: Number(waitAfterMs) };
  });
}

function events(logs: string[]): Parameters<typeof startSession>[1] {
  const add = (line: string): void => {
    if (logs.length < LOG_LIMIT) logs.push(bounded(line, 1_000));
  };
  return {
    onLog: add,
    onError: (line) => add(`ERROR ${line}`),
    onClose: (reason) => add(`CLOSE ${reason}`),
    onEvent: (event) => add(`EVENT ${bounded(event, 1_000)}`),
  };
}

async function attach(target: string, process: ProcessInfo, logs: string[]): Promise<GameSession> {
  return startSession({
    target,
    attachPid: process.pid,
    processDisplay: basename(process.path),
    device: { kind: "local" },
    noWatch: true,
  }, events(logs));
}

async function main(): Promise<ScenarioReport> {
  check(process.platform === "win32", "windows-game-feature-e2e requires Windows");
  check(process.env.FLAB_STEAM_E2E_AUTHORIZATION === AUTHORIZATION,
    "set FLAB_STEAM_E2E_AUTHORIZATION=owned-offline after confirming this test instance is yours and offline");
  const target = process.env.FLAB_FEATURE_E2E_TARGET?.trim() ?? "";
  const launcher = process.env.FLAB_FEATURE_E2E_LAUNCHER?.trim() ?? "";
  const steps = parseSteps(process.env.FLAB_FEATURE_E2E_STEPS ?? "");
  check(target, "FLAB_FEATURE_E2E_TARGET is required");
  check(launcher && existsSync(launcher), "FLAB_FEATURE_E2E_LAUNCHER must be an existing executable");
  const output = process.env.FLAB_FEATURE_E2E_OUTPUT?.trim()
    || join(process.cwd(), "artifacts", "windows-steam-qa", `${target}-feature-e2e.json`);
  mkdirSync(dirname(output), { recursive: true });
  const report: ScenarioReport = {
    schema: "flab.windows-game-feature-e2e.v1",
    authorization: AUTHORIZATION,
    target,
    launcher,
    host: process.env.COMPUTERNAME ?? "windows",
    sessionId: await currentSessionId(),
    startedAt: new Date().toISOString(),
    receipts: [],
    logs: [],
    ok: false,
  };
  check(report.sessionId !== 0, "run inside the logged-in interactive Windows session");
  const before = new Set((await exactProcesses(launcher)).map((process) => process.pid));
  check(before.size === 0, "pre-existing target process protected");
  let session: GameSession | null = null;
  try {
    await powershell(`Start-Process -FilePath ${psQuote(launcher)} -WorkingDirectory ${psQuote(dirname(launcher))}`);
    const live = await waitForProcess(launcher, before);
    check(live.sessionId === report.sessionId, `game session ${live.sessionId} differs from runner session ${report.sessionId}`);
    report.process = live;
    session = await attach(target, live, report.logs);
    report.descriptors = (await session.describe()).map((descriptor) => descriptor.name);
    const actions = new ActionService();
    let sessionId = 1;
    for (const step of steps) {
      const receipt = await actions.invoke(session, {
        sessionId,
        mode: step.mode,
        action: step.action,
        rawArgs: step.rawArgs ?? [],
      });
      report.receipts.push(receipt);
      check(receipt.status === "passed", `${step.action} failed: ${receipt.error?.message ?? receipt.result.summary}`);
      if (step.waitAfterMs) await Bun.sleep(step.waitAfterMs);
    }
    await session.close();
    session = null;
    await Bun.sleep(300);
    session = await attach(target, live, report.logs);
    report.cleanReattach = await session.call("modState", []);
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    if (session) await session.close().catch(() => {});
    await closeStarted(launcher, before).catch((error) => {
      report.ok = false;
      report.error = `${report.error ? `${report.error}\n` : ""}cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    });
    report.completedAt = new Date().toISOString();
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

const report = await main();
console.log(JSON.stringify({ ok: report.ok, target: report.target, output: process.env.FLAB_FEATURE_E2E_OUTPUT, error: report.error }));
process.exit(report.ok ? 0 : 1);
