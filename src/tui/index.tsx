// Ink workspace: one persistent SessionWorkbench with three human modes:
// Connect, Analyze, and Instrument. Advanced surfaces stay contextual instead
// of becoming additional top-level modes.
import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import { render, Box, Text, useInput, useApp, useWindowSize } from "ink";
import {
  discoverProcesses,
  discoverDevices,
  deviceSelectorKey,
  deviceSelectorLabel,
  normalizeDeviceSelector,
  listTargets,
  type DeviceSelector,
  type LaunchRequest,
  type ProcessCandidate,
  type TargetLaunch,
} from "../core/index.js";
import { store, MAX_SESSIONS } from "./store.js";
import { workbench, Sidebar, StatusHeader } from "./workbench.js";
import { Repl, dropReplState } from "./repl.js";
import { Explorer } from "./explorer.js";
import { Observe } from "./observe.js";
import { ProjectPanel } from "./project.js";
import type { ProjectCreateRequest } from "./project.js";
import { InstrumentPanel } from "./instrument.js";
import { TargetLaunchPanel } from "./probe.js";
import { AnalysisPanel } from "./analysis.js";
import { RecordPanel } from "./record.js";
import {
  MODE_PALETTE_ITEMS,
  ModeBar,
  ModePalette,
  selectPaletteRoute,
  modeRoute,
  routeGlobalInput,
  type WorkspaceSurface,
  type TuiMode,
} from "./modebar.js";

export const ANALYSIS_SURFACES: readonly WorkspaceSurface[] = ["actions", "explorer", "record"];
export const INSTRUMENT_SURFACES: readonly WorkspaceSurface[] = ["actions", "repl", "observe"];
const SURFACE_LABELS: Record<WorkspaceSurface, string> = {
  actions: "controls",
  repl: "advanced console",
  explorer: "memory",
  observe: "events",
  debug: "checks",
  record: "record",
};
type Focus = "processes" | "targets" | "sessions" | "panel";
type PendingTargetLaunch = Pick<TargetLaunch, "target" | "processOverride" | "device">;

export function surfacesForMode(mode: "analysis" | "instrument"): readonly WorkspaceSurface[] {
  return mode === "analysis" ? ANALYSIS_SURFACES : INSTRUMENT_SURFACES;
}

export function cycleSurface(mode: "analysis" | "instrument", surface: WorkspaceSurface): WorkspaceSurface {
  const surfaces = surfacesForMode(mode);
  const index = surfaces.indexOf(surface);
  return surfaces[(Math.max(0, index) + 1) % surfaces.length]!;
}

export function launchForProcess(process: ProcessCandidate): LaunchRequest {
  const matchedTarget = process.matchedTargets[0];
  return matchedTarget
    ? { kind: "target", target: matchedTarget, processOverride: process.name }
    : { kind: "probe-attach-pid", pid: process.pid, display: process.name };
}

export function launchOnDevice(request: LaunchRequest, device: DeviceSelector): LaunchRequest {
  return { ...request, device } as LaunchRequest;
}

export function suggestedTargetName(processName: string): string {
  return processName
    .replace(/^.*[\\/]/, "")
    .replace(/\.(exe|app|bin\.[a-z]+)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "new-target";
}

export function processChoices(
  processes: readonly ProcessCandidate[],
  query: string,
  searchActive: boolean,
): ProcessCandidate[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? processes.filter((process) =>
        `${process.pid} ${process.name} ${process.matchedTargets.join(" ")}`.toLowerCase().includes(normalized))
    : searchActive
      ? processes.filter((process) => process.matchedTargets.length > 0)
      : [...processes];
  return [...filtered].sort((left, right) =>
    Number(right.matchedTargets.length > 0) - Number(left.matchedTargets.length > 0));
}

function HelpPanel(): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">How flab works</Text>
      <Text><Text bold>1 Connect</Text> — choose a device and a running app or saved game.</Text>
      <Text><Text bold>2 Analyze</Text> — discover structure, memory, and Record one human-play scenario.</Text>
      <Text><Text bold>3 Instrument</Text> — run linked game features and inspect output.</Text>
      <Text> </Text>
      <Text bold>Instrument controls</Text>
      <Text>Enter opens up to three fields · Space/←/→ changes checkbox, slider, or choice.</Text>
      <Text>Type into text/value fields · Enter applies · s refreshes the linked live state.</Text>
      <Text>The advanced console accepts .help, /help, or :help.</Text>
      <Text> </Text>
      <Text>Navigate: ↑/↓ choose · Enter open · Esc back</Text>
      <Text>Workspace: Ctrl+P switch · ] next surface · ? help</Text>
      <Text>Session: Ctrl+R retry · Ctrl+W close · Ctrl+Q quit</Text>
      <Text color="yellow">? or Esc → close help</Text>
    </Box>
  );
}

function NoSession({ mode }: { mode: TuiMode }): React.JSX.Element {
  return (
    <Box paddingX={2} paddingY={1} flexDirection="column">
      <Text bold color="cyan">Connect a game first</Text>
      <Text>{mode === "analysis" ? "Analyze" : "Instrument"} opens after a live connection exists.</Text>
      <Text>Press Ctrl+D, type the game name, then press Enter.</Text>
      <Text dimColor>Ctrl+V device · Ctrl+D running apps · Ctrl+T saved games</Text>
    </Box>
  );
}

function ConnectPanel(props: {
  focus: Focus;
  deviceLabel: string;
  selectedProcess?: ProcessCandidate;
  selectedTarget?: string;
  processQuery: string;
  processFilterActive: boolean;
  processesLoading: boolean;
  processesError: string | null;
}): React.JSX.Element {
  const process = props.selectedProcess;
  const matchedTarget = process?.matchedTargets[0];
  const showingTargets = props.focus === "targets";
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">1. Connect a game</Text>
      <Text>Device: {props.deviceLabel}</Text>
      <Text dimColor>Ctrl+V changes between local, USB/mobile, exact, and remote devices.</Text>
      <Text> </Text>
      {showingTargets ? (
        props.selectedTarget ? (
          <>
            <Text bold>Saved game</Text>
            <Text color="green">{props.selectedTarget}</Text>
            <Text>Uses its saved process and launch settings on the selected device.</Text>
            <Text> </Text>
            <Text bold color="green">Enter → review and connect</Text>
            <Text dimColor>m → manage saved games · Tab → running apps</Text>
          </>
        ) : (
          <>
            <Text color="yellow">No saved games yet.</Text>
            <Text>Tab to running apps, select one, then press n to save it.</Text>
          </>
        )
      ) : props.processesLoading ? (
        <Text color="yellow">Finding running apps…</Text>
      ) : props.processesError ? (
        <>
          <Text color="red">Could not list running apps.</Text>
          <Text>{props.processesError}</Text>
          <Text dimColor>Press r to retry or Ctrl+V to choose another device.</Text>
        </>
      ) : props.processFilterActive && !props.processQuery && !process ? (
        <>
          <Text bold>Search running apps</Text>
          <Text color="yellow">Start typing the game or app name.</Text>
          <Text>Only saved-game matches appear before you type, so system processes stay out of the way.</Text>
          <Text dimColor>Esc → show every process · Tab → saved games</Text>
        </>
      ) : process ? (
        <>
          <Text bold>Selected running app</Text>
          <Text color="cyan">{process.name} <Text dimColor>PID {process.pid}</Text></Text>
          {matchedTarget ? (
            <Text color="green">Saved game tools found: {matchedTarget}</Text>
          ) : (
            <Text>No saved tools yet. flab will connect with safe generic analysis.</Text>
          )}
          <Text> </Text>
          <Text bold color="green">Enter → {matchedTarget ? "review and connect" : "connect for quick analysis"}</Text>
          {!matchedTarget && <Text dimColor>n → save this app as a reusable game target</Text>}
        </>
      ) : (
        <>
          <Text color="yellow">No running app matches “{props.processQuery}”.</Text>
          <Text dimColor>Keep typing, Ctrl+U clears, or Esc shows every process.</Text>
        </>
      )}
      <Text> </Text>
      <Text dimColor>Flow: Connect → Analyze → Instrument</Text>
    </Box>
  );
}

export function App({
  initialTarget,
  initialProc,
  initialDevice,
  initialSpawn,
  initialNoWatch,
}: {
  initialTarget?: string;
  initialProc?: string;
  initialDevice?: DeviceSelector;
  initialSpawn?: boolean;
  initialNoWatch?: boolean;
}): React.JSX.Element {
  const { exit } = useApp();
  const windowSize = useWindowSize();
  // Switch before content starts wrapping/cropping, not only after the pane is
  // already too small. Keep this aligned with ActionPalette's compact budget.
  const compact = windowSize.columns < 110 || windowSize.rows < 36;
  const minimal = windowSize.columns < 90 || windowSize.rows < 28;
  useSyncExternalStore(store.subscribe, store.getVersion);
  const state = store.snapshot;
  const [targetVersion, setTargetVersion] = React.useState(0);
  void targetVersion;
  const targets = listTargets();
  const [device, setDevice] = React.useState<DeviceSelector>(() => normalizeDeviceSelector(initialDevice));
  const [deviceOptions, setDeviceOptions] = React.useState<DeviceSelector[]>(() => [normalizeDeviceSelector(initialDevice)]);
  const [deviceLabels, setDeviceLabels] = React.useState<Record<string, string>>({});

  const [mode, setMode] = React.useState<TuiMode>(initialTarget ? "instrument" : "project");
  const [surface, setSurface] = React.useState<WorkspaceSurface>("actions");
  const [focus, setFocus] = React.useState<Focus>(initialTarget ? "panel" : "processes");
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteIndex, setPaletteIndex] = React.useState(0);
  const [processes, setProcesses] = React.useState<ProcessCandidate[]>([]);
  const [processesLoading, setProcessesLoading] = React.useState(true);
  const [processesError, setProcessesError] = React.useState<string | null>(null);
  const [processIndex, setProcessIndex] = React.useState(0);
  const [processQuery, setProcessQuery] = React.useState("");
  const [processFilterActive, setProcessFilterActive] = React.useState(!initialTarget);
  const [pickerIndex, setPickerIndex] = React.useState(0);
  const [sessionIndex, setSessionIndex] = React.useState(0);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [targetLaunch, setTargetLaunch] = React.useState<PendingTargetLaunch | null>(null);
  const [projectCreateRequest, setProjectCreateRequest] = React.useState<ProjectCreateRequest | null>(null);
  const [showHelp, setShowHelp] = React.useState(false);
  const [inputCaptured, setInputCaptured] = React.useState(false);

  const visibleProcesses = React.useMemo(
    () => processChoices(processes, processQuery, processFilterActive),
    [processFilterActive, processQuery, processes],
  );

  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      const choices = await discoverDevices();
      const discovered = choices.map((choice) => choice.selector);
      setDeviceLabels(Object.fromEntries(choices.map((choice) => [
        deviceSelectorKey(choice.selector),
        `${choice.info.name} [${choice.info.id}]`,
      ])));
      setDeviceOptions((current) => {
        const merged = [device, ...discovered, ...current];
        return merged.filter((selector, index) =>
          merged.findIndex((candidate) => deviceSelectorKey(candidate) === deviceSelectorKey(selector)) === index);
      });
    } catch {
      // Process discovery surfaces the actionable selected-device error.
    }
  }, [device]);

  const refreshProcesses = useCallback(async (): Promise<void> => {
    setProcessesLoading(true);
    setProcessesError(null);
    try {
      const rows = await discoverProcesses({ limit: 5000, device });
      setProcesses(rows);
      setProcessIndex((index) => Math.min(index, Math.max(0, rows.length - 1)));
    } catch (error) {
      setProcessesError((error as Error).message);
    }
    setProcessesLoading(false);
  }, [device]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    void refreshProcesses();
  }, [refreshProcesses]);

  useEffect(() => {
    if (initialTarget) workbench.open({
      kind: "target",
      target: initialTarget,
      ...(initialProc ? { processOverride: initialProc } : {}),
      ...(initialSpawn ? { spawn: true } : {}),
      ...(initialNoWatch ? { noWatch: true } : {}),
      ...(initialDevice ? { device: initialDevice } : {}),
    });
    return () => { void workbench.closeAll(); };
    // Initial launch is intentionally one-shot; reconnect owns later attempts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sessionIndex >= state.sessions.length) setSessionIndex(Math.max(0, state.sessions.length - 1));
  }, [state.sessions.length, sessionIndex]);

  useEffect(() => {
    if (pickerIndex >= targets.length) setPickerIndex(Math.max(0, targets.length - 1));
  }, [pickerIndex, targets.length]);

  useEffect(() => {
    if (processIndex >= visibleProcesses.length) setProcessIndex(Math.max(0, visibleProcesses.length - 1));
  }, [processIndex, visibleProcesses.length]);

  const active = store.session(state.activeId);
  const selectedProcess = visibleProcesses[processIndex];
  const selectedTarget = targets[pickerIndex];
  const route = modeRoute(mode, active?.id ?? null);
  const selectedDeviceLabel = deviceLabels[deviceSelectorKey(device)] ?? deviceSelectorLabel(device);

  const openSession = (
    opened: ReturnType<typeof workbench.open>,
    destination: "instrument" | "analyze" = "instrument",
  ): void => {
    if (!opened) {
      setNotice(`session cap reached (${MAX_SESSIONS}) — Ctrl+W closes active session`);
      return;
    }
    setNotice(null);
    setMode(destination === "analyze" ? "analysis" : "instrument");
    setSurface("actions");
    setFocus("panel");
  };

  const openLaunch = (request: LaunchRequest): void => {
    const selectedRequest = launchOnDevice(request, device);
    if (selectedRequest.kind === "target") {
      setTargetLaunch({
        target: selectedRequest.target,
        ...(selectedRequest.processOverride ? { processOverride: selectedRequest.processOverride } : {}),
        device,
      });
      setFocus("panel");
      return;
    }
    openSession(workbench.open(selectedRequest), "analyze");
  };

  const openProjectMode = (message: string): void => {
    setMode("project");
    setFocus("panel");
    setNotice(message);
  };

  const cycleDevice = (): void => {
    if (deviceOptions.length < 2) {
      setNotice("only one device is currently visible");
      return;
    }
    const current = deviceOptions.findIndex((candidate) => deviceSelectorKey(candidate) === deviceSelectorKey(device));
    const next = deviceOptions[(Math.max(0, current) + 1) % deviceOptions.length]!;
    setDevice(next);
    setProcesses([]);
    setProcessIndex(0);
    setProcessQuery("");
    setProcessFilterActive(true);
    setNotice(`device switched to ${deviceLabels[deviceSelectorKey(next)] ?? deviceSelectorLabel(next)} — finding running apps`);
  };

  const connectSelectedProcess = (): void => {
    if (!selectedProcess) return;
    if (selectedProcess.matchedTargets.length > 1) {
      const targetIndex = targets.indexOf(selectedProcess.matchedTargets[0]!);
      if (targetIndex >= 0) setPickerIndex(targetIndex);
      setFocus("targets");
      setNotice(`${selectedProcess.matchedTargets.length} saved games match PID ${selectedProcess.pid} — choose one`);
      return;
    }
    openLaunch(launchForProcess(selectedProcess));
  };

  useInput((ch, key) => {
    const inputRoute = routeGlobalInput(inputCaptured || targetLaunch !== null, ch, key);
    if (inputRoute === "quit") {
      void workbench.closeAll().then(() => exit());
      return;
    }

    // Child-owned forms publish capture synchronously before the next key.
    if (inputRoute === "captured") return;

    if (showHelp) {
      if (ch === "?" || key.escape) setShowHelp(false);
      return;
    }

    if (paletteOpen) {
      if ((key.ctrl && ch === "p") || key.escape) {
        setPaletteOpen(false);
      } else if (key.upArrow) {
        setPaletteIndex((index) => (index - 1 + MODE_PALETTE_ITEMS.length) % MODE_PALETTE_ITEMS.length);
      } else if (key.downArrow) {
        setPaletteIndex((index) => (index + 1) % MODE_PALETTE_ITEMS.length);
      } else if (key.return) {
        const next = selectPaletteRoute({ mode, surface }, paletteIndex);
        setMode(next.mode);
        setSurface(next.surface);
        setPaletteOpen(false);
        setFocus("panel");
      }
      return;
    }

    // The REPL owns non-control input, including Escape, while focused.
    if (focus === "panel" && mode === "instrument" && surface === "repl" && !key.ctrl) return;

    if (ch === "?") {
      setShowHelp(true);
      return;
    }
    if (key.ctrl && ch === "v") {
      cycleDevice();
      return;
    }
    if (key.ctrl && ch === "d") {
      setNotice(null);
      setFocus("processes");
      return;
    }
    if (key.ctrl && ch === "t") {
      setNotice(null);
      setFocus("targets");
      return;
    }
    if (key.ctrl && ch === "s") {
      setNotice(null);
      setFocus("sessions");
      return;
    }
    if (key.ctrl && ch === "p") {
      const selected = MODE_PALETTE_ITEMS.findIndex((item) => item.mode === mode);
      setPaletteIndex(selected >= 0 ? selected : 0);
      setPaletteOpen(true);
      return;
    }

    if (processFilterActive && focus === "processes") {
      if (key.escape) {
        setProcessFilterActive(false);
      } else if (key.tab) {
        setFocus("targets");
      } else if (key.upArrow) {
        setProcessIndex((index) => Math.max(0, index - 1));
      } else if (key.downArrow) {
        setProcessIndex((index) => Math.min(Math.max(0, visibleProcesses.length - 1), index + 1));
      } else if (key.return) {
        setProcessFilterActive(false);
        if (processQuery.trim() && selectedProcess) connectSelectedProcess();
      } else if (key.ctrl && ch === "u") {
        setProcessQuery("");
        setProcessIndex(0);
      } else if (key.backspace || key.delete) {
        setProcessQuery((value) => value.slice(0, -1));
        setProcessIndex(0);
      } else if (!key.ctrl && !key.meta && ch) {
        setProcessQuery((value) => value + ch);
        setProcessIndex(0);
      }
      return;
    }
    // The journey bar presents 1/2/3 as direct destinations. Keep these as
    // real shortcuts (outside text inputs/REPL/forms) so the visible model and
    // keyboard behavior agree.
    if (ch === "1") {
      setMode("project");
      setNotice("Connect — choose a running app or saved game, then press Enter");
      setFocus("processes");
      return;
    }
    if (ch === "2") {
      if (!active) {
        setNotice("Connect to a game before opening Analyze");
        setFocus("processes");
        return;
      }
      setMode("analysis");
      setSurface("actions");
      setNotice(null);
      setFocus("panel");
      return;
    }
    if (ch === "3") {
      if (!active) {
        setNotice("Connect to a game before opening Instrument");
        setFocus("processes");
        return;
      }
      setMode("instrument");
      setSurface("actions");
      setNotice(null);
      setFocus("panel");
      return;
    }
    if (key.ctrl && ch === "r" && active && (active.status === "detached" || active.status === "error")) {
      workbench.reconnect(active.id);
      return;
    }
    if (key.ctrl && ch === "w" && active) {
      const id = active.id;
      void workbench.close(id).then(() => {
        store.removeSession(id);
        workbench.dropSession(id);
        dropReplState(id);
      });
      return;
    }
    if (ch === "]" && focus === "panel" && active) {
      if (mode === "instrument" || mode === "analysis") {
        setSurface((current) => cycleSurface(mode, current));
      }
      return;
    }
    if (key.tab) {
      if (!active && focus !== "panel") {
        setNotice(null);
        setFocus((current) => current === "processes" ? "targets" : "processes");
      } else if (active || mode === "project") {
        setFocus("panel");
      }
      return;
    }
    if (key.escape && focus === "panel") {
      setFocus(state.sessions.length ? "sessions" : "processes");
      return;
    }
    if (focus === "panel") return;

    if (key.leftArrow) {
      setFocus((current) => current === "sessions" ? "targets" : "processes");
      return;
    }
    if (key.rightArrow) {
      setFocus((current) => current === "processes" ? "targets" : state.sessions.length ? "sessions" : "targets");
      return;
    }

    if (focus === "processes") {
      if (key.upArrow) setProcessIndex((index) => Math.max(0, index - 1));
      else if (key.downArrow) setProcessIndex((index) => Math.min(Math.max(0, visibleProcesses.length - 1), index + 1));
      else if (ch === "/") {
        setProcessFilterActive(true);
        setProcessQuery("");
        setProcessIndex(0);
      }
      else if (ch === "r") void refreshProcesses();
      else if (ch === "v") cycleDevice();
      else if (ch === "n" && selectedProcess) {
        setProjectCreateRequest((current) => ({
          id: (current?.id ?? 0) + 1,
          process: selectedProcess.name,
          suggestedName: suggestedTargetName(selectedProcess.name),
          device,
        }));
        openProjectMode(`Create target prefilled from ${selectedProcess.name} (PID ${selectedProcess.pid})`);
      }
      else if (key.return && selectedProcess) connectSelectedProcess();
      return;
    }

    if (focus === "targets") {
      if (key.upArrow) setPickerIndex((index) => Math.max(0, index - 1));
      else if (key.downArrow) setPickerIndex((index) => Math.min(Math.max(0, targets.length - 1), index + 1));
      else if (ch === "m" || (ch && "nerud".includes(ch))) {
        openProjectMode("Saved games manager — choose a game, then create/edit/rename/unregister/delete");
      } else if (key.return && selectedTarget) openLaunch({ kind: "target", target: selectedTarget });
      return;
    }

    if (key.upArrow) setSessionIndex((index) => Math.max(0, index - 1));
    else if (key.downArrow) setSessionIndex((index) => Math.min(Math.max(0, state.sessions.length - 1), index + 1));
    else if (key.return && state.sessions[sessionIndex]) {
      store.setActive(state.sessions[sessionIndex]!.id);
      setFocus("panel");
    }
  });

  const panelFocused = focus === "panel" && !paletteOpen && !showHelp && !targetLaunch;

  const modeContent = (): React.JSX.Element => {
    if (!active && focus !== "panel") {
      return (
        <ConnectPanel
          focus={focus}
          deviceLabel={selectedDeviceLabel}
          selectedProcess={selectedProcess}
          selectedTarget={selectedTarget}
          processQuery={processQuery}
          processFilterActive={processFilterActive}
          processesLoading={processesLoading}
          processesError={processesError}
        />
      );
    }
    if (mode === "project") {
      return (
        <ProjectPanel
          focused={panelFocused}
          blockedTargetNames={state.sessions
            .filter((session) => session.status === "live" || session.status === "connecting")
            .map((session) => session.target)}
          createRequest={projectCreateRequest}
          onCaptureChange={setInputCaptured}
          onChanged={() => {
            setNotice("project manifest updated");
            setTargetVersion((version) => version + 1);
            void refreshProcesses();
          }}
        />
      );
    }
    if (!active) return <NoSession mode={mode} />;
    if (mode === "analysis") {
      return (
        <>
          <Box paddingX={1}>
            <Text dimColor>
              {ANALYSIS_SURFACES.map((item) => item === surface ? `[${SURFACE_LABELS[item]}]` : SURFACE_LABELS[item]).join(" · ")} · ] next
            </Text>
          </Box>
          <Box display={surface === "actions" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
            <AnalysisPanel
              key={`an${active.id}`}
              session={active}
              focused={panelFocused && surface === "actions"}
              onCaptureChange={setInputCaptured}
            />
          </Box>
          <Box display={surface === "explorer" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
            <Explorer
              key={`ae${active.id}`}
              session={active}
              focused={panelFocused && surface === "explorer"}
              onCaptureChange={setInputCaptured}
            />
          </Box>
          <Box display={surface === "record" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
            <RecordPanel
              key={`record${active.id}`}
              session={active}
              focused={panelFocused && surface === "record"}
              onCaptureChange={setInputCaptured}
            />
          </Box>
        </>
      );
    }

    return (
      <>
        <Box paddingX={1}>
          <Text dimColor>
            {INSTRUMENT_SURFACES.map((item) => item === surface ? `[${SURFACE_LABELS[item]}]` : SURFACE_LABELS[item]).join(" · ")} · ] next
          </Text>
        </Box>
        <Box display={surface === "actions" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
          <InstrumentPanel
            key={`a${active.id}`}
            session={active}
            focused={panelFocused && surface === "actions"}
            onCaptureChange={setInputCaptured}
          />
        </Box>
        <Box display={surface === "repl" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
          <Repl key={`r${active.id}`} session={active} focused={panelFocused && surface === "repl"} />
        </Box>
        <Box display={surface === "observe" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
          <Observe
            key={`o${active.id}`}
            session={active}
            focused={panelFocused && surface === "observe"}
            onCaptureChange={setInputCaptured}
          />
        </Box>
      </>
    );
  };

  // At phone-sized/80x24 terminals only one pane fits. Overlays and launch
  // forms must still replace the sidebar even when they were opened while the
  // process picker owned focus.
  const minimalMainVisible = focus === "panel" || showHelp || paletteOpen || targetLaunch !== null;

  return (
    <Box flexDirection="column">
      <StatusHeader session={active} deviceLabel={selectedDeviceLabel} compact={compact} />
      <ModeBar route={route} connected={Boolean(active)} compact={compact} />
      <Box>
        {(!minimal || !minimalMainVisible) && <Sidebar
          expanded={minimal}
          deviceLabel={selectedDeviceLabel}
          deviceCount={deviceOptions.length}
          processes={visibleProcesses}
          processTotal={processes.length}
          processIndex={processIndex}
          processQuery={processQuery}
          processFilterActive={processFilterActive}
          processesLoading={processesLoading}
          processesError={processesError}
          targets={targets}
          pickerIndex={pickerIndex}
          sessions={state.sessions}
          activeId={state.activeId}
          focus={showHelp || targetLaunch || paletteOpen || focus === "panel" ? null : focus}
        />}
        {(!minimal || minimalMainVisible) && <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor={panelFocused ? "cyan" : "gray"}
        >
          {notice && <Box paddingX={1}><Text color="yellow">{notice}</Text></Box>}
          {showHelp ? <HelpPanel /> : paletteOpen ? <ModePalette index={paletteIndex} /> : targetLaunch ? (
            <TargetLaunchPanel
              key={`${targetLaunch.target}:${targetLaunch.processOverride ?? ""}`}
              {...targetLaunch}
              deviceLabel={selectedDeviceLabel}
              onCancel={() => {
                setTargetLaunch(null);
                setFocus("targets");
              }}
              onLaunch={(request) => {
                setTargetLaunch(null);
                openSession(workbench.open(request));
              }}
            />
          ) : modeContent()}
        </Box>}
      </Box>
    </Box>
  );
}

export async function runTui(
  target?: string,
  proc?: string,
  device?: DeviceSelector,
  options: { spawn?: boolean; noWatch?: boolean } = {},
): Promise<void> {
  render(<App
    initialTarget={target}
    initialProc={proc}
    initialDevice={device}
    initialSpawn={options.spawn}
    initialNoWatch={options.noWatch}
  />);
}
