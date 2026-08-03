// Ink TUI — the human frontend. Menus map 1:1 onto the command registry;
// the run view streams agent logs and accepts rpc calls by bare name.

import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, Static, useInput, useApp } from "ink";
import { inspect } from "node:util";
import { listTargets, startSession, type GameSession } from "../core/index.js";

type Line = { kind: "log" | "cmd" | "result" | "error" | "status"; text: string };
const tint: Record<Line["kind"], string | undefined> = {
  log: "gray", cmd: "cyan", result: "white", error: "red", status: "green",
};

type Phase =
  | { name: "picker"; index: number }
  | { name: "connecting"; target: string }
  | { name: "session"; target: string };

function App({ initialTarget }: { initialTarget?: string }) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>(
    initialTarget ? { name: "connecting", target: initialTarget } : { name: "picker", index: 0 },
  );
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const sessionRef = useRef<GameSession | null>(null);
  const busyRef = useRef(false);
  const targets = listTargets();

  const push = (kind: Line["kind"], text: string): void =>
    setLines((prev) => [...prev.slice(-500), { kind, text }]);

  const teardown = async (): Promise<void> => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s) await s.close();
  };

  useEffect(() => {
    if (phase.name !== "connecting") return;
    const target = phase.target;
    void (async () => {
      push("status", `compiling ${target} …`);
      try {
        const s = await startSession(
          { target },
          {
            onLog: (l) => push("log", l),
            onError: (l) => push("error", l),
            onClose: (reason) => {
              push("status", `detached: ${reason}`);
              void teardown().then(() => setPhase({ name: "picker", index: 0 }));
            },
          },
        );
        sessionRef.current = s;
        setPhase({ name: "session", target });
        push("status", `attached — pid ${s.pid}. exports: ${s.rpcNames().join(", ") || "(none)"} · :back / :quit`);
      } catch (e) {
        push("error", (e as Error).message);
        setPhase({ name: "picker", index: 0 });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => () => { void teardown(); }, []);

  useInput(async (ch, key) => {
    if (phase.name === "picker") {
      if (key.upArrow) setPhase({ name: "picker", index: Math.max(0, phase.index - 1) });
      else if (key.downArrow) setPhase({ name: "picker", index: Math.min(targets.length - 1, phase.index + 1) });
      else if (key.return && targets[phase.index]) setPhase({ name: "connecting", target: targets[phase.index]! });
      else if (key.escape || (key.ctrl && ch === "c")) { await teardown(); exit(); }
      return;
    }
    if (phase.name !== "session") return;

    if (key.return) {
      const src = input.trim();
      setInput("");
      if (!src || busyRef.current) return;
      if (src === ":quit") { await teardown(); exit(); return; }
      if (src === ":back") { await teardown(); setPhase({ name: "picker", index: 0 }); return; }
      push("cmd", `${phase.target}> ${src}`);
      busyRef.current = true;
      try {
        const result = await sessionRef.current?.eval(src);
        if (result !== undefined) push("result", inspect(result, { colors: false, depth: 6 }));
      } catch (e) { push("error", (e as Error).message); }
      busyRef.current = false;
      return;
    }
    if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); return; }
    if (key.ctrl || key.meta) return;
    if (ch) setInput((s) => s + ch);
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(l, i) => <Text key={i} color={tint[l.kind]}>{l.text}</Text>}
      </Static>
      {phase.name === "picker" && (
        <Box flexDirection="column">
          <Text bold>flab — select target (↑/↓ + enter, esc quits)</Text>
          {targets.length === 0 && <Text color="yellow">no targets registered — run: flab new &lt;name&gt;</Text>}
          {targets.map((t, i) => (
            <Text key={t} color={i === phase.index ? "green" : undefined}>{i === phase.index ? "❯ " : "  "}{t}</Text>
          ))}
        </Box>
      )}
      {phase.name === "connecting" && <Text color="yellow">connecting to {phase.target} …</Text>}
      {phase.name === "session" && (
        <Box>
          <Text color="green">{phase.target}{"> "}</Text>
          <Text>{input}</Text>
        </Box>
      )}
    </Box>
  );
}

export async function runTui(target?: string): Promise<void> {
  render(<App initialTarget={target} />);
}
