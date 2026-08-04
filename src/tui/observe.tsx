// Observe — structured log stream with level/tag preservation, substring
// filter, minimum-level filter, freeze (pin the view while the ring keeps
// collecting), crash report view, and a hook-state probe.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { inspect } from "node:util";
import { workbench } from "./workbench.js";
import { store, type LogLine, type SessionState } from "./store.js";

const VIEW = 20;
const LEVELS: Array<LogLine["level"] | "all"> = ["all", "info", "ok", "warn", "error"];
const LEVEL_RANK: Record<LogLine["level"], number> = { info: 0, ok: 1, warn: 2, error: 3 };

const levelTint: Record<LogLine["level"], string> = {
  info: "gray", ok: "green", warn: "yellow", error: "red",
};

function matches(l: LogLine, filter: string, minLevel: LogLine["level"] | "all"): boolean {
  if (minLevel !== "all" && LEVEL_RANK[l.level] < LEVEL_RANK[minLevel]) return false;
  if (filter && !l.text.toLowerCase().includes(filter.toLowerCase())) return false;
  return true;
}

export function Observe(props: { session: SessionState; focused: boolean }): React.JSX.Element {
  const { session } = props;
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [minLevel, setMinLevel] = useState<LogLine["level"] | "all">("all");
  const [scroll, setScroll] = useState(0);
  const [showCrashes, setShowCrashes] = useState(false);
  const [frozenView, setFrozenView] = useState<LogLine[] | null>(null);
  const [hookState, setHookState] = useState<string | null>(null);

  const source = session.frozen && frozenView !== null ? frozenView : session.logs;
  const visible = source.filter((l) => matches(l, filter, minLevel));
  const end = Math.max(VIEW, visible.length - scroll);
  const slice = visible.slice(Math.max(0, end - VIEW), end);

  useInput((ch, key) => {
    if (filtering) {
      if (key.return || key.escape) { setFiltering(false); return; }
      if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); return; }
      if (key.ctrl || key.meta) return;
      if (ch) setFilter((f) => f + ch);
      return;
    }
    if (key.pageDown) { setScroll((s) => Math.max(0, s - VIEW)); return; }
    if (key.pageUp) { setScroll((s) => s + VIEW); return; }
    if (ch === "/") { setFiltering(true); return; }
    if (ch === "x") { setFilter(""); setMinLevel("all"); return; }
    if (ch === "l") {
      setMinLevel((cur) => LEVELS[(LEVELS.indexOf(cur) + 1) % LEVELS.length]!);
      return;
    }
    if (ch === "f") {
      if (session.frozen) {
        store.toggleFrozen(session.id);
        setFrozenView(null);
      } else {
        setFrozenView([...session.logs]);
        store.toggleFrozen(session.id);
      }
      return;
    }
    if (ch === "c") { setShowCrashes((v) => !v); return; }
    if (ch === "h") {
      const handle = workbench.handle(session.id);
      if (!handle) return;
      setHookState("probing …");
      void handle
        .eval('typeof hookState === "function" ? await hookState() : "(target exports no hookState)"')
        .then((r) => setHookState(inspect(r, { colors: false, depth: 4 })))
        .catch((e) => setHookState((e as Error).message));
    }
  }, { isActive: props.focused });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>observe</Text>
        <Text dimColor>/ filter · l level({minLevel}) · f freeze · c crashes · h hook state · pgup/pgdn</Text>
      </Box>
      {session.dropped > 0 && (
        <Text dimColor>… {session.dropped} line(s) evicted from the 5000-line ring</Text>
      )}
      {filtering && (
        <Box>
          <Text color="yellow">/ </Text>
          <Text>{filter}</Text>
        </Box>
      )}
      {!filtering && filter && <Text dimColor>filter: "{filter}" ({visible.length} match)</Text>}
      {showCrashes ? (
        <Box flexDirection="column">
          <Text bold color="red">crashes ({session.crashes.length})</Text>
          {session.crashes.length === 0 && <Text dimColor>none — excrash install() reports appear here</Text>}
          {session.crashes.slice(-VIEW).map((c, i) => (
            <Text key={i} color="red">{inspect(c, { colors: false, depth: 3, breakLength: 120 })}</Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {slice.map((l, i) => (
            <Text key={`${l.ts}-${i}`} color={levelTint[l.level]}>
              {l.tag ? `[${l.tag}] ` : ""}{l.text}
            </Text>
          ))}
          {visible.length === 0 && <Text dimColor>(no lines match)</Text>}
        </Box>
      )}
      {hookState !== null && (
        <Box borderTop borderStyle="single" borderColor="gray">
          <Text color="cyan">hookState: </Text>
          <Text>{hookState.split("\n").slice(0, 4).join(" ")}</Text>
        </Box>
      )}
    </Box>
  );
}
