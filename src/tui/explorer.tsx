// Explorer — describe()-driven signature browser: navigate the rpc surface,
// fill in args, invoke, inspect the result. Reads the session's cached
// RpcDescriptor[] from the store; invokes through the workbench handle.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { inspect } from "node:util";
import type { RpcDescriptor } from "../core/index.js";
import { workbench } from "./workbench.js";
import { store, type SessionState } from "./store.js";

const VIEW = 14;
const RESULT_LINES = 12;

function signature(d: RpcDescriptor): string {
  const args = (d.args ?? []).map((a) => (a.type ? `${a.name}: ${a.type}` : a.name)).join(", ");
  return `${d.name}(${args})`;
}

function parseArgs(line: string): unknown[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const v: unknown = JSON.parse(`[${trimmed}]`);
    if (Array.isArray(v)) return v;
  } catch { /* fall through to single-string arg */ }
  return [trimmed];
}

export function Explorer(props: { session: SessionState; focused: boolean }): React.JSX.Element {
  const { session } = props;
  const [cursor, setCursor] = useState(0);
  const [argTarget, setArgTarget] = useState<RpcDescriptor | null>(null);
  const [argInput, setArgInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultOffset, setResultOffset] = useState(0);

  const list = session.describe ?? [];
  const clamped = Math.min(cursor, Math.max(0, list.length - 1));

  const invoke = async (d: RpcDescriptor, args: unknown[]): Promise<void> => {
    const handle = workbench.handle(session.id);
    if (!handle) return;
    setBusy(true);
    try {
      const r = await handle.call(d.name, args);
      store.setResult(session.id, true, r === undefined ? "(undefined)" : inspect(r, { colors: false, depth: 6 }));
      store.pushHistory(session.id, `${d.name}(${args.map((a) => JSON.stringify(a) ?? "?").join(", ")})`);
    } catch (e) {
      store.setResult(session.id, false, (e as Error).message);
    }
    setResultOffset(0);
    setBusy(false);
  };

  useInput((ch, key) => {
    if (argTarget) {
      if (key.escape) { setArgTarget(null); setArgInput(""); return; }
      if (key.return) {
        const d = argTarget;
        setArgTarget(null);
        const args = parseArgs(argInput);
        setArgInput("");
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
      const handle = workbench.handle(session.id);
      if (handle) void handle.describe().then((d) => store.setDescribe(session.id, d)).catch(() => {});
    } else if (key.return && list[clamped] && !busy) {
      const d = list[clamped]!;
      if (d.args?.length) setArgTarget(d);
      else void invoke(d, []);
    }
  }, { isActive: props.focused });

  const windowStart = Math.max(0, Math.min(clamped - (VIEW >> 1), Math.max(0, list.length - VIEW)));
  const visible = list.slice(windowStart, windowStart + VIEW);
  const resultLines = (session.lastResult?.text ?? "").split("\n");
  const resultSlice = resultLines.slice(resultOffset, resultOffset + RESULT_LINES);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>explorer</Text>
        <Text dimColor>↑/↓ select · enter call · r refresh · pgup/pgdn result</Text>
      </Box>
      {session.describe === null && <Text dimColor>describe() not loaded yet (or target has no __describe)…</Text>}
      {session.describe !== null && list.length === 0 && <Text dimColor>no rpc exports reported</Text>}
      {visible.map((d, i) => {
        const idx = windowStart + i;
        return (
          <Text key={d.name} color={idx === clamped ? "cyan" : undefined}>
            {idx === clamped ? "❯ " : "  "}{signature(d)}
            {d.doc ? <Text dimColor>  — {d.doc.split("\n")[0]}</Text> : null}
          </Text>
        );
      })}
      {argTarget && (
        <Box>
          <Text color="yellow">args for {argTarget.name} (JSON, comma-sep): </Text>
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
