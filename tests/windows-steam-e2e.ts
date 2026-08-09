// Opt-in Windows Steam compatibility run. Execute from an interactive desktop
// session only; the harness launches one owned game at a time, performs
// read-only Frida smoke/reattach checks, and closes only processes it started.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  ActionService,
  loadManifest,
  processNameMatches,
  startLaunch,
  startSession,
  type ActionReceipt,
  type GameSession,
  type RpcDescriptor,
} from "../src/core/index.js";

type GameStatus = "passed" | "failed" | "skipped";

interface SteamGame {
  appid: string;
  name: string;
  buildId: string;
  installPath: string;
}

interface InstallScan {
  antiCheatHits: string[];
  executables: string[];
  truncated: boolean;
}

interface ProcessInfo {
  pid: number;
  name: string;
  path: string;
  sessionId: number;
}

interface ProbeResult {
  pid: number;
  process: string;
  descriptorCount: number;
  engines: string;
  moduleRows: number;
  recordStatus: string;
  reattachDescriptorCount: number;
  logs: string[];
}

interface TargetResult {
  target: string;
  descriptorCount: number;
  reads: Record<string, string>;
  cleanupAction: string | null;
  cleanReattach: string;
}

interface GameResult {
  appid: string;
  name: string;
  buildId: string;
  installPath: string;
  status: GameStatus;
  reason?: string;
  launcher?: string;
  antiCheatHits: string[];
  process?: ProcessInfo;
  targetProcess?: ProcessInfo;
  probe?: ProbeResult;
  target?: TargetResult;
  cleanup?: { graceful: number; forced: number };
  elapsedMs: number;
}

interface QaReport {
  schema: "flab.windows-steam-e2e.v1";
  authorization: "owned-offline";
  host: string;
  sessionId: number;
  steamRoot: string;
  startedAt: string;
  completedAt?: string;
  games: GameResult[];
  totals: { installed: number; passed: number; failed: number; skipped: number };
}

const AUTHORIZATION = "owned-offline";
const REPORT_SCHEMA = "flab.windows-steam-e2e.v1" as const;
const OUTPUT_DIR = join(process.cwd(), "artifacts", "windows-steam-qa");
const REPORT_PATH = join(OUTPUT_DIR, "report.json");
const PROCESS_WAIT_MS = 60_000;
const PROCESS_STABLE_MS = 3_000;
const OPERATION_WAIT_MS = 30_000;
const FILE_SCAN_LIMIT = 250_000;
const LOG_LIMIT = 80;
const UNSAFE_APPS = new Map<string, string>([
  ["578080", "BattlEye-protected public game"],
  ["1677740", "public competitive online title; no isolated offline test path selected"],
]);
const PROCESS_STABLE_OVERRIDES = new Map<string, number>([
  // This Steam build replaces its initial Unity process after bootstrap.
  ["2756930", 10_000],
]);
const CLEANUP_SETTLE_OVERRIDES = new Map<string, number>([
  // The replacement process can appear after the bootstrap PID exits.
  ["2756930", 10_000],
]);
const LAUNCH_OVERRIDES = new Map<string, string>([
  ["977950", "A Dance of Fire and Ice.exe"],
  ["361420", "Astro\\Binaries\\Win64\\Astro-Win64-Shipping.exe"],
  ["1949740", "Banana Shooter.exe"],
  ["1890650", "CitywarsSavage.exe"],
  ["751780", "Forager.exe"],
  ["322170", "GeometryDash.exe"],
  ["477160", "Human.exe"],
  ["4704690", "PenguinHotel.exe"],
  ["1625450", "Muck.exe"],
  ["1623730", "Palworld.exe"],
  ["2756930", "PUMP IT UP RISE.exe"],
  ["648800", "Raft.exe"],
  ["774181", "Rhythm Doctor.exe"],
  ["2709570", "Supermarket Together.exe"],
  ["105600", "Terraria.exe"],
  ["641990", "TheEscapists2.exe"],
  ["2060160", "TheFarmerWasReplaced.exe"],
  ["242760", "TheForest.exe"],
  ["1281930", "start-tModLoader.bat"],
  ["3098890", "NewKaragon.exe"],
]);
const ANTI_CHEAT = /easy.?anti.?cheat|battleye|beclient|beservice|eac_launcher|start_protected_game|equ8|xigncode|nprotect|gameguard|vanguard|ricochet/i;
const HELPER_PROCESS = /crash|report|unitycrashhandler|epicwebhelper|cef|unins|setup|install|redist|server|busybox|quickedit|winmtr/i;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bounded(value: unknown, max = 4_096): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function quotedValue(text: string, key: string): string {
  return new RegExp(`"${key}"\\s+"([^"]*)"`, "i").exec(text)?.[1] ?? "";
}

function steamLibraries(steamRoot: string): string[] {
  const paths = new Map<string, string>();
  paths.set(steamRoot.toLowerCase(), steamRoot);
  const file = join(steamRoot, "steamapps", "libraryfolders.vdf");
  if (!existsSync(file)) return [...paths.values()];
  for (const match of readFileSync(file, "utf8").matchAll(/"path"\s+"([^"]+)"/gi)) {
    const candidate = match[1]!.replaceAll("\\\\", "\\");
    if (existsSync(candidate)) paths.set(candidate.toLowerCase(), candidate);
  }
  return [...paths.values()];
}

function installedGames(steamRoot: string): SteamGame[] {
  const games = new Map<string, SteamGame>();
  for (const library of steamLibraries(steamRoot)) {
    const steamapps = join(library, "steamapps");
    if (!existsSync(steamapps)) continue;
    for (const entry of readdirSync(steamapps)) {
      if (!/^appmanifest_\d+\.acf$/i.test(entry)) continue;
      const text = readFileSync(join(steamapps, entry), "utf8");
      const appid = quotedValue(text, "appid");
      const installDir = quotedValue(text, "installdir");
      const game: SteamGame = {
        appid,
        name: quotedValue(text, "name"),
        buildId: quotedValue(text, "buildid"),
        installPath: join(steamapps, "common", installDir),
      };
      if (appid && appid !== "228980" && installDir && existsSync(game.installPath)) games.set(appid, game);
    }
  }
  return [...games.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function scanInstall(root: string): InstallScan {
  const pending = [root];
  const antiCheatHits: string[] = [];
  const executables: string[] = [];
  let visited = 0;
  while (pending.length && visited < FILE_SCAN_LIMIT) {
    const current = pending.pop()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      const absolute = join(current, entry.name);
      const rel = relative(root, absolute).replaceAll("\\", "/");
      if (ANTI_CHEAT.test(rel) && antiCheatHits.length < 20) antiCheatHits.push(rel);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".exe") executables.push(absolute);
      if (visited >= FILE_SCAN_LIMIT) break;
    }
  }
  return { antiCheatHits, executables, truncated: pending.length > 0 };
}

function launchCandidate(game: SteamGame, scan: InstallScan): string | null {
  const override = LAUNCH_OVERRIDES.get(game.appid);
  if (override) {
    const exact = join(game.installPath, override);
    if (existsSync(exact)) return exact;
  }
  const normalized = game.name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return scan.executables
    .filter((candidate) => !HELPER_PROCESS.test(relative(game.installPath, candidate)))
    .sort((left, right) => {
      const score = (candidate: string): number => {
        const rel = relative(game.installPath, candidate);
        const depth = rel.split(/[\\/]/).length - 1;
        const base = basename(candidate, extname(candidate)).replace(/[^a-z0-9]/gi, "").toLowerCase();
        return depth * 100 - (base === normalized ? 80 : 0);
      };
      return score(left) - score(right) || left.localeCompare(right);
    })[0] ?? null;
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

async function processesUnder(root: string): Promise<ProcessInfo[]> {
  const output = await powershell([
    `$root=${psQuote(root)}`,
    "$items=@(Get-Process -ErrorAction SilentlyContinue|Where-Object{$_.Path -and $_.Path.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase)}|ForEach-Object{[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;path=$_.Path;sessionId=$_.SessionId}})",
    "[pscustomobject]@{items=$items}|ConvertTo-Json -Depth 4 -Compress",
  ].join(";"));
  const parsed = JSON.parse(output) as { items?: ProcessInfo | ProcessInfo[] | null };
  if (!parsed.items) return [];
  return Array.isArray(parsed.items) ? parsed.items : [parsed.items];
}

async function startGame(game: SteamGame, launcher: string): Promise<void> {
  await powershell(`Start-Process -FilePath ${psQuote(launcher)} -WorkingDirectory ${psQuote(game.installPath)}`);
}

async function startThroughSteam(steamRoot: string, game: SteamGame): Promise<void> {
  await powershell(`Start-Process -FilePath ${psQuote(join(steamRoot, "steam.exe"))} -ArgumentList '-applaunch',${psQuote(game.appid)}`);
}

function processScore(game: SteamGame, process: ProcessInfo): number {
  const rel = relative(game.installPath, process.path).replaceAll("\\", "/");
  let score = 0;
  if (HELPER_PROCESS.test(rel)) score += 10_000;
  if (/\/Binaries\/Win64\//i.test(`/${rel}`)) score -= 2_000;
  if (/Win64-Shipping\.exe$/i.test(rel)) score -= 1_000;
  if (/^(dotnet|tModLoader)$/i.test(process.name) && game.appid === "1281930") score -= 1_000;
  score += rel.split("/").length;
  return score;
}

async function waitForNewProcess(game: SteamGame, before: Set<number>, timeoutMs: number): Promise<ProcessInfo | null> {
  const started = Date.now();
  const stableMs = PROCESS_STABLE_OVERRIDES.get(game.appid) ?? PROCESS_STABLE_MS;
  let candidatePid = 0;
  let candidateSince = 0;
  while (Date.now() - started < timeoutMs) {
    const candidates = (await processesUnder(game.installPath))
      .filter((process) => !before.has(process.pid) && !HELPER_PROCESS.test(process.name))
      .sort((left, right) => processScore(game, left) - processScore(game, right));
    if (candidates.length) {
      const candidate = candidates[0]!;
      if (candidate.pid !== candidatePid) {
        candidatePid = candidate.pid;
        candidateSince = Date.now();
      }
      if (Date.now() - candidateSince >= stableMs) return candidate;
    } else {
      candidatePid = 0;
      candidateSince = 0;
    }
    await Bun.sleep(750);
  }
  return null;
}

async function ensureGameProcess(
  steamRoot: string,
  game: SteamGame,
  launcher: string,
  before: Set<number>,
  current?: ProcessInfo,
): Promise<ProcessInfo> {
  if (current) {
    const live = (await processesUnder(game.installPath)).find((process) => process.pid === current.pid);
    if (live) return live;
  }
  await startGame(game, launcher);
  let process = await waitForNewProcess(game, before, PROCESS_WAIT_MS / 2);
  if (!process) {
    await startThroughSteam(steamRoot, game);
    process = await waitForNewProcess(game, before, PROCESS_WAIT_MS / 2);
  }
  check(process, "game produced no attachable process after direct and Steam launch");
  return process;
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = OPERATION_WAIT_MS): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function invokeRead(actions: ActionService, session: GameSession, sessionId: number, action: string, rawArgs: string[] = []): Promise<ActionReceipt> {
  const receipt = await withTimeout(action, actions.invoke(session, { sessionId, mode: "analysis", action, rawArgs }));
  check(receipt.status === "passed", `${action} failed: ${receipt.error?.message ?? receipt.result.summary}`);
  return receipt;
}

function sessionEvents(logs: string[]): Parameters<typeof startLaunch>[1] {
  const append = (line: string): void => {
    if (logs.length < LOG_LIMIT) logs.push(bounded(line, 1_000));
  };
  return {
    onLog: append,
    onError: (line) => append(`ERROR ${line}`),
    onClose: (reason) => append(`CLOSE ${reason}`),
    onEvent: (event) => append(`EVENT ${bounded(event, 1_000)}`),
  };
}

async function probeGame(process: ProcessInfo): Promise<ProbeResult> {
  const logs: string[] = [];
  let session: GameSession | null = null;
  try {
    session = await withTimeout("generic attach", startLaunch(
      { kind: "probe-attach-pid", pid: process.pid, display: basename(process.path), device: { kind: "local" } },
      sessionEvents(logs),
    ));
    const descriptors = await withTimeout("generic describe", session.describe());
    for (const required of ["engines", "modules", "recordPlan", "recordStart", "recordStatus", "recordStop"]) {
      check(descriptors.some((descriptor) => descriptor.name === required), `generic descriptor ${required} missing`);
    }
    const actions = new ActionService();
    const engines = await invokeRead(actions, session, 1, "engines");
    const modules = await invokeRead(actions, session, 1, "modules", [""]);
    const recordStatus = await invokeRead(actions, session, 1, "recordStatus");
    await withTimeout("generic close", session.close());
    session = null;
    await Bun.sleep(300);

    session = await withTimeout("generic reattach", startLaunch(
      { kind: "probe-attach-pid", pid: process.pid, display: basename(process.path), device: { kind: "local" } },
      sessionEvents(logs),
    ));
    const reattachDescriptors = await withTimeout("generic reattach describe", session.describe());
    await invokeRead(actions, session, 2, "engines");
    await withTimeout("generic reattach close", session.close());
    session = null;
    return {
      pid: process.pid,
      process: basename(process.path),
      descriptorCount: descriptors.length,
      engines: bounded(engines.result.rows),
      moduleRows: modules.result.totalRows,
      recordStatus: bounded(recordStatus.result.summary),
      reattachDescriptorCount: reattachDescriptors.length,
      logs,
    };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

function targetFor(process: ProcessInfo): string | null {
  const manifest = loadManifest();
  const running = basename(process.path);
  return Object.entries(manifest.targets)
    .find(([, config]) => !config.device && processNameMatches(config.process, running))?.[0] ?? null;
}

function callableRead(descriptors: readonly RpcDescriptor[], action: string): RpcDescriptor {
  const descriptor = descriptors.find((candidate) => candidate.name === action);
  check(descriptor, `target descriptor ${action} missing`);
  check(descriptor.effect === "read" && descriptor.capabilities?.includes("analysis"), `${action} is not an Analysis read`);
  check((descriptor.args ?? []).every((arg) => arg.optional || arg.type?.endsWith("?")), `${action} requires arguments`);
  return descriptor;
}

async function probeTarget(target: string, process: ProcessInfo): Promise<TargetResult> {
  const logs: string[] = [];
  let session: GameSession | null = null;
  try {
    session = await withTimeout("target attach", startSession({
      target,
      attachPid: process.pid,
      processDisplay: basename(process.path),
      device: { kind: "local" },
      noWatch: true,
    }, sessionEvents(logs)));
    const descriptors = await withTimeout("target describe", session.describe());
    const actions = new ActionService();
    const reads: Record<string, string> = {};
    for (const action of ["modInfo", "modHelp", "modState", "recordStatus"]) {
      callableRead(descriptors, action);
      reads[action] = bounded((await invokeRead(actions, session, 10, action)).result.summary);
    }
    const cleanup = descriptors.find((descriptor) =>
      (descriptor.name === "resetAll" || descriptor.name === "dispose") &&
      descriptor.capabilities?.includes("instrument") &&
      (descriptor.args ?? []).every((arg) => arg.optional || arg.type?.endsWith("?")));
    if (cleanup) {
      const receipt = await withTimeout(cleanup.name, actions.invoke(session, {
        sessionId: 10,
        mode: "instrument",
        action: cleanup.name,
        rawArgs: [],
      }));
      check(receipt.status === "passed", `${cleanup.name} failed: ${receipt.error?.message ?? receipt.result.summary}`);
    }
    await withTimeout("target close", session.close());
    session = null;
    await Bun.sleep(300);

    session = await withTimeout("target reattach", startSession({
      target,
      attachPid: process.pid,
      processDisplay: basename(process.path),
      device: { kind: "local" },
      noWatch: true,
    }, sessionEvents(logs)));
    const cleanReattach = bounded((await invokeRead(actions, session, 11, "modState")).result.summary);
    await withTimeout("target reattach close", session.close());
    session = null;
    return {
      target,
      descriptorCount: descriptors.length,
      reads,
      cleanupAction: cleanup?.name ?? null,
      cleanReattach,
    };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

async function cleanupGame(game: SteamGame, before: Set<number>): Promise<{ graceful: number; forced: number }> {
  const current = (await processesUnder(game.installPath)).filter((process) => !before.has(process.pid));
  let graceful = 0;
  let forced = 0;
  if (current.length) {
    const ids = current.map((process) => process.pid).join(",");
    graceful = Number(await powershell(`$ids=@(${ids});$count=0;foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p -and $p.Path.StartsWith(${psQuote(game.installPath)},[System.StringComparison]::OrdinalIgnoreCase)){if($p.CloseMainWindow()){$count++}}};$count`));
    await Bun.sleep(5_000);
    forced = Number(await powershell(`$ids=@(${ids});$count=0;foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p -and $p.Path.StartsWith(${psQuote(game.installPath)},[System.StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $id -Force;$count++}};$count`));
  }
  const settleMs = CLEANUP_SETTLE_OVERRIDES.get(game.appid) ?? 0;
  const settleStarted = Date.now();
  while (Date.now() - settleStarted < settleMs) {
    await Bun.sleep(1_000);
    const late = (await processesUnder(game.installPath)).filter((process) => !before.has(process.pid));
    if (!late.length) continue;
    const lateIds = late.map((process) => process.pid).join(",");
    forced += Number(await powershell(`$ids=@(${lateIds});$count=0;foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p -and $p.Path.StartsWith(${psQuote(game.installPath)},[System.StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $id -Force;$count++}};$count`));
  }
  return { graceful, forced };
}

function writeReport(report: QaReport): void {
  report.totals = {
    installed: report.games.length,
    passed: report.games.filter((game) => game.status === "passed").length,
    failed: report.games.filter((game) => game.status === "failed").length,
    skipped: report.games.filter((game) => game.status === "skipped").length,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<QaReport> {
  check(process.platform === "win32", "windows-steam-e2e requires Windows");
  check(process.env.FLAB_STEAM_E2E_AUTHORIZATION === AUTHORIZATION,
    "set FLAB_STEAM_E2E_AUTHORIZATION=owned-offline after confirming every tested install is yours");
  const steamRoot = process.env.FLAB_STEAM_ROOT ?? "C:\\Program Files (x86)\\Steam";
  check(existsSync(join(steamRoot, "steamapps")), `Steam root not found: ${steamRoot}`);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const games = installedGames(steamRoot);
  const include = new Set((process.env.FLAB_STEAM_E2E_INCLUDE ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const report: QaReport = {
    schema: REPORT_SCHEMA,
    authorization: AUTHORIZATION,
    host: process.env.COMPUTERNAME ?? "windows",
    sessionId: await currentSessionId(),
    steamRoot,
    startedAt: new Date().toISOString(),
    games: [],
    totals: { installed: games.length, passed: 0, failed: 0, skipped: 0 },
  };
  check(report.sessionId !== 0, "run windows-steam-e2e inside the logged-in interactive desktop session, not SSH Session 0");

  for (const game of games) {
    const started = Date.now();
    const result: GameResult = {
      ...game,
      status: "failed",
      antiCheatHits: [],
      elapsedMs: 0,
    };
    let before = new Set<number>();
    try {
      if (include.size && !include.has(game.appid)) {
        result.status = "skipped";
        result.reason = "not selected by FLAB_STEAM_E2E_INCLUDE";
        continue;
      }
      const scan = scanInstall(game.installPath);
      result.antiCheatHits = scan.antiCheatHits;
      const unsafe = UNSAFE_APPS.get(game.appid);
      if (unsafe) {
        result.status = "skipped";
        result.reason = scan.antiCheatHits.length ? `${unsafe}; local anti-cheat components detected` : unsafe;
        continue;
      }
      if (scan.truncated) {
        result.status = "skipped";
        result.reason = `install scan exceeded ${FILE_SCAN_LIMIT} entries`;
        continue;
      }
      if (scan.antiCheatHits.length) {
        result.status = "skipped";
        result.reason = "local anti-cheat components detected";
        continue;
      }
      const launcher = launchCandidate(game, scan);
      if (!launcher) {
        result.status = "failed";
        result.reason = "no launch candidate found";
        continue;
      }
      result.launcher = launcher;
      const existing = await processesUnder(game.installPath);
      before = new Set(existing.map((process) => process.pid));
      if (existing.length) {
        result.status = "skipped";
        result.reason = `pre-existing game process protected (${existing.map((process) => process.pid).join(", ")})`;
        continue;
      }
      let process = await ensureGameProcess(steamRoot, game, launcher, before);
      check(process.sessionId === report.sessionId, `game session ${process.sessionId} differs from harness session ${report.sessionId}`);
      result.process = process;
      const target = targetFor(process);
      if (target) {
        result.targetProcess = process;
        result.target = await probeTarget(target, process);
        process = await ensureGameProcess(steamRoot, game, launcher, before, process);
        check(process.sessionId === report.sessionId, `game session ${process.sessionId} differs from harness session ${report.sessionId}`);
        result.process = process;
      }
      result.probe = await probeGame(process);
      result.status = "passed";
    } catch (error) {
      result.status = "failed";
      result.reason = error instanceof Error ? error.stack ?? error.message : String(error);
    } finally {
      if (result.launcher && result.reason !== "pre-existing game process protected") {
        try {
          result.cleanup = await cleanupGame(game, before);
        } catch (error) {
          result.status = "failed";
          result.reason = `${result.reason ? `${result.reason}\n` : ""}cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      result.elapsedMs = Date.now() - started;
      report.games.push(result);
      writeReport(report);
      console.log(JSON.stringify({ appid: game.appid, name: game.name, status: result.status, reason: result.reason, elapsedMs: result.elapsedMs }));
    }
  }
  report.completedAt = new Date().toISOString();
  writeReport(report);
  return report;
}

try {
  const report = await main();
  console.log(JSON.stringify({ ok: report.totals.failed === 0, report: REPORT_PATH, totals: report.totals }));
  process.exit(report.totals.failed === 0 ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
