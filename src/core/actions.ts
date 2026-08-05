import type { GameSession } from "./session.js";

export type RpcCapability = "instrument" | "debug" | "analysis";
export type RpcEffect = "read" | "write" | "hook" | "control";
export type RpcArgType = "string" | "number" | "integer" | "boolean" | "json" | "address" | "pattern";
export type RpcReturnType = "scalar" | "json" | "table" | "hex" | "verification";

export interface RpcArgDescriptor {
  name: string;
  type?: RpcArgType | `${RpcArgType}?`;
  optional?: boolean;
}

export interface RpcDescriptor {
  name: string;
  /** Human-facing action name used by descriptor-driven menus. */
  label?: string;
  /** Short domain group such as Player, World, QoL, or Debug. */
  category?: string;
  args?: RpcArgDescriptor[];
  doc?: string;
  capabilities?: RpcCapability[];
  effect?: RpcEffect;
  returns?: RpcReturnType;
  statusAction?: string;
}

export interface CanonicalRpcArgDescriptor {
  name: string;
  type: RpcArgType;
  optional: boolean;
}

export interface CanonicalRpcDescriptor {
  name: string;
  label?: string;
  category?: string;
  args: readonly CanonicalRpcArgDescriptor[];
  doc?: string;
  capabilities: readonly RpcCapability[];
  effect: RpcEffect;
  returns: RpcReturnType;
  statusAction?: string;
}

export interface DescriptorNormalizationResult {
  descriptors: readonly CanonicalRpcDescriptor[];
  warnings: readonly string[];
}

export type ActionMode = "instrument" | "debug" | "analysis";
export type ActionStatus = "running" | "passed" | "failed";

export interface ActionRequest {
  mode: ActionMode;
  sessionId: number;
  action: string;
  rawArgs: readonly string[];
  offset?: number;
}

export interface ResultPage {
  summary: string;
  rows: readonly string[];
  totalRows: number;
  nextOffset?: number;
  truncated: boolean;
}

export interface VerificationView {
  state: "verified" | "unverified" | "failed";
  fired: number;
  verified: boolean;
  detail?: string;
}

export interface VerificationNormalizationResult {
  verification?: VerificationView;
  warnings: readonly string[];
}

export type ActionErrorCode =
  | "invalid-request"
  | "describe-failed"
  | "descriptor-invalid"
  | "action-not-found"
  | "policy-denied"
  | "arity"
  | "argument"
  | "invoke-failed"
  | "action-rejected"
  | "retention-limit";

export interface ActionErrorView {
  code: ActionErrorCode;
  message: string;
}

export interface ActionReceipt {
  sessionId: number;
  action: string;
  mode: ActionMode;
  status: ActionStatus;
  startedAt: number;
  completedAt?: number;
  result: ResultPage;
  verification?: VerificationView;
  statusAction?: string;
  warnings: readonly string[];
  error?: ActionErrorView;
}

export type DebugEventKind =
  | "process-crash"
  | "agent-exception"
  | "session-detached"
  | "spawn"
  | "child"
  | "hook-receipt";

export interface DebugEventInput {
  kind: DebugEventKind;
  timestamp?: number;
  summary: string;
  detail?: string;
  report?: unknown;
  action?: string;
  actionStatus?: ActionStatus;
  verification?: VerificationView;
}

export interface DebugEvent {
  kind: DebugEventKind;
  timestamp: number;
  summary: string;
  detail?: string;
  report?: ResultPage;
  action?: string;
  actionStatus?: ActionStatus;
  verification?: VerificationView;
}

export interface ReceiptHistory {
  receipts: readonly ActionReceipt[];
  bytes: number;
  droppedReceipts: number;
}

export interface DebugHistory {
  events: readonly DebugEvent[];
  bytes: number;
  droppedDebugEvents: number;
}

export const RESULT_PAGE_MAX_BYTES = 48 * 1024;
export const RESULT_SUMMARY_MAX_BYTES = 4 * 1024;
export const RESULT_ROW_MAX_BYTES = 4 * 1024;
export const RESULT_ROWS_MAX = 200;
export const RECEIPTS_MAX = 200;
export const RECEIPTS_MAX_BYTES = 2 * 1024 * 1024;
export const DEBUG_EVENT_MAX_BYTES = 64 * 1024;
export const DEBUG_EVENTS_MAX = 500;
export const DEBUG_EVENTS_MAX_BYTES = 2 * 1024 * 1024;
export const VERIFICATION_DETAIL_MAX_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CAPABILITIES = new Set<RpcCapability>(["instrument", "debug", "analysis"]);
const EFFECTS = new Set<RpcEffect>(["read", "write", "hook", "control"]);
const ARG_TYPES = new Set<RpcArgType>(["string", "number", "integer", "boolean", "json", "address", "pattern"]);
const RETURN_TYPES = new Set<RpcReturnType>(["scalar", "json", "table", "hex", "verification"]);
const MODES = new Set<ActionMode>(["instrument", "debug", "analysis"]);
const STATUSES = new Set<ActionStatus>(["running", "passed", "failed"]);
const DEBUG_KINDS = new Set<DebugEventKind>([
  "process-crash",
  "agent-exception",
  "session-detached",
  "spawn",
  "child",
  "hook-receipt",
]);

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= limit) return value;
  let end = Math.min(limit, encoded.byteLength);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function stableValue(value: unknown, seen: WeakSet<object>, depth: number): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : `[${String(value)}]`;
    case "bigint":
      return `${value.toString()}n`;
    case "undefined":
      return "[undefined]";
    case "symbol":
      return `[symbol${value.description ? ` ${value.description}` : ""}]`;
    case "function":
      return `[function${value.name ? ` ${value.name}` : ""}]`;
    case "object":
      break;
  }

  const object = value as object;
  if (depth >= 32) return "[maximum depth]";
  if (seen.has(object)) return "[circular]";
  seen.add(object);
  try {
    if (Array.isArray(object)) return object.map((entry) => stableValue(entry, seen, depth + 1));
    if (object instanceof Error) {
      return {
        message: object.message,
        name: object.name,
      };
    }
    if (object instanceof Date) {
      const time = object.getTime();
      return Number.isFinite(time) ? object.toISOString() : "[invalid date]";
    }

    const output: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    for (const key of Object.keys(object).sort()) {
      try {
        output[key] = stableValue((object as Record<string, unknown>)[key], seen, depth + 1);
      } catch (error) {
        output[key] = `[unreadable: ${errorMessage(error)}]`;
      }
    }
    return output;
  } catch (error) {
    return `[unserializable: ${errorMessage(error)}]`;
  } finally {
    seen.delete(object);
  }
}

/** Deterministic JSON text with recursively sorted object keys and safe unknown-value handling. */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(stableValue(value, new WeakSet<object>(), 0)) ?? "null";
}

export function serializedUtf8Bytes(value: unknown): number {
  return utf8ByteLength(stableSerialize(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function displayValue(value: unknown, maxBytes = 512): string {
  return truncateUtf8(typeof value === "string" ? value : stableSerialize(value), maxBytes);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return stableSerialize(error);
}

function normalizeWarningList(warnings: readonly string[]): string[] {
  const output: string[] = [];
  let bytes = 0;
  for (const warning of warnings) {
    if (output.length >= 64) break;
    const bounded = truncateUtf8(warning, 1024);
    const size = utf8ByteLength(bounded);
    if (bytes + size > 32 * 1024) break;
    output.push(bounded);
    bytes += size;
  }
  if (output.length < warnings.length) output.push(`${warnings.length - output.length} additional warnings omitted`);
  return output;
}

function normalizeArg(
  input: unknown,
  descriptorName: string,
  index: number,
  warnings: string[],
): { arg?: CanonicalRpcArgDescriptor; instrumentOnly: boolean; malformed: boolean } {
  if (!isRecord(input) || typeof input.name !== "string" || input.name.trim() === "") {
    return { instrumentOnly: false, malformed: true };
  }
  if (own(input, "optional") && typeof input.optional !== "boolean") {
    return { instrumentOnly: false, malformed: true };
  }

  let optionalFromType = false;
  let type: RpcArgType = "string";
  let instrumentOnly = false;
  if (own(input, "type") && input.type !== undefined) {
    if (typeof input.type !== "string" || input.type === "") {
      return { instrumentOnly: false, malformed: true };
    }
    const rawType = input.type.endsWith("?") ? input.type.slice(0, -1) : input.type;
    optionalFromType = input.type.endsWith("?");
    if (ARG_TYPES.has(rawType as RpcArgType)) {
      type = rawType as RpcArgType;
    } else {
      type = "string";
      instrumentOnly = true;
      warnings.push(
        `Descriptor ${JSON.stringify(descriptorName)} argument ${index + 1} has unknown type ${JSON.stringify(displayValue(input.type))}; treating it as an Instrument-only string`,
      );
    }
  }

  return {
    arg: {
      name: input.name,
      type,
      optional: typeof input.optional === "boolean" ? input.optional : optionalFromType,
    },
    instrumentOnly,
    malformed: false,
  };
}

function parseDescriptor(input: unknown, index: number, warnings: string[]): CanonicalRpcDescriptor | null {
  if (!isRecord(input) || typeof input.name !== "string" || input.name.trim() === "") {
    warnings.push(`Descriptor at index ${index} is malformed and was dropped`);
    return null;
  }
  const name = input.name;
  if (name === "__describe") return null;
  if (own(input, "doc") && input.doc !== undefined && typeof input.doc !== "string") {
    warnings.push(`Descriptor ${JSON.stringify(name)} has a malformed doc and was dropped`);
    return null;
  }
  for (const field of ["label", "category"] as const) {
    if (own(input, field) && input[field] !== undefined &&
        (typeof input[field] !== "string" || input[field].trim() === "")) {
      warnings.push(`Descriptor ${JSON.stringify(name)} has a malformed ${field} and was dropped`);
      return null;
    }
  }

  const rawArgs = input.args === undefined ? [] : input.args;
  if (!Array.isArray(rawArgs)) {
    warnings.push(`Descriptor ${JSON.stringify(name)} has malformed args and was dropped`);
    return null;
  }
  const args: CanonicalRpcArgDescriptor[] = [];
  const argNames = new Set<string>();
  let instrumentOnly = false;
  let sawOptional = false;
  for (let argIndex = 0; argIndex < rawArgs.length; argIndex++) {
    const parsed = normalizeArg(rawArgs[argIndex], name, argIndex, warnings);
    if (parsed.malformed || !parsed.arg || argNames.has(parsed.arg.name)) {
      warnings.push(`Descriptor ${JSON.stringify(name)} has malformed args and was dropped`);
      return null;
    }
    if (sawOptional && !parsed.arg.optional) {
      warnings.push(`Descriptor ${JSON.stringify(name)} has a required argument after an optional argument and was dropped`);
      return null;
    }
    argNames.add(parsed.arg.name);
    sawOptional ||= parsed.arg.optional;
    instrumentOnly ||= parsed.instrumentOnly;
    args.push(parsed.arg);
  }

  const legacy = input.capabilities === undefined && input.effect === undefined && input.returns === undefined;
  let capabilities: RpcCapability[];
  let effect: RpcEffect;
  let returns: RpcReturnType;
  if (legacy) {
    capabilities = ["instrument"];
    effect = "control";
    returns = "json";
  } else {
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
      warnings.push(`Descriptor ${JSON.stringify(name)} is missing required capability metadata and was dropped`);
      return null;
    }
    if (typeof input.effect !== "string" || !EFFECTS.has(input.effect as RpcEffect)) {
      warnings.push(`Descriptor ${JSON.stringify(name)} has an unknown effect and was dropped`);
      return null;
    }
    if (typeof input.returns !== "string" || !RETURN_TYPES.has(input.returns as RpcReturnType)) {
      warnings.push(`Descriptor ${JSON.stringify(name)} has an unknown return type and was dropped`);
      return null;
    }
    capabilities = [];
    for (const capability of input.capabilities) {
      if (typeof capability !== "string" || !CAPABILITIES.has(capability as RpcCapability)) {
        warnings.push(`Descriptor ${JSON.stringify(name)} has an unknown capability and was dropped`);
        return null;
      }
      if (!capabilities.includes(capability as RpcCapability)) capabilities.push(capability as RpcCapability);
    }
    effect = input.effect as RpcEffect;
    returns = input.returns as RpcReturnType;
  }

  if (instrumentOnly) capabilities = ["instrument"];
  if (own(input, "statusAction") && input.statusAction !== undefined &&
      (typeof input.statusAction !== "string" || input.statusAction.trim() === "")) {
    warnings.push(`Descriptor ${JSON.stringify(name)} has a malformed status action and was dropped`);
    return null;
  }

  return {
    name,
    ...(typeof input.label === "string" ? { label: input.label.trim() } : {}),
    ...(typeof input.category === "string" ? { category: input.category.trim() } : {}),
    args,
    ...(typeof input.doc === "string" ? { doc: input.doc } : {}),
    capabilities,
    effect,
    returns,
    ...(typeof input.statusAction === "string" ? { statusAction: input.statusAction } : {}),
  };
}

/** Normalize an untrusted __describe result into the fail-closed canonical surface. */
export function normalizeRpcDescriptors(input: unknown): DescriptorNormalizationResult {
  if (!Array.isArray(input)) {
    return { descriptors: [], warnings: ["RPC descriptor response is not an array; all actions were dropped"] };
  }

  const warnings: string[] = [];
  const parsed: CanonicalRpcDescriptor[] = [];
  for (let index = 0; index < input.length; index++) {
    try {
      const descriptor = parseDescriptor(input[index], index, warnings);
      if (descriptor) parsed.push(descriptor);
    } catch (error) {
      warnings.push(`Descriptor at index ${index} could not be read and was dropped: ${displayValue(errorMessage(error))}`);
    }
  }

  const counts = new Map<string, number>();
  for (const descriptor of parsed) counts.set(descriptor.name, (counts.get(descriptor.name) ?? 0) + 1);
  const duplicateNames = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  for (const name of duplicateNames) warnings.push(`Duplicate descriptor name ${JSON.stringify(name)} was dropped`);

  const byName = new Map<string, CanonicalRpcDescriptor>();
  for (const descriptor of parsed) {
    if (!duplicateNames.has(descriptor.name)) byName.set(descriptor.name, descriptor);
  }

  const warnedStatus = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const descriptor of [...byName.values()]) {
      if (!descriptor.statusAction) continue;
      const status = byName.get(descriptor.statusAction);
      if (status && status.effect === "read" && status.capabilities.includes("analysis")) continue;
      byName.delete(descriptor.name);
      changed = true;
      if (!warnedStatus.has(descriptor.name)) {
        warnings.push(
          `Descriptor ${JSON.stringify(descriptor.name)} has invalid status action ${JSON.stringify(descriptor.statusAction)} and was dropped`,
        );
        warnedStatus.add(descriptor.name);
      }
    }
  }

  return {
    descriptors: parsed.filter((descriptor) => byName.get(descriptor.name) === descriptor),
    warnings,
  };
}


export type AuthorizationResult =
  | { ok: true; descriptor: CanonicalRpcDescriptor }
  | { ok: false; code: "action-not-found" | "policy-denied"; message: string };

export function authorizeAction(
  descriptors: readonly CanonicalRpcDescriptor[],
  mode: ActionMode,
  action: string,
): AuthorizationResult {
  const descriptor = descriptors.find((candidate) => candidate.name === action);
  if (!descriptor) return { ok: false, code: "action-not-found", message: `Action ${JSON.stringify(action)} is not available` };

  if (mode === "analysis") {
    if (!descriptor.capabilities.includes("analysis") || descriptor.effect !== "read") {
      return { ok: false, code: "policy-denied", message: `Action ${JSON.stringify(action)} is not authorized for Analysis` };
    }
  } else if (mode === "debug") {
    if (!descriptor.capabilities.includes("debug") || !(["read", "hook", "control"] as RpcEffect[]).includes(descriptor.effect)) {
      return { ok: false, code: "policy-denied", message: `Action ${JSON.stringify(action)} is not authorized for Debug` };
    }
  } else if (!descriptor.capabilities.includes("instrument")) {
    return { ok: false, code: "policy-denied", message: `Action ${JSON.stringify(action)} is not authorized for Instrument` };
  }
  return { ok: true, descriptor };
}

export type CoercionResult =
  | { ok: true; args: unknown[] }
  | { ok: false; code: "arity" | "argument"; message: string };

function coerceOne(raw: string, descriptor: CanonicalRpcArgDescriptor): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (descriptor.type) {
    case "string":
      return { ok: true, value: raw };
    case "number": {
      if (raw.trim() === "") return { ok: false, message: "must be a finite number" };
      const value = Number(raw);
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: "must be a finite number" };
    }
    case "integer": {
      if (raw.trim() === "") return { ok: false, message: "must be a finite integer" };
      const value = Number(raw);
      return Number.isFinite(value) && Number.isInteger(value)
        ? { ok: true, value }
        : { ok: false, message: "must be a finite integer" };
    }
    case "boolean":
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, message: "must be exactly true or false" };
    case "json":
      try {
        return { ok: true, value: JSON.parse(raw) as unknown };
      } catch {
        return { ok: false, message: "must be valid JSON" };
      }
    case "address":
      return /^0x[0-9a-fA-F]+$/.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, message: "must be a 0x-prefixed hexadecimal address" };
    case "pattern":
      return /^(?:[0-9a-fA-F?]{2})(?:\s+[0-9a-fA-F?]{2})*$/.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, message: "must be a non-empty Frida byte pattern" };
  }
}

export function coerceActionArgs(
  descriptor: CanonicalRpcDescriptor,
  rawArgs: readonly string[],
): CoercionResult {
  const required = descriptor.args.findIndex((arg) => arg.optional);
  const requiredCount = required === -1 ? descriptor.args.length : required;
  if (rawArgs.length < requiredCount || rawArgs.length > descriptor.args.length) {
    const range = requiredCount === descriptor.args.length
      ? `${requiredCount}`
      : `${requiredCount}-${descriptor.args.length}`;
    return {
      ok: false,
      code: "arity",
      message: `Action ${JSON.stringify(descriptor.name)} expects ${range} arguments, received ${rawArgs.length}`,
    };
  }

  const args: unknown[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const argDescriptor = descriptor.args[index]!;
    const coerced = coerceOne(rawArgs[index]!, argDescriptor);
    if (!coerced.ok) {
      return {
        ok: false,
        code: "argument",
        message: `Argument ${JSON.stringify(argDescriptor.name)} ${coerced.message}`,
      };
    }
    args.push(coerced.value);
  }
  return { ok: true, args };
}


function summaryFor(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return stableSerialize(value);
}

function isNormalizedResultPage(value: unknown): value is ResultPage {
  return isRecord(value) && typeof value.summary === "string" && Array.isArray(value.rows) &&
    value.rows.every((row) => typeof row === "string") &&
    typeof value.totalRows === "number" && Number.isSafeInteger(value.totalRows) && value.totalRows >= value.rows.length &&
    (value.nextOffset === undefined ||
      (typeof value.nextOffset === "number" && Number.isSafeInteger(value.nextOffset) &&
        value.nextOffset >= value.rows.length && value.nextOffset <= value.totalRows)) &&
    typeof value.truncated === "boolean";
}

function pageBytes(page: ResultPage): number {
  return serializedUtf8Bytes(page);
}

function finalizePage(
  summary: string,
  rows: string[],
  totalRows: number,
  nextOffset: number | undefined,
  truncated: boolean,
): ResultPage {
  const page: ResultPage = {
    summary,
    rows,
    totalRows,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    truncated,
  };
  Object.freeze(page.rows);
  return Object.freeze(page);
}

export interface ResultPageOptions {
  offset?: number;
}

/** Convert an unknown RPC result into deterministic, display-only retained text. */
export function normalizeResultPage(value: unknown, options: ResultPageOptions = {}): ResultPage {
  let sourceRows: unknown[] = [];
  let summary: string;
  let totalRows = 0;
  let rowsAlreadySerialized = false;

  if (Array.isArray(value)) {
    sourceRows = value;
    totalRows = value.length;
    summary = `${value.length} rows`;
  } else if (isRecord(value) && Array.isArray(value.rows)) {
    sourceRows = value.rows;
    const suppliedTotal = typeof value.totalRows === "number" && Number.isSafeInteger(value.totalRows) && value.totalRows >= value.rows.length
      ? value.totalRows
      : value.rows.length;
    totalRows = suppliedTotal;
    summary = typeof value.summary === "string" ? value.summary : `${suppliedTotal} rows`;
    rowsAlreadySerialized = isNormalizedResultPage(value);
  } else {
    summary = summaryFor(value);
  }

  const requestedOffset = options.offset;
  const offset = typeof requestedOffset === "number" && Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
    ? Math.min(requestedOffset, totalRows)
    : 0;
  const firstSourceIndex = Math.min(offset, sourceRows.length);
  const boundedSummary = truncateUtf8(summary, RESULT_SUMMARY_MAX_BYTES);
  const summaryWasTruncated = boundedSummary !== summary;
  const rows: string[] = [];
  let anyRowTruncated = false;

  for (let sourceIndex = firstSourceIndex;
    sourceIndex < sourceRows.length && rows.length < RESULT_ROWS_MAX;
    sourceIndex++) {
    const serialized = rowsAlreadySerialized
      ? sourceRows[sourceIndex] as string
      : stableSerialize(sourceRows[sourceIndex]);
    const boundedRow = truncateUtf8(serialized, RESULT_ROW_MAX_BYTES);
    const rowWasTruncated = boundedRow !== serialized;
    const included = rows.length + 1;
    const firstOmitted = offset + included < totalRows ? offset + included : undefined;
    const candidate = finalizePage(
      boundedSummary,
      [...rows, boundedRow],
      totalRows,
      firstOmitted,
      summaryWasTruncated || anyRowTruncated || rowWasTruncated || firstOmitted !== undefined,
    );
    if (pageBytes(candidate) > RESULT_PAGE_MAX_BYTES) break;
    rows.push(boundedRow);
    anyRowTruncated ||= rowWasTruncated;
  }

  const nextOffset = offset + rows.length < totalRows ? offset + rows.length : undefined;
  let page = finalizePage(
    boundedSummary,
    rows,
    totalRows,
    nextOffset,
    summaryWasTruncated || anyRowTruncated || nextOffset !== undefined,
  );
  if (pageBytes(page) <= RESULT_PAGE_MAX_BYTES) return page;

  let low = 0;
  let high = RESULT_SUMMARY_MAX_BYTES;
  let fitted = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateSummary = truncateUtf8(boundedSummary, middle);
    const candidate = finalizePage(candidateSummary, [], totalRows, totalRows > offset ? offset : undefined, true);
    if (pageBytes(candidate) <= RESULT_PAGE_MAX_BYTES) {
      fitted = candidateSummary;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  page = finalizePage(fitted, [], totalRows, totalRows > offset ? offset : undefined, true);
  return page;
}

function normalizedFired(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : 0;
}

function verificationConflict(
  record: Record<string, unknown>,
  state: VerificationView["state"],
  fired: number,
  hasFired: boolean,
): boolean {
  const expectedVerified = state === "verified";
  if (typeof record.verified === "boolean" && record.verified !== expectedVerified) return true;
  if (record.failed === true && state !== "failed") return true;
  if (record.failed === false && state === "failed") return true;
  if (hasFired && (fired >= 1 ? state !== "verified" : state !== "unverified")) return true;
  return false;
}

export function normalizeVerification(value: unknown): VerificationNormalizationResult {
  if (!isRecord(value)) return { warnings: [] };
  const source = isRecord(value.instrument) ? value.instrument : value;
  const warnings: string[] = [];
  const hasFired = own(source, "fired");
  const fired = normalizedFired(source.fired);
  let state: VerificationView["state"] | undefined;

  if (source.state === "verified" || source.state === "unverified" || source.state === "failed") {
    state = source.state;
    if (verificationConflict(source, state, fired, hasFired)) warnings.push("Verification fields conflict; explicit state takes precedence");
  } else if (source.failed === true) {
    state = "failed";
  } else if (source.verified === true || (hasFired && fired >= 1)) {
    state = "verified";
  } else if (source.verified === false || (hasFired && fired === 0)) {
    state = "unverified";
  }

  if (!state) return { warnings };
  const detail = typeof source.detail === "string"
    ? truncateUtf8(source.detail, VERIFICATION_DETAIL_MAX_BYTES)
    : undefined;
  const verification: VerificationView = {
    state,
    fired,
    verified: state === "verified",
    ...(detail === undefined ? {} : { detail }),
  };
  return { verification: Object.freeze(verification), warnings };
}

function receiptPage(summary: string): ResultPage {
  return normalizeResultPage(truncateUtf8(summary, RESULT_SUMMARY_MAX_BYTES));
}

function safeMode(mode: unknown): ActionMode {
  return typeof mode === "string" && MODES.has(mode as ActionMode) ? mode as ActionMode : "instrument";
}

function safeTimestamp(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function failedReceipt(
  request: Pick<ActionRequest, "sessionId" | "action" | "mode">,
  startedAt: number,
  completedAt: number,
  code: ActionErrorCode,
  message: string,
  warnings: readonly string[] = [],
  statusAction?: string,
): ActionReceipt {
  const boundedMessage = truncateUtf8(message, RESULT_SUMMARY_MAX_BYTES);
  return Object.freeze({
    sessionId: Number.isSafeInteger(request.sessionId) ? request.sessionId : 0,
    action: truncateUtf8(typeof request.action === "string" ? request.action : "", RESULT_SUMMARY_MAX_BYTES),
    mode: safeMode(request.mode),
    status: "failed" as const,
    startedAt,
    completedAt,
    result: receiptPage(boundedMessage),
    ...(statusAction ? { statusAction: truncateUtf8(statusAction, RESULT_SUMMARY_MAX_BYTES) } : {}),
    warnings: Object.freeze(normalizeWarningList(warnings)),
    error: Object.freeze({ code, message: boundedMessage }),
  });
}

export function createRunningReceipt(request: ActionRequest, startedAt = Date.now()): ActionReceipt {
  return Object.freeze({
    sessionId: Number.isSafeInteger(request.sessionId) ? request.sessionId : 0,
    action: truncateUtf8(request.action, RESULT_SUMMARY_MAX_BYTES),
    mode: safeMode(request.mode),
    status: "running" as const,
    startedAt: safeTimestamp(startedAt),
    result: receiptPage(`Running ${request.action}`),
    warnings: Object.freeze([] as string[]),
  });
}

export interface ActionSession extends Pick<GameSession, "describe" | "call"> {}

export interface ActionInvocationOptions {
  now?: () => number;
}

/** Live-describe, authorize by name, coerce, invoke, and retain only normalized output. */
export async function invokeAction(
  session: ActionSession,
  request: ActionRequest,
  options: ActionInvocationOptions = {},
): Promise<ActionReceipt> {
  const now = options.now ?? Date.now;
  const startedAt = safeTimestamp(now());
  if (!MODES.has(request.mode) || !Number.isSafeInteger(request.sessionId) || request.sessionId < 0 ||
      typeof request.action !== "string" || request.action === "" ||
      !Array.isArray(request.rawArgs) || request.rawArgs.some((arg) => typeof arg !== "string") ||
      (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0))) {
    return failedReceipt(request, startedAt, safeTimestamp(now(), startedAt), "invalid-request", "Invalid action request");
  }

  let described: unknown;
  try {
    described = await session.describe();
  } catch (error) {
    return failedReceipt(
      request,
      startedAt,
      safeTimestamp(now(), startedAt),
      "describe-failed",
      `Unable to describe current RPC surface: ${errorMessage(error)}`,
    );
  }

  const normalized = normalizeRpcDescriptors(described);
  const authorization = authorizeAction(normalized.descriptors, request.mode, request.action);
  if (!authorization.ok) {
    return failedReceipt(
      request,
      startedAt,
      safeTimestamp(now(), startedAt),
      authorization.code,
      authorization.message,
      normalized.warnings,
    );
  }

  const offset = request.offset ?? 0;
  if (offset > 0 && (request.mode !== "analysis" || authorization.descriptor.effect !== "read")) {
    return failedReceipt(
      request,
      startedAt,
      safeTimestamp(now(), startedAt),
      "policy-denied",
      "Result offsets above zero are authorized only for Analysis read actions",
      normalized.warnings,
    );
  }

  const coerced = coerceActionArgs(authorization.descriptor, request.rawArgs);
  if (!coerced.ok) {
    return failedReceipt(
      request,
      startedAt,
      safeTimestamp(now(), startedAt),
      coerced.code,
      coerced.message,
      normalized.warnings,
      authorization.descriptor.statusAction,
    );
  }

  let rawResult: unknown;
  try {
    rawResult = await session.call(authorization.descriptor.name, coerced.args);
  } catch (error) {
    return failedReceipt(
      request,
      startedAt,
      safeTimestamp(now(), startedAt),
      "invoke-failed",
      `Action ${JSON.stringify(request.action)} failed: ${errorMessage(error)}`,
      normalized.warnings,
      authorization.descriptor.statusAction,
    );
  }

  if (isRecord(rawResult) && rawResult.ok === false) {
    const sourceError = isRecord(rawResult.error) ? rawResult.error : null;
    const sourceCode = typeof sourceError?.code === "string" ? ` [${sourceError.code}]` : "";
    const sourceMessage = typeof sourceError?.message === "string" ? sourceError.message : stableSerialize(rawResult);
    return failedReceipt(
      request,
      startedAt,
      safeTimestamp(now(), startedAt),
      "action-rejected",
      `Action ${JSON.stringify(request.action)} was rejected${sourceCode}: ${sourceMessage}`,
      normalized.warnings,
      authorization.descriptor.statusAction,
    );
  }

  const verification = normalizeVerification(rawResult);
  const receipt: ActionReceipt = {
    sessionId: request.sessionId,
    action: truncateUtf8(authorization.descriptor.name, RESULT_SUMMARY_MAX_BYTES),
    mode: request.mode,
    status: "passed",
    startedAt,
    completedAt: safeTimestamp(now(), startedAt),
    result: normalizeResultPage(rawResult, { offset }),
    ...(verification.verification ? { verification: verification.verification } : {}),
    ...(authorization.descriptor.statusAction ? { statusAction: authorization.descriptor.statusAction } : {}),
    warnings: Object.freeze(normalizeWarningList([...normalized.warnings, ...verification.warnings])),
  };
  return Object.freeze(receipt);
}

function normalizeExistingPage(value: unknown): ResultPage {
  if (isNormalizedResultPage(value) &&
      value.rows.length <= RESULT_ROWS_MAX &&
      utf8ByteLength(value.summary) <= RESULT_SUMMARY_MAX_BYTES &&
      value.rows.every((row) => utf8ByteLength(row) <= RESULT_ROW_MAX_BYTES) &&
      pageBytes(value) <= RESULT_PAGE_MAX_BYTES) {
    return finalizePage(value.summary, [...value.rows], value.totalRows, value.nextOffset, value.truncated);
  }
  return normalizeResultPage(value);
}

function normalizeReceipt(receipt: ActionReceipt, sessionId = receipt.sessionId): ActionReceipt {
  const verification = normalizeVerification(receipt.verification);
  const error = receipt.error && typeof receipt.error.message === "string" && typeof receipt.error.code === "string"
    ? Object.freeze({
        code: receipt.error.code as ActionErrorCode,
        message: truncateUtf8(receipt.error.message, RESULT_SUMMARY_MAX_BYTES),
      })
    : undefined;
  return Object.freeze({
    sessionId: Number.isSafeInteger(sessionId) ? sessionId : 0,
    action: truncateUtf8(typeof receipt.action === "string" ? receipt.action : "", RESULT_SUMMARY_MAX_BYTES),
    mode: safeMode(receipt.mode),
    status: STATUSES.has(receipt.status) ? receipt.status : "failed",
    startedAt: safeTimestamp(receipt.startedAt),
    ...(receipt.completedAt === undefined ? {} : { completedAt: safeTimestamp(receipt.completedAt) }),
    result: normalizeExistingPage(receipt.result),
    ...(verification.verification ? { verification: verification.verification } : {}),
    ...(typeof receipt.statusAction === "string" ? { statusAction: truncateUtf8(receipt.statusAction, RESULT_SUMMARY_MAX_BYTES) } : {}),
    warnings: Object.freeze(normalizeWarningList(Array.isArray(receipt.warnings) ? receipt.warnings.filter((warning): warning is string => typeof warning === "string") : [])),
    ...(error ? { error } : {}),
  });
}

function eventBytes(event: DebugEvent): number {
  return serializedUtf8Bytes(event);
}

function fitEventString(event: DebugEvent, field: "detail" | "summary" | "action"): DebugEvent {
  const original = event[field];
  if (typeof original !== "string") return event;
  let low = 0;
  let high = utf8ByteLength(original);
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = truncateUtf8(original, middle);
    const candidate = { ...event, [field]: value } as DebugEvent;
    if (eventBytes(candidate) <= DEBUG_EVENT_MAX_BYTES) {
      best = value;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { ...event, [field]: best };
}

/** Normalize a structured debug event without retaining its raw report. */
export function normalizeDebugEvent(input: DebugEventInput, fallbackTimestamp = 0): DebugEvent {
  const kind = DEBUG_KINDS.has(input.kind) ? input.kind : "agent-exception";
  const verification = normalizeVerification(input.verification).verification;
  let event: DebugEvent = {
    kind,
    timestamp: safeTimestamp(input.timestamp, safeTimestamp(fallbackTimestamp)),
    summary: truncateUtf8(typeof input.summary === "string" ? input.summary : "Debug event", 16 * 1024),
    ...(typeof input.detail === "string" ? { detail: truncateUtf8(input.detail, 32 * 1024) } : {}),
    ...(input.report === undefined ? {} : { report: normalizeResultPage(input.report) }),
    ...(typeof input.action === "string" ? { action: truncateUtf8(input.action, RESULT_SUMMARY_MAX_BYTES) } : {}),
    ...(input.actionStatus && STATUSES.has(input.actionStatus) ? { actionStatus: input.actionStatus } : {}),
    ...(verification ? { verification } : {}),
  };

  if (eventBytes(event) > DEBUG_EVENT_MAX_BYTES) event = fitEventString(event, "detail");
  if (eventBytes(event) > DEBUG_EVENT_MAX_BYTES) event = fitEventString(event, "summary");
  if (eventBytes(event) > DEBUG_EVENT_MAX_BYTES) event = fitEventString(event, "action");
  if (eventBytes(event) > DEBUG_EVENT_MAX_BYTES && event.verification?.detail !== undefined) {
    event = { ...event, verification: { ...event.verification, detail: "" } };
  }
  if (eventBytes(event) > DEBUG_EVENT_MAX_BYTES) {
    event = {
      kind: "agent-exception",
      timestamp: event.timestamp,
      summary: "Debug event exceeded retention budget",
    };
  }
  if (eventBytes(event) > DEBUG_EVENT_MAX_BYTES) throw new Error("debug event serializer contract is unsatisfiable");
  return Object.freeze(event);
}

class BoundedHistory<T> {
  private entries: Array<{ value: T; bytes: number }> = [];
  private itemBytes = 0;
  dropped = 0;

  constructor(private readonly maxCount: number, private readonly maxBytes: number) {}

  push(value: T): void {
    const bytes = serializedUtf8Bytes(value);
    this.entries.push({ value, bytes });
    this.itemBytes += bytes;
    while (this.entries.length > this.maxCount || this.bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.itemBytes -= removed.bytes;
      this.dropped++;
    }
  }

  replace(previous: T, value: T): boolean {
    const index = this.entries.findIndex((entry) => entry.value === previous);
    if (index === -1) return false;
    const bytes = serializedUtf8Bytes(value);
    const oldBytes = this.entries[index]!.bytes;
    this.entries[index] = { value, bytes };
    this.itemBytes += bytes - oldBytes;
    while (this.entries.length > this.maxCount || this.bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.itemBytes -= removed.bytes;
      this.dropped++;
    }
    return true;
  }

  get values(): readonly T[] {
    return Object.freeze(this.entries.map((entry) => entry.value));
  }

  get bytes(): number {
    return 2 + this.itemBytes + Math.max(0, this.entries.length - 1);
  }
}

export interface ActionServiceOptions {
  now?: () => number;
}

interface InvocationState {
  generation: number;
  inFlight: number;
}

/** Per-session action/debug retention owner used by frontends. */
export class ActionService {
  private readonly receiptStores = new Map<number, BoundedHistory<ActionReceipt>>();
  private readonly debugStores = new Map<number, BoundedHistory<DebugEvent>>();
  private readonly invocationStates = new Map<number, InvocationState>();
  private readonly now: () => number;

  constructor(options: ActionServiceOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async invoke(session: ActionSession, request: ActionRequest): Promise<ActionReceipt> {
    let state = this.invocationStates.get(request.sessionId);
    if (!state) {
      state = { generation: 0, inFlight: 0 };
      this.invocationStates.set(request.sessionId, state);
    }
    const generation = state.generation;
    state.inFlight++;

    try {
      const running = this.recordReceipt(request.sessionId, createRunningReceipt(request, this.now()));
      const completed = normalizeReceipt(
        await invokeAction(session, request, { now: this.now }),
        request.sessionId,
      );
      if (this.invocationStates.get(request.sessionId) !== state || state.generation !== generation) {
        return completed;
      }
      const store = this.receiptStores.get(request.sessionId);
      if (!store?.replace(running, completed)) return this.recordReceipt(request.sessionId, completed);
      return completed;
    } finally {
      state.inFlight--;
      if (this.invocationStates.get(request.sessionId) === state && state.inFlight === 0) {
        this.invocationStates.delete(request.sessionId);
      }
    }
  }


  recordReceipt(sessionId: number, input: ActionReceipt): ActionReceipt {
    const inputTooLarge = serializedUtf8Bytes(input) > RECEIPTS_MAX_BYTES - 2;
    let receipt = inputTooLarge
      ? failedReceipt(
          { sessionId, action: "", mode: "instrument" },
          safeTimestamp(this.now()),
          safeTimestamp(this.now()),
          "retention-limit",
          "Action receipt exceeded retention budget",
        )
      : normalizeReceipt(input, sessionId);
    if (serializedUtf8Bytes(receipt) > RECEIPTS_MAX_BYTES - 2) {
      receipt = failedReceipt(
        { sessionId, action: "", mode: "instrument" },
        safeTimestamp(this.now()),
        safeTimestamp(this.now()),
        "retention-limit",
        "Action receipt exceeded retention budget",
      );
    }
    let store = this.receiptStores.get(sessionId);
    if (!store) {
      store = new BoundedHistory<ActionReceipt>(RECEIPTS_MAX, RECEIPTS_MAX_BYTES);
      this.receiptStores.set(sessionId, store);
    }
    store.push(receipt);
    return receipt;
  }

  receiptHistory(sessionId: number): ReceiptHistory {
    const store = this.receiptStores.get(sessionId);
    return Object.freeze({
      receipts: store?.values ?? Object.freeze([] as ActionReceipt[]),
      bytes: store?.bytes ?? 2,
      droppedReceipts: store?.dropped ?? 0,
    });
  }


  recordDebugEvent(sessionId: number, input: DebugEventInput): DebugEvent {
    const event = normalizeDebugEvent(input, this.now());
    let store = this.debugStores.get(sessionId);
    if (!store) {
      store = new BoundedHistory<DebugEvent>(DEBUG_EVENTS_MAX, DEBUG_EVENTS_MAX_BYTES);
      this.debugStores.set(sessionId, store);
    }
    store.push(event);
    return event;
  }

  debugHistory(sessionId: number): DebugHistory {
    const store = this.debugStores.get(sessionId);
    return Object.freeze({
      events: store?.values ?? Object.freeze([] as DebugEvent[]),
      bytes: store?.bytes ?? 2,
      droppedDebugEvents: store?.dropped ?? 0,
    });
  }


  removeSession(sessionId: number): void {
    const state = this.invocationStates.get(sessionId);
    if (state) {
      state.generation++;
      this.invocationStates.delete(sessionId);
    }
    this.receiptStores.delete(sessionId);
    this.debugStores.delete(sessionId);
  }
}
