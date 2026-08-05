// Explorer — describe()-driven signature browser: navigate the rpc surface,
// fill in args, invoke, inspect the result. Reads the session's cached
// RpcDescriptor[] from the store; invokes through the canonical ActionService.

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RpcDescriptor } from "../core/index.js";
import { workbench } from "./workbench.js";
import { store, type SessionState } from "./store.js";

const VIEW = 14;
const RESULT_LINES = 12;

function signature(d: RpcDescriptor): string {
  const args = (d.args ?? []).map((a) => (a.type ? `${a.name}: ${a.type}` : a.name)).join(", ");
  return `${d.name}(${args})`;
}

function parseRawArgs(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const values = JSON.parse(`[${trimmed}]`) as unknown;
    if (Array.isArray(values)) {
      return values.map((value) => typeof value === "string" ? value : JSON.stringify(value));
    }
  } catch { /* preserve the exact text as one string argument */ }
  return [trimmed];
}

export function Explorer(props: { session: SessionState; focused: boolean; onCaptureChange?(active: boolean): void }): React.JSX.Element {
  const { session } = props;
  const [cursor, setCursor] = useState(0);
  const [argTarget, setArgTarget] = useState<RpcDescriptor | null>(null);
  const [argInput, setArgInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultOffset, setResultOffset] = useState(0);

  const beginArgs = (descriptor: RpcDescriptor): void => {
    setArgTarget(descriptor);
    props.onCaptureChange?.(true);
  };

  const endArgs = (): void => {
    setArgTarget(null);
    setArgInput("");
    props.onCaptureChange?.(false);
  };
  const list = session.describe ?? [];
  const clamped = Math.min(cursor, Math.max(0, list.length - 1));

  const invoke = async (descriptor: RpcDescriptor, rawArgs: string[]): Promise<void> => {
    setBusy(true);
    try {
      const receipt = await workbench.invokeAction(session.id, "instrument", descriptor.name, rawArgs);
      const page = receipt.result;
      const text = [
        page.summary,
        ...page.rows,
        ...(page.truncated ? [`… truncated${page.nextOffset === undefined ? "" : `; next offset ${page.nextOffset}`}`] : []),
        ...(receipt.verification ? [`verification: ${receipt.verification.state} · fired=${receipt.verification.fired}`] : []),
        ...receipt.warnings.map((warning) => `warning: ${warning}`),
      ].join("\n");
      store.setResult(session.id, receipt.status === "passed", receipt.error?.message ?? text);
      store.pushHistory(session.id, `instrument:${descriptor.name}(${rawArgs.map((arg) => JSON.stringify(arg)).join(", ")})`);
    } catch (error) {
      store.setResult(session.id, false, (error as Error).message);
    }
    setResultOffset(0);
    setBusy(false);
  };

  useEffect(() => () => props.onCaptureChange?.(false), [props.onCaptureChange]);

  useInput((ch, key) => {
    if (argTarget) {
      if (key.escape) { endArgs(); return; }
      if (key.return) {
        const d = argTarget;
        const args = parseRawArgs(argInput);
        endArgs();
        void invoke(d, args);
        return;
      }
      if (key.backspace || key.delete) { setArgInput((s) => s.slice(0, -1)); return; }
      if (key.ctrl || key.meta) return;
      if (ch) setArgInput((s) => s + ch);
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(list.length - 1, c + 1));
    else if (key.pageDown) setResultOffset((o) => o + RESULT_LINES);
    else if (key.pageUp) setResultOffset((o) => Math.max(0, o - RESULT_LINES));
    else if (ch === "r") {
      void workbench.refreshDescribe(session.id).catch(() => {});
    } else if (key.return && list[clamped] && !busy) {
      const d = list[clamped]!;
      if (d.args?.length) beginArgs(d);
      else void invoke(d, []);
    }
  }, { isActive: props.focused });

  const windowStart = Math.max(0, Math.min(clamped - (VIEW >> 1), Math.max(0, list.length - VIEW)));
  const visible = list.slice(windowStart, windowStart + VIEW);
  const resultLines = (session.lastResult?.text ?? "").split("\n");
  const resultSlice = resultLines.slice(resultOffset, resultOffset + RESULT_LINES);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>explorer · Instrument RPC surface</Text>
        <Text dimColor>↑/↓ select · enter call · r refresh · pgup/pgdn result</Text>
      </Box>
      {session.describe === null && <Text dimColor>describe() not loaded yet (or target has no __describe)…</Text>}
      {session.describe !== null && list.length === 0 && <Text dimColor>no rpc exports reported</Text>}
      {visible.map((d, i) => {
        const idx = windowStart + i;
        return (
          <Text key={d.name} color={idx === clamped ? "cyan" : undefined}>
            {idx === clamped ? "❯ " : "  "}{signature(d)}
            <Text color={d.effect === "write" || d.effect === "hook" ? "yellow" : "gray"}> [{d.effect ?? "control"}/{d.returns ?? "json"}]</Text>
            {d.doc ? <Text dimColor> — {d.doc.split("\n")[0]}</Text> : null}
          </Text>
        );
      })}
      {argTarget && (
        <Box>
          <Text color="yellow">args for {argTarget.name} (JSON values, comma-sep): </Text>
          <Text>{argInput}</Text>
        </Box>
      )}
      <Box flexDirection="column" borderTop borderStyle="single" borderColor="gray">
        <Text dimColor>
          {busy ? "calling …" : session.lastResult
            ? `${session.lastResult.ok ? "result" : "error"} (${resultLines.length} line(s), offset ${resultOffset})`
            : "no result yet"}
        </Text>
        {resultSlice.map((l, i) => (
          <Text key={i} color={session.lastResult?.ok ? "white" : "red"}>{l}</Text>
        ))}
        {resultOffset + RESULT_LINES < resultLines.length && (
          <Text dimColor>… {resultLines.length - resultOffset - RESULT_LINES} more — pgdn</Text>
        )}
      </Box>
    </Box>
  );
}
