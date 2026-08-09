// REPL — eval against the live agent with history, tab completion over the
// describe() surface, backslash-continued multiline, user macros, and a
// paged result inspector (page budget: 200 captured lines, 24 rendered).

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { inspect } from "node:util";
import { workbench } from "./workbench.js";
import { store, type SessionState } from "./store.js";

const PAGE_CAPTURE = 200;
const PAGE_RENDER = 24;

/** Per-session macro table (UI-level state, not render state). */
const macros = new Map<number, Map<string, string>>();

/** Release a removed session's macro table (row removal cleanup path). */
export function dropReplState(id: number): void {
  macros.delete(id);
}

function macroTable(id: number): Map<string, string> {
  let t = macros.get(id);
  if (!t) {
    t = new Map();
    macros.set(id, t);
  }
  return t;
}

const META = [":help", ":macros", ":macro", ":clear", ":exports"];

export function Repl(props: { session: SessionState; focused: boolean }): React.JSX.Element {
  const { session } = props;
  const [input, setInput] = useState("");
  const [multi, setMulti] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);

  const table = macroTable(session.id);

  const runEval = async (src: string): Promise<void> => {
    setBusy(true);
    store.pushLog(session.id, `${session.target}> ${src}`);
    store.pushHistory(session.id, src);
    try {
      const r = await workbench.eval(session.id, src);
      const text = r === undefined ? "(undefined)" : inspect(r, { colors: false, depth: 6 });
      store.setResult(session.id, true, text.split("\n").slice(0, PAGE_CAPTURE).join("\n"));
    } catch (e) {
      store.setResult(session.id, false, (e as Error).message);
    }
    setOffset(0);
    setBusy(false);
    setHistIdx(null);
  };

  const handleMeta = (src: string): boolean => {
    if (src === ":help") {
      store.setResult(session.id, true, [
        ":help                 this text",
        ":exports              list describe() exports",
        ":macros               list macros",
        ":macro name body      define macro (body runs through eval)",
        ":name                 run macro",
        ":clear                clear the result pane",
        "history: ↑/↓ · autocomplete: tab · multiline: end a line with \\",
      ].join("\n"));
      return true;
    }
    if (src === ":exports") {
      const names = (session.describe ?? []).map((d) => d.name);
      store.setResult(session.id, true, names.join("\n") || "(no describe data — try the explorer's r)");
      return true;
    }
    if (src === ":macros") {
      const rows = [...table.entries()].map(([k, v]) => `:${k}  =  ${v}`);
      store.setResult(session.id, true, rows.join("\n") || "(no macros)");
      return true;
    }
    if (src === ":clear") {
      store.setResult(session.id, true, "");
      return true;
    }
    const def = /^:macro\s+(\w+)\s+(.+)$/s.exec(src);
    if (def) {
      table.set(def[1]!, def[2]!);
      store.setResult(session.id, true, `macro :${def[1]} defined`);
      return true;
    }
    const use = /^:(\w+)$/.exec(src);
    if (use && table.has(use[1]!)) {
      void runEval(table.get(use[1]!)!);
      return true;
    }
    return false;
  };

  const complete = (): void => {
    const m = /([:@\w.]+)$/.exec(input);
    if (!m) return;
    const prefix = m[1]!;
    const pool = [
      ...(session.describe ?? []).map((d) => d.name),
      ...[...table.keys()].map((k) => `:${k}`),
      ...META,
    ];
    const hits = pool.filter((c) => c.startsWith(prefix) && c !== prefix);
    if (hits.length === 1) {
      setInput(input.slice(0, input.length - prefix.length) + hits[0]!);
    } else if (hits.length > 1) {
      store.setResult(session.id, true, hits.join("  "));
    }
  };

  useInput((ch, key) => {
    if (key.upArrow && histIdx !== -1) {
      const h = session.history;
      if (!h.length) return;
      const next = histIdx === null ? h.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(h[next]!);
      return;
    }
    if (key.downArrow && histIdx !== null) {
      const next = histIdx + 1;
      if (next >= session.history.length) { setHistIdx(null); setInput(""); }
      else { setHistIdx(next); setInput(session.history[next]!); }
      return;
    }
    if (key.tab) { complete(); return; }
    if (key.return) {
      if (busy) return;
      const line = input;
      setInput("");
      if (line.endsWith("\\")) {
        setMulti((m) => [...m, line.slice(0, -1)]);
        return;
      }
      const parts = [...multi, line];
      setMulti([]);
      const src = parts.join("\n").trim();
      if (!src) return;
      if (handleMeta(src)) return;
      void runEval(src);
      return;
    }
    if (key.pageDown) { setOffset((o) => o + PAGE_RENDER); return; }
    if (key.pageUp) { setOffset((o) => Math.max(0, o - PAGE_RENDER)); return; }
    if (key.escape) { setMulti([]); setInput(""); setHistIdx(null); return; }
    if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); setHistIdx(null); return; }
    if (key.ctrl || key.meta) return;
    if (ch) { setInput((s) => s + ch); setHistIdx(null); }
  }, { isActive: props.focused });

  const resultLines = (session.lastResult?.text ?? "").split("\n");
  const slice = resultLines.slice(offset, offset + PAGE_RENDER);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>repl</Text>
        <Text dimColor>:help · Tab complete · Enter run</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {session.lastResult === null && <Text dimColor>eval runs with rpc.exports in scope — e.g. await ping()</Text>}
        {slice.map((l, i) => (
          <Text key={i} color={session.lastResult?.ok ? "white" : "red"}>{l}</Text>
        ))}
        {offset + PAGE_RENDER < resultLines.length && (
          <Text dimColor>… {resultLines.length - offset - PAGE_RENDER} more — pgdn</Text>
        )}
      </Box>
      <Box borderTop borderStyle="single" borderColor="gray">
        <Text color="green">{multi.length ? "… " : `${session.target}> `}</Text>
        <Text>{input}</Text>
        {busy && <Text color="yellow"> (running…)</Text>}
      </Box>
    </Box>
  );
}
