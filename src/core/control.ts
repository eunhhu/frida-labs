// Vendor-neutral Agent Control API. This is a first-class product boundary,
// not TUI automation: every operation is typed NDJSON and delegates to the
// same core services used by human frontends.

import { createHash } from "node:crypto";
import { ActionService, type ActionMode, type ActionReceipt } from "./actions.js";
import { compileAgent } from "./compile.js";
import { depcheck, type DepcheckReport } from "./depcheck.js";
import {
  discoverDevices,
  normalizeDeviceSelector,
  type DeviceChoice,
  type DeviceSelector,
} from "./devices.js";
import { libReference, type LibModule } from "./libref.js";
import {
  linkInstrumentModule,
  readInstrumentSource,
  writeInstrumentSource,
  type InstrumentSource,
} from "./instruments.js";
import { loadManifest, repoRoot } from "./manifest.js";
import { buildInstrumentPackage, type InstrumentPackageResult } from "./packages.js";
import { RecordingCoordinator } from "./records.js";
import { discoverProcessSnapshot, type ProcessDiscovery } from "./processes.js";
import {
  currentProjectService,
  ProjectError,
  type ProjectService,
  type TargetCreate,
  type TargetPatch,
} from "./projects.js";
import {
  resolveLaunchRequest,
  startLaunch,
  type GameSession,
  type LaunchRequest,
  type RpcDescriptor,
  type SessionEvents,
} from "./session.js";

export const CONTROL_PROTOCOL = "flab.control.v1";
export const CONTROL_LINE_MAX_BYTES = 4 * 1024 * 1024;

export type AuthorizationEnvironment = "owned-offline" | "private-lab";
export type AuthorizationPurpose = "analysis" | "mod-development" | "accessibility" | "qa" | "education";

export interface ControlAuthorizationProfile {
  purpose: AuthorizationPurpose;
  objective: string;
  environment: AuthorizationEnvironment;
  ownership: {
    clientOwned: boolean;
    serverOwned?: boolean;
    operatorApproved: boolean;
    participantsConsented?: boolean;
  };
  isolation: {
    publicMatchmaking: false;
    publicLeaderboard: false;
    productionEconomy: false;
    thirdPartyAccounts: false;
  };
  antiCheat: "absent" | "officially-disabled";
}

export interface ControlRequest {
  id: string | number;
  op: string;
  [key: string]: unknown;
}

export type ControlResponse =
  | { type: "response"; id: string | number; ok: true; result: unknown }
  | { type: "response"; id: string | number | null; ok: false; error: { code: string; message: string }; receipt?: ActionReceipt };

export type ControlEvent =
  | { type: "event"; event: "session.log" | "session.error"; message: string }
  | { type: "event"; event: "session.detached"; reason: string }
  | { type: "event"; event: "agent.payload"; payload: Record<string, unknown> };

type ParseControlResult =
  | { ok: true; request: ControlRequest }
  | { ok: false; id: string | number | null; code: string; message: string };

export interface ControlDependencies {
  projects: ProjectService;
  compile(name: string): Promise<string>;
  package(name: string, out?: string): Promise<InstrumentPackageResult>;
  sourceRead(name: string): InstrumentSource;
  sourceWrite(name: string, text: string, expectedSha256?: string): InstrumentSource;
  moduleLink(name: string, module: string, expectedSha256?: string): InstrumentSource & {
    module: string;
    alias: string;
    import: string;
    alreadyLinked: boolean;
  };
  modules(): LibModule[];
  verify(): DepcheckReport;
  devices(): Promise<DeviceChoice[]>;
  processes(options: { query?: string; limit?: number; device?: DeviceSelector }): Promise<ProcessDiscovery>;
  launch(request: LaunchRequest, events: SessionEvents): Promise<GameSession>;
}

export interface ControlServiceOptions {
  dependencies?: Partial<ControlDependencies>;
  onEvent?: (event: ControlEvent) => void;
  recordings?: RecordingCoordinator;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestId(value: unknown): string | number | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  const field = Object.keys(value).find((key) => !allowed.includes(key));
  if (field) throw new ControlError("unknown-field", `unsupported request field ${JSON.stringify(field)}`);
}

function requiredString(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ControlError("invalid-request", `${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function requiredSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new ControlError("invalid-request", "expectedSha256 must be a 64-character hexadecimal SHA-256 digest");
  }
  return value.toLowerCase();
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!record(value)) throw new ControlError("invalid-request", `${field} must be an object`);
  return value;
}

function optionalDevice(value: unknown): DeviceSelector | undefined {
  if (value === undefined) return undefined;
  try { return normalizeDeviceSelector(value); }
  catch (error) { throw new ControlError("invalid-request", (error as Error).message); }
}

export class ControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControlError";
  }
}

export function parseControlRequestLine(line: string): ParseControlResult {
  if (new TextEncoder().encode(line).byteLength > CONTROL_LINE_MAX_BYTES) {
    return { ok: false, id: null, code: "line-too-large", message: `request line exceeds ${CONTROL_LINE_MAX_BYTES} bytes` };
  }
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { return { ok: false, id: null, code: "invalid-json", message: "request must be one JSON object per line" }; }
  if (!record(value)) return { ok: false, id: null, code: "invalid-request", message: "request must be a JSON object" };
  const id = requestId(value.id);
  if (id === null) return { ok: false, id: null, code: "invalid-id", message: "id must be a non-empty string or safe integer" };
  if (typeof value.op !== "string" || value.op.length === 0 || value.op.length > 128) {
    return { ok: false, id, code: "invalid-operation", message: "op must be a non-empty string up to 128 characters" };
  }
  return { ok: true, request: value as ControlRequest };
}

function authorizationProfile(value: unknown): ControlAuthorizationProfile {
  const profile = requiredRecord(value, "profile");
  exact(profile, ["purpose", "objective", "environment", "ownership", "isolation", "antiCheat"]);
  const purposes: AuthorizationPurpose[] = ["analysis", "mod-development", "accessibility", "qa", "education"];
  if (!purposes.includes(profile.purpose as AuthorizationPurpose)) {
    throw new ControlError("invalid-authorization", `purpose must be ${purposes.join(", ")}`);
  }
  const objective = requiredString(profile.objective, "objective", 1000);
  if (profile.environment !== "owned-offline" && profile.environment !== "private-lab") {
    throw new ControlError("invalid-authorization", "environment must be owned-offline or private-lab");
  }
  const ownership = requiredRecord(profile.ownership, "ownership");
  exact(ownership, ["clientOwned", "serverOwned", "operatorApproved", "participantsConsented"]);
  if (ownership.clientOwned !== true || ownership.operatorApproved !== true) {
    throw new ControlError("authorization-denied", "the client must be owned and the operator must explicitly approve testing");
  }
  if (profile.environment === "private-lab" && (ownership.serverOwned !== true || ownership.participantsConsented !== true)) {
    throw new ControlError("authorization-denied", "private-lab requires an owned server and consent from every participant");
  }
  const isolation = requiredRecord(profile.isolation, "isolation");
  exact(isolation, ["publicMatchmaking", "publicLeaderboard", "productionEconomy", "thirdPartyAccounts"]);
  for (const field of ["publicMatchmaking", "publicLeaderboard", "productionEconomy", "thirdPartyAccounts"] as const) {
    if (isolation[field] !== false) throw new ControlError("authorization-denied", `${field} must be false`);
  }
  if (profile.antiCheat !== "absent" && profile.antiCheat !== "officially-disabled") {
    throw new ControlError("authorization-denied", "antiCheat must be absent or officially-disabled; bypass is not supported");
  }
  return {
    purpose: profile.purpose as AuthorizationPurpose,
    objective,
    environment: profile.environment,
    ownership: {
      clientOwned: true,
      operatorApproved: true,
      ...(ownership.serverOwned === true ? { serverOwned: true } : {}),
      ...(ownership.participantsConsented === true ? { participantsConsented: true } : {}),
    },
    isolation: {
      publicMatchmaking: false,
      publicLeaderboard: false,
      productionEconomy: false,
      thirdPartyAccounts: false,
    },
    antiCheat: profile.antiCheat,
  };
}

export function controlCapabilities(): Record<string, unknown> {
  return {
    protocol: CONTROL_PROTOCOL,
    transport: "newline-delimited JSON on stdin/stdout; diagnostics and session logs on stderr",
    workflow: ["authorize", "connect", "analyze", "record", "instrument", "build", "verify", "package"],
    authorization: {
      environments: ["owned-offline", "private-lab"],
      antiCheat: ["absent", "officially-disabled"],
      excluded: ["public matchmaking", "public leaderboards", "production economies", "third-party accounts", "anti-cheat bypass"],
    },
    operations: [
      "ping", "capabilities", "authorize", "workspace.describe",
      "device.list", "process.list", "module.list",
      "instrument.list", "instrument.create", "instrument.update", "instrument.rename",
      "instrument.unregister", "instrument.delete", "instrument.build", "instrument.package",
      "instrument.source.read", "instrument.source.write", "module.link",
      "verify.static", "session.open", "session.describe", "session.action", "session.close", "close",
      "record.plan", "record.start", "record.status", "record.stop", "record.list", "record.read", "record.summary",
    ],
    interfaces: {
      human: "flab TUI: Connect → Analyze → Instrument controls + linked live state",
      agent: "flab agent --json",
      acp: "flab acp: auto-detected ACP agent + injected flab MCP tools",
      mcp: "flab mcp: two-tool bridge for any MCP-capable harness",
      live: "descriptor-driven session actions shared with the TUI",
    },
    descriptorUi: {
      controls: ["input", "checkbox", "slider", "select"],
      state: "statusAction or zero-argument modState",
      help: "host-generated .help, /help, and :help",
      invariant: "stable action names and positional arguments remain identical for agents",
    },
  };
}

function defaultDependencies(): ControlDependencies {
  return {
    projects: currentProjectService(),
    compile: compileAgent,
    package: (name, out) => buildInstrumentPackage(name, { out }),
    sourceRead: readInstrumentSource,
    sourceWrite: writeInstrumentSource,
    moduleLink: linkInstrumentModule,
    modules: libReference,
    verify: depcheck,
    devices: discoverDevices,
    processes: discoverProcessSnapshot,
    launch: startLaunch,
  };
}

function projectError(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  if (error instanceof ProjectError) return new ControlError(`project.${error.code}`, error.message);
  return new ControlError("operation-failed", error instanceof Error ? error.message : String(error));
}

function successful(id: string | number, result: unknown): ControlResponse {
  return { type: "response", id, ok: true, result };
}

function failed(id: string | number | null, error: unknown): ControlResponse {
  const problem = projectError(error);
  return { type: "response", id, ok: false, error: { code: problem.code, message: problem.message } };
}

export class ControlService {
  private readonly deps: ControlDependencies;
  private readonly onEvent: (event: ControlEvent) => void;
  private readonly actions = new ActionService();
  private authorization: ControlAuthorizationProfile | null = null;
  private session: GameSession | null = null;
  private sessionId = 0;
  private detached = false;
  private recordings?: RecordingCoordinator;

  constructor(options: ControlServiceOptions = {}) {
    const defaults = defaultDependencies();
    this.deps = { ...defaults, ...options.dependencies };
    this.onEvent = options.onEvent ?? (() => {});
    this.recordings = options.recordings;
  }

  private recordingService(): RecordingCoordinator {
    return this.recordings ??= new RecordingCoordinator();
  }

  private requireAuthorization(): ControlAuthorizationProfile {
    if (!this.authorization) {
      throw new ControlError("authorization-required", "authorize the owned offline or isolated private-lab environment first");
    }
    return this.authorization;
  }

  private requireSession(): GameSession {
    if (!this.session || this.detached) throw new ControlError("session-required", "open a live session first");
    return this.session;
  }

  private async closeSession(): Promise<{ closed: boolean }> {
    const current = this.session;
    this.session = null;
    this.detached = false;
    if (this.recordings) await this.recordings.stop("session-close");
    if (current) await current.close();
    return { closed: current !== null };
  }

  async handle(request: ControlRequest): Promise<ControlResponse> {
    try {
      switch (request.op) {
        case "ping":
          exact(request, ["id", "op"]);
          return successful(request.id, { protocol: CONTROL_PROTOCOL });
        case "capabilities":
          exact(request, ["id", "op"]);
          return successful(request.id, controlCapabilities());
        case "authorize": {
          exact(request, ["id", "op", "profile"]);
          this.authorization = authorizationProfile(request.profile);
          return successful(request.id, { authorized: true, profile: this.authorization });
        }
        case "workspace.describe":
          exact(request, ["id", "op"]);
          return successful(request.id, {
            root: repoRoot(),
            manifest: loadManifest(),
            authorized: this.authorization !== null,
            session: this.session && !this.detached
              ? { id: this.sessionId, target: this.session.target, process: this.session.process, pid: this.session.pid, device: this.session.device }
              : null,
            record: this.recordings?.store.active() ?? null,
          });
        case "device.list":
          exact(request, ["id", "op"]);
          this.requireAuthorization();
          return successful(request.id, { devices: (await this.deps.devices()).map((choice) => choice.info) });
        case "process.list": {
          exact(request, ["id", "op", "query", "limit", "device"]);
          this.requireAuthorization();
          const query = request.query === undefined ? undefined : requiredString(request.query, "query");
          const limit = request.limit === undefined ? 200 : request.limit;
          if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 10_000) {
            throw new ControlError("invalid-request", "limit must be an integer from 1 to 10000");
          }
          return successful(request.id, await this.deps.processes({
            ...(query ? { query } : {}),
            limit: limit as number,
            ...(request.device === undefined ? {} : { device: optionalDevice(request.device)! }),
          }));
        }
        case "module.list":
          exact(request, ["id", "op"]);
          return successful(request.id, { modules: this.deps.modules() });
        case "instrument.list":
          exact(request, ["id", "op"]);
          return successful(request.id, { instruments: this.deps.projects.list() });
        case "instrument.source.read": {
          exact(request, ["id", "op", "name"]);
          const name = requiredString(request.name, "name", 128);
          return successful(request.id, this.deps.sourceRead(name));
        }
        case "instrument.source.write": {
          exact(request, ["id", "op", "name", "text", "expectedSha256"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          if (typeof request.text !== "string") throw new ControlError("invalid-request", "text must be a string");
          const expected = requiredSha256(request.expectedSha256);
          return successful(request.id, this.deps.sourceWrite(name, request.text, expected));
        }
        case "instrument.create": {
          exact(request, ["id", "op", "draft"]);
          this.requireAuthorization();
          const rawDraft = requiredRecord(request.draft, "draft");
          exact(rawDraft, ["name", "process", "mode", "processByPlatform", "device"]);
          const draft = rawDraft as unknown as TargetCreate;
          return successful(request.id, await this.deps.projects.create(draft));
        }
        case "instrument.update": {
          exact(request, ["id", "op", "name", "patch"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          const rawPatch = requiredRecord(request.patch, "patch");
          exact(rawPatch, ["process", "mode", "processByPlatform", "device", "entry"]);
          const patch = rawPatch as unknown as TargetPatch;
          return successful(request.id, await this.deps.projects.update(name, patch));
        }
        case "instrument.rename": {
          exact(request, ["id", "op", "name", "nextName", "moveSources"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          const nextName = requiredString(request.nextName, "nextName", 128);
          if (request.moveSources !== undefined && typeof request.moveSources !== "boolean") throw new ControlError("invalid-request", "moveSources must be a boolean");
          return successful(request.id, await this.deps.projects.rename(name, nextName, { moveConventionalSources: request.moveSources !== false }));
        }
        case "instrument.unregister": {
          exact(request, ["id", "op", "name"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          return successful(request.id, await this.deps.projects.remove({ name, policy: "unregister" }));
        }
        case "instrument.delete": {
          exact(request, ["id", "op", "name", "confirmation"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          const confirmation = requiredString(request.confirmation, "confirmation", 128);
          return successful(request.id, await this.deps.projects.remove({ name, policy: "delete-sources", confirmation }));
        }
        case "instrument.build": {
          exact(request, ["id", "op", "name"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          const bundle = await this.deps.compile(name);
          return successful(request.id, {
            instrument: name,
            bytes: Buffer.byteLength(bundle),
            sha256: createHash("sha256").update(bundle).digest("hex"),
          });
        }
        case "instrument.package": {
          exact(request, ["id", "op", "name", "out"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          const out = request.out === undefined ? undefined : requiredString(request.out, "out", 1024);
          const built = await this.deps.package(name, out);
          return successful(request.id, { instrument: name, path: built.path, bytes: built.bytes, sha256: built.sha256, integrity: built.artifact.integrity });
        }
        case "module.link": {
          exact(request, ["id", "op", "name", "module", "expectedSha256"]);
          this.requireAuthorization();
          const name = requiredString(request.name, "name", 128);
          const module = requiredString(request.module, "module", 256);
          const expected = requiredSha256(request.expectedSha256);
          return successful(request.id, this.deps.moduleLink(name, module, expected));
        }
        case "verify.static": {
          exact(request, ["id", "op"]);
          this.requireAuthorization();
          const report = this.deps.verify();
          return successful(request.id, { passed: report.violations.length === 0, ...report });
        }
        case "session.open": {
          exact(request, ["id", "op", "launch"]);
          this.requireAuthorization();
          if (this.session) await this.closeSession();
          const resolution = resolveLaunchRequest(request.launch);
          this.detached = false;
          const pendingId = this.sessionId + 1;
          const session = await this.deps.launch(request.launch as LaunchRequest, {
            onLog: (message) => this.onEvent({ type: "event", event: "session.log", message }),
            onError: (message) => this.onEvent({ type: "event", event: "session.error", message }),
            onClose: (reason) => {
              this.detached = true;
              if (this.recordings) void this.recordings.stop("session-detached");
              this.onEvent({ type: "event", event: "session.detached", reason });
            },
            onEvent: (payload) => {
              if (payload.type === "flab.record.event" || payload.type === "flab.record.state") {
                this.recordings?.capture(payload);
                return;
              }
              // log payloads are already routed through onLog → stderr. Keep
              // stdout free of duplicate log events while preserving crash and
              // other structured payloads for protocol clients.
              if (payload.type !== "log") this.onEvent({ type: "event", event: "agent.payload", payload });
            },
          });
          this.session = session;
          this.sessionId = pendingId;
          try {
            return successful(request.id, {
              sessionId: this.sessionId,
              target: session.target,
              process: session.process,
              pid: session.pid,
              device: session.device,
              launch: resolution.initialDisplay,
              actions: await session.describe(),
            });
          } catch (error) {
            await this.closeSession();
            throw error;
          }
        }
        case "session.describe":
          exact(request, ["id", "op"]);
          return successful(request.id, { sessionId: this.sessionId, actions: await this.requireSession().describe() });
        case "session.action": {
          exact(request, ["id", "op", "mode", "action", "args", "offset"]);
          const session = this.requireSession();
          if (request.mode !== "analysis" && request.mode !== "instrument" && request.mode !== "debug") {
            throw new ControlError("invalid-request", "mode must be analysis, instrument, or debug");
          }
          const action = requiredString(request.action, "action", 256);
          if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string")) {
            throw new ControlError("invalid-request", "args must be an array of raw strings");
          }
          if (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || (request.offset as number) < 0)) {
            throw new ControlError("invalid-request", "offset must be a nonnegative safe integer");
          }
          const receipt = await this.actions.invoke(session, {
            sessionId: this.sessionId,
            mode: request.mode as ActionMode,
            action,
            rawArgs: request.args as string[],
            ...(request.offset === undefined ? {} : { offset: request.offset as number }),
          });
          return receipt.status === "passed"
            ? successful(request.id, receipt)
            : {
                type: "response",
                id: request.id,
                ok: false,
                error: { code: receipt.error?.code ?? "action-failed", message: receipt.error?.message ?? "action failed" },
                receipt,
              };
        }
        case "record.plan": {
          exact(request, ["id", "op", "query", "module", "limit"]);
          this.requireAuthorization();
          const session = this.requireSession();
          const query = requiredString(request.query, "query", 200);
          const module = request.module === undefined ? undefined : requiredString(request.module, "module", 300);
          const limit = request.limit === undefined ? 24 : request.limit;
          if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
            throw new ControlError("invalid-request", "limit must be an integer from 1 to 100");
          }
          return successful(request.id, await this.recordingService().plan(session, query, module, limit as number));
        }
        case "record.start": {
          exact(request, ["id", "op", "label", "probes", "options"]);
          this.requireAuthorization();
          const session = this.requireSession();
          const label = requiredString(request.label, "label", 200);
          return successful(request.id, await this.recordingService().start(
            session,
            { target: session.target, process: session.process, pid: session.pid, device: session.device },
            label,
            request.probes,
            request.options,
          ));
        }
        case "record.status": {
          exact(request, ["id", "op"]);
          this.requireAuthorization();
          const status = this.recordings ? await this.recordings.status() : { record: null, agent: null, completed: null };
          return successful(request.id, status);
        }
        case "record.stop": {
          exact(request, ["id", "op"]);
          this.requireAuthorization();
          return successful(request.id, { record: await this.recordings?.stop("requested") ?? null });
        }
        case "record.list":
          exact(request, ["id", "op"]);
          this.requireAuthorization();
          return successful(request.id, { records: this.recordingService().store.list() });
        case "record.read": {
          exact(request, ["id", "op", "recordId", "cursor", "limit"]);
          this.requireAuthorization();
          const recordId = requiredString(request.recordId, "recordId", 96);
          const cursor = request.cursor === undefined ? 0 : request.cursor;
          const limit = request.limit === undefined ? 100 : request.limit;
          return successful(request.id, await this.recordingService().store.read(recordId, cursor as number, limit as number));
        }
        case "record.summary": {
          exact(request, ["id", "op", "recordId"]);
          this.requireAuthorization();
          const recordId = requiredString(request.recordId, "recordId", 96);
          return successful(request.id, await this.recordingService().store.summary(recordId));
        }
        case "session.close":
          exact(request, ["id", "op"]);
          return successful(request.id, await this.closeSession());
        case "close":
          exact(request, ["id", "op"]);
          await this.closeSession();
          return successful(request.id, { closed: true });
        default:
          throw new ControlError("unknown-operation", `unsupported operation ${JSON.stringify(request.op)}`);
      }
    } catch (error) {
      return failed(request.id, error);
    }
  }

  async close(): Promise<void> {
    await this.closeSession();
  }
}

export function createControlService(options: ControlServiceOptions = {}): ControlService {
  return new ControlService(options);
}

export function controlReady(): Record<string, unknown> {
  return { type: "ready", protocol: CONTROL_PROTOCOL, capabilities: controlCapabilities() };
}
