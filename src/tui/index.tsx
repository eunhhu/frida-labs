// Ink TUI — the human frontend. Composition root: StatusHeader + Sidebar
// (targets/sessions) + one focused panel (repl / explorer / observe) over the
// external store. Every session action goes through the workbench (which
// drives the SessionEngine core); panels only render store state.

import React, { useEffect, useSyncExternalStore } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { listTargets } from "../core/index.js";
import { store, MAX_SESSIONS } from "./store.js";
import { workbench, Sidebar, StatusHeader } from "./workbench.js";
import { Repl } from "./repl.js";
import { Explorer } from "./explorer.js";
import { Observe } from "./observe.js";

type Panel = "repl" | "explorer" | "observe";
const PANELS: Panel[] = ["repl", "explorer", "observe"];
type Focus = "targets" | "sessions" | "panel";

function App({ initialTarget, initialProc }: { initialTarget?: string; initialProc?: string }): React.JSX.Element {
  const { exit } = useApp();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const state = store.snapshot;
  const targets = listTargets();

  const [panel, setPanel] = React.useState<Panel>("repl");
  const [focus, setFocus] = React.useState<Focus>("targets");
  const [pickerIndex, setPickerIndex] = React.useState(0);
  const [sessionIndex, setSessionIndex] = React.useState(0);
  const [notice, setNotice] = React.useState<string | null>(null);

  useEffect(() => {
    if (initialTarget) {
      workbench.attach(initialTarget, initialProc);
      setFocus("panel");
    }
    return () => { void workbench.closeAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Keep the sidebar session cursor inside the live list.
    if (sessionIndex >= state.sessions.length) setSessionIndex(Math.max(0, state.sessions.length - 1));
  }, [state.sessions.length, sessionIndex]);

  const active = store.session(state.activeId);

  useInput((ch, key) => {
    if (key.ctrl && ch === "q") {
      void workbench.closeAll().then(() => exit());
      return;
    }
    if (key.ctrl && ch === "r" && active && (active.status === "detached" || active.status === "error")) {
      workbench.reconnect(active.id);
      return;
    }
    if (key.ctrl && ch === "w" && active) {
      void workbench.close(active.id);
      return;
    }
    if (key.tab) {
      if (focus !== "panel") { setFocus("panel"); return; }
      setPanel((p) => PANELS[(PANELS.indexOf(p) + 1) % PANELS.length]!);
      return;
    }
    if (key.escape && focus === "panel") { setFocus(state.sessions.length ? "sessions" : "targets"); return; }
    if (focus === "panel") return; // panel's own useInput (isActive) handles the rest

    if (key.ctrl && ch === "t") { setFocus("targets"); return; }
    if (key.ctrl && ch === "s") { setFocus("sessions"); return; }
    if (key.leftArrow) { setFocus("targets"); return; }
    if (key.rightArrow && state.sessions.length) { setFocus("sessions"); return; }

    if (focus === "targets") {
      if (key.upArrow) setPickerIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPickerIndex((i) => Math.min(targets.length - 1, i + 1));
      else if (key.return && targets[pickerIndex]) {
        if (state.sessions.length >= MAX_SESSIONS) {
          setNotice(`session cap reached (${MAX_SESSIONS}) — ^w closes the active one`);
          return;
        }
        setNotice(null);
        workbench.attach(targets[pickerIndex]!);
        setFocus("panel");
      }
      return;
    }
    // sessions list
    if (key.upArrow) setSessionIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSessionIndex((i) => Math.min(state.sessions.length - 1, i + 1));
    else if (key.return && state.sessions[sessionIndex]) {
      store.setActive(state.sessions[sessionIndex]!.id);
      setFocus("panel");
    }
  });

  return (
    <Box flexDirection="column">
      <StatusHeader session={active} />
      <Box>
        <Sidebar
          targets={targets}
          pickerIndex={pickerIndex}
          sessions={state.sessions}
          activeId={state.activeId}
          focus={focus === "sessions" ? "sessions" : "targets"}
        />
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focus === "panel" ? "cyan" : "gray"}>
          <Box paddingX={1} justifyContent="space-between">
            <Text dimColor>
              {PANELS.map((p) => (p === panel ? `[${p}]` : ` ${p} `)).join(" ")}
            </Text>
            {notice && <Text color="yellow">{notice}</Text>}
          </Box>
          {active ? (
            <>
              <Box display={panel === "repl" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
                <Repl key={`r${active.id}`} session={active} focused={focus === "panel" && panel === "repl"} />
              </Box>
              <Box display={panel === "explorer" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
                <Explorer key={`e${active.id}`} session={active} focused={focus === "panel" && panel === "explorer"} />
              </Box>
              <Box display={panel === "observe" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
                <Observe key={`o${active.id}`} session={active} focused={focus === "panel" && panel === "observe"} />
              </Box>
            </>
          ) : (
            <Box paddingX={1} flexDirection="column">
              <Text dimColor>attach a target to start — enter on the targets list</Text>
              <Text dimColor>panels: repl (eval) · explorer (describe browser) · observe (logs/crashes)</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

export async function runTui(target?: string, proc?: string): Promise<void> {
  render(<App initialTarget={target} initialProc={proc} />);
}
