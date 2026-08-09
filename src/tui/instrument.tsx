import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import {
  authorizeAction,
  coerceActionArgs,
  normalizeRpcDescriptors,
  type ActionMode,
  type ActionReceipt,
  type CanonicalRpcDescriptor,
} from "../core/index.js";
import type { SessionState } from "./store.js";
import { workbench } from "./workbench.js";
import {
  adjustInstrumentField,
  createInstrumentForm,
  instrumentFieldLabel,
  instrumentFieldValue,
  instrumentFormRawArgs,
  replaceInstrumentField,
  resetInstrumentField,
  type InstrumentFormField,
} from "./instrument-form.js";

/** UX invariant: never render more than three selectable actions at once. */
export const ACTION_VIEW = 3;
const MAX_RECEIPT_ROWS = 12;
const MANAGED_ORDER = [
  "instrumentStart",
  "instrumentList",
  "instrumentStatus",
  "instrumentUpdate",
  "instrumentStop",
  "instrumentDelete",
  "instrumentStopAll",
] as const;

const CATEGORY_ORDER = [
  "Start here",
  "Objectives",
  "Progress",
  "Economy",
  "Player",
  "Combat",
  "Skills",
  "Battle",
  "Gameplay",
  "World",
  "Inventory",
  "Entities",
  "Assist",
  "Visual",
  "Movement",
  "Training",
  "Content",
  "QoL",
  "System",
  "Mod",
  "State diff",
  "Debug",
  "Discovery",
  "Inspect",
  "Runtime",
  "Modify",
  "Control",
  "Managed",
] as const;

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/^instrument/i, "Managed"],
  [/^(modInfo|modState)/i, "Start here"],
  [/^(objective|victory|defeat|complete|stage|wave|progress)/i, "Objectives"],
  [/^(economy|currency|wallet|gold|gem|score|reward)/i, "Economy"],
  [/^(aim|assist|target)/i, "Assist"],
  [/^(move|movement|fly|speed|jump|gravity|air|teleport)/i, "Movement"],
  [/^(combat|damage|god|heal|health|mana|breath|cooldown|skill)/i, "Combat"],
  [/^(info|ping|engines)/i, "System"],
  [/^player/i, "Player"],
  [/^(world|time|weather|map|environment)/i, "World"],
  [/^(item|inventory|give|recipe|craft|loot)/i, "Inventory"],
  [/^(spawn|enemy|npc|actor|entity)/i, "Entities"],
  [/^(esp|render|overlay|visual)/i, "Visual"],
  [/^(memorySnapshot|memoryDiff)/i, "State diff"],
  [/^(trace|watch|hook|debug|demo|crash)/i, "Debug"],
  [/^(classes|methods|fields|exports|modules|scan|strings|address|assemblies)/i, "Discovery"],
  [/^(qol|cmd|set|toggle|dispose|reset)/i, "Mod"],
];

function actionLabel(descriptor: CanonicalRpcDescriptor): string {
  if (descriptor.label) return descriptor.label;
  const words = descriptor.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : descriptor.name;
}

function actionCategory(descriptor: CanonicalRpcDescriptor): string {
  if (descriptor.category) return descriptor.category;
  return CATEGORY_HINTS.find(([pattern]) => pattern.test(descriptor.name))?.[1]
    ?? (descriptor.effect === "read" ? "Inspect"
      : descriptor.effect === "hook" ? "Runtime"
      : descriptor.effect === "write" ? "Modify"
      : "Control");
}

function actionPriority(descriptor: CanonicalRpcDescriptor): number {
  const managed = MANAGED_ORDER.indexOf(descriptor.name as typeof MANAGED_ORDER[number]);
  if (managed >= 0) return 10_000 + managed;
  const category = actionCategory(descriptor);
  const categoryIndex = CATEGORY_ORDER.indexOf(category as typeof CATEGORY_ORDER[number]);
  return categoryIndex >= 0 ? categoryIndex * 100 : 9_000;
}

export interface ActionPanelProps {
  session: SessionState;
  focused: boolean;
  onCaptureChange(active: boolean): void;
}

export interface ActionPaletteProps extends ActionPanelProps {
  mode: ActionMode;
  title: string;
  receiptRows?: number;
  enablePaging?: boolean;
}

interface CaptureState {
  descriptor: CanonicalRpcDescriptor;
  index: number;
  fields: InstrumentFormField[];
  error?: string;
}
interface PageCursor {
  descriptor: CanonicalRpcDescriptor;
  rawArgs: readonly string[];
  offsets: number[];
  index: number;
}

function signature(descriptor: CanonicalRpcDescriptor): string {
  const args = descriptor.args.map((arg) => `${arg.name}${arg.optional ? "?" : ""}: ${arg.type}`).join(", ");
  return `${descriptor.name}(${args})`;
}

function effectLabel(descriptor: CanonicalRpcDescriptor): string {
  if (descriptor.effect === "read") return "Reads only";
  if (descriptor.effect === "write") return "Changes game state";
  if (descriptor.effect === "hook") return "Adds a live hook";
  return "Controls a runtime feature";
}

function inputLabel(descriptor: CanonicalRpcDescriptor): string {
  if (descriptor.args.length === 0) return "No input required";
  return `Controls: ${descriptor.args.map((arg) => `${arg.ui.control}${arg.optional ? "?" : ""}`).join(", ")}`;
}

function oneLine(value: string, limit = 240): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, Math.max(0, limit - 1))}…`;
}

function receiptColor(status: ActionReceipt["status"]): string {
  if (status === "passed") return "green";
  if (status === "failed") return "red";
  return "yellow";
}

function latestForMode(receipts: readonly ActionReceipt[], mode: ActionMode): ActionReceipt | null {
  for (let index = receipts.length - 1; index >= 0; index--) {
    const receipt = receipts[index]!;
    if (receipt.mode === mode) return receipt;
  }
  return null;
}

interface ManagedReceiptView {
  headline: string;
  detail?: string;
  config?: string;
  rows: string[];
}

function compactField(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const simple = entries
      .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
      .slice(0, 6)
      .map(([key, item]) => `${key}=${String(item)}`);
    return simple.length ? simple.join(" · ") : `${entries.length} field(s)`;
  }
  return String(value);
}

function jsonReceiptView(summary: string): ManagedReceiptView | null {
  let value: unknown;
  try { value = JSON.parse(summary); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return {
    headline: `${entries.length} result field(s)`,
    rows: entries.slice(0, 6).map(([key, item]) => `${key}: ${compactField(item)}`),
  };
}

function managedReceiptView(receipt: ActionReceipt): ManagedReceiptView | null {
  if (!receipt.action.startsWith("instrument")) return null;
  let value: unknown;
  try { value = JSON.parse(receipt.result.summary); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const instrument = result.instrument;
  if (instrument && typeof instrument === "object" && !Array.isArray(instrument)) {
    const item = instrument as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "instrument";
    const kind = typeof item.kind === "string" ? item.kind : "unknown";
    const label = typeof item.label === "string" ? ` · ${item.label}` : "";
    const state = typeof item.state === "string" ? item.state : "unknown";
    const address = typeof item.address === "string" ? item.address : "unknown address";
    const fired = typeof item.fired === "number" ? item.fired : 0;
    return {
      headline: `${id} · ${kind}${label} · ${state}`,
      detail: `${address} · fired ${fired}`,
      config: item.config && typeof item.config === "object" ? `config ${JSON.stringify(item.config)}` : undefined,
      rows: [],
    };
  }
  if (typeof result.deleted === "string") return { headline: `deleted ${result.deleted}`, rows: [] };
  if (Array.isArray(result.instruments)) {
    const rows = result.instruments.slice(0, 5).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return oneLine(JSON.stringify(entry));
      const item = entry as Record<string, unknown>;
      return `${String(item.id ?? "?")} · ${String(item.kind ?? "?")} · ${String(item.state ?? "?")} · fired ${String(item.fired ?? 0)}`;
    });
    return {
      headline: `${result.instruments.length} managed instrument(s)${typeof result.stopped === "number" ? ` · stopped ${result.stopped}` : ""}${typeof result.failed === "number" ? ` · failed ${result.failed}` : ""}`,
      rows,
    };
  }
  return null;
}

/** Describe-driven action chooser shared by Instrument, Analysis, and Debug. */
export function ActionPalette(props: ActionPaletteProps): React.JSX.Element {
  const { session, mode } = props;
  const windowSize = useWindowSize();
  const compact = windowSize.rows < 36 || windowSize.columns < 100;
  const actionView = ACTION_VIEW;
  const [cursor, setCursor] = useState(0);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [busy, setBusy] = useState(false);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<PageCursor | null>(null);
  const [rowOffset, setRowOffset] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [stateReceipt, setStateReceipt] = useState<ActionReceipt | null>(null);
  const [stateBusy, setStateBusy] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const normalized = useMemo(
    () => normalizeRpcDescriptors(session.describe ?? []),
    [session.describe],
  );
  const actions = useMemo(
    () => normalized.descriptors.filter((descriptor) =>
      descriptor.name !== "__describe" && authorizeAction(normalized.descriptors, mode, descriptor.name).ok)
      .sort((left, right) =>
        actionPriority(left) - actionPriority(right)
        || actionCategory(left).localeCompare(actionCategory(right))
        || actionLabel(left).localeCompare(actionLabel(right))
        || left.name.localeCompare(right.name)),
    [mode, normalized.descriptors],
  );
  const selectedIndex = Math.min(cursor, Math.max(0, actions.length - 1));
  const selected = actions[selectedIndex] ?? null;
  const categorySummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const descriptor of actions) {
      const category = actionCategory(descriptor);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return [...counts].map(([category, count]) => `${category} ${count}`).join(" · ");
  }, [actions]);
  const latest = latestForMode(session.receipts, mode);
  const latestDescriptor = latest
    ? normalized.descriptors.find((descriptor) => descriptor.name === latest.action) ?? null
    : null;
  const managedLatest = latest ? managedReceiptView(latest) : null;
  const receiptView = managedLatest ?? (latest ? jsonReceiptView(latest.result.summary) : null);
  const receiptRows = Math.max(0, Math.min(compact ? 2 : MAX_RECEIPT_ROWS, props.receiptRows ?? 5));
  const maxRowOffset = Math.max(0, (latest?.result.rows.length ?? 0) - receiptRows);
  const visibleRowOffset = Math.min(rowOffset, maxRowOffset);
  const stateView = stateReceipt ? jsonReceiptView(stateReceipt.result.summary) : null;

  useEffect(() => () => props.onCaptureChange(false), [props.onCaptureChange]);

  const beginCapture = (descriptor: CanonicalRpcDescriptor): void => {
    setCapture({ descriptor, index: 0, fields: createInstrumentForm(descriptor) });
    props.onCaptureChange(true);
  };

  const endCapture = (): void => {
    setCapture(null);
    props.onCaptureChange(false);
  };

  const stateDescriptorFor = (descriptor: CanonicalRpcDescriptor | null): CanonicalRpcDescriptor | null => {
    const linked = descriptor?.statusAction
      ? normalized.descriptors.find((candidate) => candidate.name === descriptor.statusAction) ?? null
      : null;
    if (linked && linked.args.every((arg) => arg.optional)) return linked;
    if (descriptor && descriptor.effect === "read" && descriptor.args.every((arg) => arg.optional) &&
        descriptor.capabilities.includes("analysis")) return descriptor;
    return normalized.descriptors.find((candidate) =>
      candidate.name === "modState" && candidate.effect === "read" &&
      candidate.capabilities.includes("analysis") && candidate.args.every((arg) => arg.optional)) ?? null;
  };

  const refreshState = (descriptor: CanonicalRpcDescriptor | null): void => {
    const stateDescriptor = stateDescriptorFor(descriptor);
    if (!stateDescriptor || stateBusy) return;
    setStateBusy(true);
    setStateError(null);
    void workbench.invokeAction(session.id, "analysis", stateDescriptor.name, [])
      .then((receipt) => setStateReceipt(receipt))
      .catch((error: unknown) => setStateError(error instanceof Error ? error.message : String(error)))
      .finally(() => setStateBusy(false));
  };

  useEffect(() => {
    if (mode !== "instrument" || stateReceipt !== null || session.describe === null) return;
    const initial = normalized.descriptors.find((descriptor) => descriptor.name === "modState") ?? null;
    if (initial) refreshState(initial);
    // Load one initial state snapshot per mounted live Instrument panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, session.describe, stateReceipt]);

  const invoke = (
    descriptor: CanonicalRpcDescriptor,
    rawArgs: readonly string[],
    offset = 0,
    cursor?: PageCursor,
  ): void => {
    setBusy(true);
    setInvokeError(null);
    void workbench.invokeAction(session.id, mode, descriptor.name, rawArgs, offset)
      .then((receipt) => {
        if (props.enablePaging && mode === "analysis" && receipt.status === "passed") {
          setRowOffset(0);
          setPageCursor(cursor ?? { descriptor, rawArgs: [...rawArgs], offsets: [offset], index: 0 });
        }
        if (mode === "instrument" && receipt.status === "passed") refreshState(descriptor);
      })
      .catch((error: unknown) => {
        setInvokeError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  };

  const movePage = (direction: -1 | 1): void => {
    if (!props.enablePaging || mode !== "analysis" || !pageCursor || busy || !latest) return;
    if (direction < 0) {
      if (pageCursor.index === 0) return;
      const index = pageCursor.index - 1;
      invoke(pageCursor.descriptor, pageCursor.rawArgs, pageCursor.offsets[index]!, { ...pageCursor, index });
      return;
    }
    if (latest.result.nextOffset === undefined) return;
    const index = pageCursor.index + 1;
    const offsets = pageCursor.offsets.slice();
    offsets[index] = latest.result.nextOffset;
    invoke(pageCursor.descriptor, pageCursor.rawArgs, latest.result.nextOffset, { ...pageCursor, offsets, index });
  };

  useInput((input, key) => {
    if (capture) {
      if (key.escape) {
        endCapture();
        return;
      }
      const field = capture.fields[capture.index]!;
      if (key.return) {
        const { descriptor, fields } = capture;
        const rawArgs = instrumentFormRawArgs(fields);
        const validation = coerceActionArgs(descriptor, rawArgs);
        if (!validation.ok) {
          setCapture({ ...capture, error: validation.message });
          return;
        }
        endCapture();
        invoke(descriptor, rawArgs);
        return;
      }
      if (key.upArrow) {
        setCapture({ ...capture, index: Math.max(0, capture.index - 1) });
        return;
      }
      if (key.downArrow || key.tab) {
        setCapture({ ...capture, index: Math.min(capture.fields.length - 1, capture.index + 1) });
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const fields = capture.fields.slice();
        fields[capture.index] = adjustInstrumentField(field, key.leftArrow ? -1 : 1);
        setCapture({ ...capture, fields, error: undefined });
        return;
      }
      if (key.backspace || key.delete) {
        const fields = capture.fields.slice();
        fields[capture.index] = field.arg.ui.control === "input"
          ? replaceInstrumentField(field, field.raw.slice(0, -1))
          : resetInstrumentField(field);
        setCapture({ ...capture, fields, error: undefined });
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        const fields = capture.fields.slice();
        if (field.arg.ui.control === "input") {
          fields[capture.index] = replaceInstrumentField(field, field.raw + input);
        } else if (input === " ") {
          fields[capture.index] = adjustInstrumentField(field, 1);
        }
        setCapture({ ...capture, fields, error: undefined });
      }
      return;
    }
    if (props.enablePaging && !key.ctrl && !key.meta && input === "k") {
      setRowOffset((current) => Math.max(0, current - 1));
      return;
    }
    if (props.enablePaging && !key.ctrl && !key.meta && input === "j") {
      setRowOffset((current) => Math.min(maxRowOffset, current + 1));
      return;
    }
    if (props.enablePaging && key.pageUp) {
      movePage(-1);
      return;
    }
    if (props.enablePaging && key.pageDown) {
      movePage(1);
      return;
    }
    if (!key.ctrl && !key.meta && input === "i") {
      setShowDetails((visible) => !visible);
      return;
    }
    if (!key.ctrl && !key.meta && input === "s" && mode === "instrument") {
      refreshState(selected);
      return;
    }

    if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
    else if (key.downArrow) setCursor((current) => Math.min(Math.max(0, actions.length - 1), current + 1));
    else if (key.return && selected && !busy) {
      if (selected.args.length === 0) invoke(selected, []);
      else beginCapture(selected);
    }
  }, { isActive: props.focused });

  const windowStart = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(actionView / 2), Math.max(0, actions.length - actionView)),
  );
  const visible = actions.slice(windowStart, windowStart + actionView);
  const formStart = capture
    ? Math.max(0, Math.min(capture.index - 1, Math.max(0, capture.fields.length - ACTION_VIEW)))
    : 0;
  const visibleFields = capture?.fields.slice(formStart, formStart + ACTION_VIEW) ?? [];

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>{props.title}</Text>
        {mode === "instrument" && (
          <Text dimColor>Choose a feature, edit its controls, then inspect live state below.</Text>
        )}
        <Text dimColor>
          {capture
            ? "↑/↓ field · ←/→ adjust · type input · Enter apply · Esc cancel"
            : `↑/↓ feature · Enter ${busy ? "running…" : "open/apply"} · s state · i details`}
        </Text>
        {!capture && actions.length > 0 && (
          <Text dimColor>{actions.length} actions · {categorySummary} · selected {selectedIndex + 1}</Text>
        )}
      </Box>

      {session.describe === null && <Text color="yellow">Loading game actions…</Text>}
      {session.describe !== null && actions.length === 0 && <Text dimColor>No actions are available here.</Text>}
      {normalized.warnings.length > 0 && (
        <Text color="yellow">{normalized.warnings.length} invalid descriptor(s) hidden</Text>
      )}
      {!capture && visible.map((descriptor, index) => {
        const absoluteIndex = windowStart + index;
        return (
          <Text key={descriptor.name} color={absoluteIndex === selectedIndex ? "cyan" : undefined}>
            {absoluteIndex === selectedIndex ? "❯ " : "  "}
            <Text dimColor>[{actionCategory(descriptor)}]</Text> {actionLabel(descriptor)}
          </Text>
        );
      })}
      {!capture && windowStart + visible.length < actions.length && (
        <Text dimColor>  ↓ {actions.length - windowStart - visible.length} more actions</Text>
      )}

      {!capture && selected && (
        <Box flexDirection="column" borderTop borderStyle="single" borderColor="gray">
          <Text><Text bold>{actionLabel(selected)}</Text><Text dimColor> · {actionCategory(selected)}</Text></Text>
          <Text>{selected.doc ? oneLine(selected.doc) : <Text dimColor>No description provided.</Text>}</Text>
          <Text dimColor>{effectLabel(selected)} · {inputLabel(selected)}</Text>
          {showDetails ? (
            <>
              <Text><Text bold>Technical name </Text>{signature(selected)}</Text>
              <Text dimColor>
                effect {selected.effect} · returns {selected.returns} · capabilities {selected.capabilities.join(", ")}
              </Text>
            </>
          ) : <Text dimColor>Technical details hidden.</Text>}
        </Box>
      )}

      {capture && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">{actionLabel(capture.descriptor)}</Text>
          {visibleFields.map((field, index) => {
            const absoluteIndex = formStart + index;
            const active = absoluteIndex === capture.index;
            return (
              <Text key={field.arg.name} color={active ? "cyan" : undefined}>
                {active ? "❯ " : "  "}{instrumentFieldLabel(field)} {field.arg.optional ? <Text dimColor>(optional)</Text> : null}
                {"  "}{instrumentFieldValue(field)}
              </Text>
            );
          })}
          {capture.error && <Text color="red">{oneLine(capture.error)}</Text>}
          <Text dimColor>{capture.descriptor.doc ? oneLine(capture.descriptor.doc) : effectLabel(capture.descriptor)}</Text>
        </Box>
      )}

      {mode === "instrument" && (
        <Box flexDirection="column" borderTop borderStyle="single" borderColor="cyan">
          <Text bold>Live state <Text dimColor>· s refresh</Text></Text>
          {stateBusy && <Text color="yellow">Refreshing state…</Text>}
          {!stateBusy && !stateReceipt && !stateError && <Text dimColor>No state action is linked for this feature.</Text>}
          {stateError && <Text color="red">{oneLine(stateError)}</Text>}
          {stateReceipt && !stateBusy && (
            <>
              <Text color={receiptColor(stateReceipt.status)}>
                {stateReceipt.action} · {stateView?.headline ?? oneLine(stateReceipt.result.summary || "(empty)")}
              </Text>
              {stateView?.rows.slice(0, compact ? 2 : 4).map((row, index) => (
                <Text key={`state-${index}`}>{oneLine(row, 180)}</Text>
              ))}
            </>
          )}
        </Box>
      )}

      <Box flexDirection="column" borderTop borderStyle="single" borderColor="gray">
        <Text bold>Last action result</Text>
        {!latest && <Text dimColor>No action has run yet.</Text>}
        {latest && (
          <>
            <Text color={receiptColor(latest.status)}>
              {latest.status.toUpperCase()} · {latestDescriptor ? actionLabel(latestDescriptor) : latest.action} · {receiptView?.headline ?? oneLine(latest.result.summary || "(no summary)")}
            </Text>
            {latest.error && <Text color="red">{latest.error.code}: {oneLine(latest.error.message)}</Text>}
            {latest.verification && (
              <Text color={latest.verification.state === "verified" ? "green" : latest.verification.state === "failed" ? "red" : "yellow"}>
                verification {latest.verification.state} · fired {latest.verification.fired}
                {latest.verification.detail ? ` · ${oneLine(latest.verification.detail)}` : ""}
              </Text>
            )}
            {receiptView?.detail && <Text>{receiptView.detail}</Text>}
            {receiptView?.config && <Text dimColor>{oneLine(receiptView.config)}</Text>}
            {receiptView?.rows.slice(0, compact ? 2 : receiptView.rows.length)
              .map((row, index) => <Text key={`view-${index}`}>{oneLine(row, 150)}</Text>)}
            {compact && receiptView && receiptView.rows.length > 2 && (
              <Text dimColor>+ {receiptView.rows.length - 2} more result field(s) · widen terminal to show</Text>
            )}
            {latest.result.rows.slice(visibleRowOffset, visibleRowOffset + receiptRows).map((row, index) => (
              <Text key={visibleRowOffset + index}>{oneLine(row)}</Text>
            ))}
            {latest.result.rows.length > receiptRows && (
              <Text dimColor>
                rows {visibleRowOffset + 1}-{Math.min(latest.result.rows.length, visibleRowOffset + receiptRows)}
                /{latest.result.rows.length}
              </Text>
            )}
            {props.enablePaging && pageCursor && (pageCursor.index > 0 || latest.result.nextOffset !== undefined) && (
              <Text dimColor>
                page offset {pageCursor.offsets[pageCursor.index] ?? 0}
                {latest.result.nextOffset === undefined ? " · final page" : ` · next ${latest.result.nextOffset}`}
              </Text>
            )}
          </>
        )}
        {invokeError && <Text color="red">Could not run action: {oneLine(invokeError)}</Text>}
      </Box>
    </Box>
  );
}

export function InstrumentPanel(props: ActionPanelProps): React.JSX.Element {
  return <ActionPalette {...props} mode="instrument" title="Instrument actions" />;
}
