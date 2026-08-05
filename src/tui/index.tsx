// Ink workspace: one persistent SessionWorkbench plus explicit Project,
// Instrument, Debug, Probe, and Analysis modes. Runtime operations cross only
// the core SessionEngine/ActionService/ProjectService boundary via Workbench.
import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
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
import { DebugPanel } from "./debug.js";
import { ProbePanel, TargetLaunchPanel } from "./probe.js";
import { AnalysisPanel } from "./analysis.js";
import {
  MODE_PALETTE_ITEMS,
  ModeBar,
  ModePalette,
  selectPaletteRoute,
  modeRoute,
  routeGlobalInput,
  type InstrumentSurface,
  type TuiMode,
} from "./modebar.js";

const SURFACES: readonly InstrumentSurface[] = ["actions", "repl", "explorer", "observe"];
type Focus = "processes" | "targets" | "sessions" | "panel";
type DebugSurface = "debug" | "observe";
type PendingTargetLaunch = Pick<TargetLaunch, "target" | "processOverride" | "device">;

export function cycleSurface(surface: InstrumentSurface): InstrumentSurface {
  return SURFACES[(SURFACES.indexOf(surface) + 1) % SURFACES.length]!;
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

function HelpPanel(): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">flab five-mode workflow</Text>
      <Text>Project: create/edit/rename/unregister/delete targets in this workspace</Text>
      <Text>Instrument: typed actions plus the preserved REPL, Explorer, and Observe surfaces</Text>
      <Text>Debug: crash/exception/hook verification timeline; ] toggles Observe</Text>
      <Text>Probe: attach by process name/PID or spawn through the shared Workbench</Text>
      <Text>Analysis: descriptor-authorized read-only workflows, capped at 200 rows</Text>
      <Text> </Text>
      <Text dimColor>Ctrl+P mode/action palette · ] Instrument surface · Ctrl+D/T/S lists</Text>
      <Text dimColor>Tab panel · Esc lists/cancel input · Ctrl+R reconnect · Ctrl+W close · Ctrl+Q quit</Text>
      <Text dimColor>Processes: ◆ matched target · v device · / filter · r refresh · enter launch form/Probe</Text>
      <Text dimColor>Targets: enter launch form · n/e/m/d route to the canonical Project mode</Text>
      <Text color="yellow">? or Esc closes help</Text>
    </Box>
  );
}

function NoSession({ mode }: { mode: TuiMode }): React.JSX.Element {
  return (
    <Box paddingX={2} paddingY={1} flexDirection="column">
      <Text bold color="cyan">{mode} needs a live session</Text>
      <Text>Select a process and press Enter for its ◆ target match, or persistent Probe.</Text>
      <Text dimColor>Ctrl+D processes · Ctrl+T targets · Ctrl+P mode/action palette</Text>
    </Box>
  );
}

export function App({
  initialTarget,
  initialProc,
  initialDevice,
}: {
  initialTarget?: string;
  initialProc?: string;
  initialDevice?: DeviceSelector;
}): React.JSX.Element {
  const { exit } = useApp();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const state = store.snapshot;
  const [targetVersion, setTargetVersion] = React.useState(0);
  void targetVersion;
  const targets = listTargets();
  const [device, setDevice] = React.useState<DeviceSelector>(() => normalizeDeviceSelector(initialDevice));
  const [deviceOptions, setDeviceOptions] = React.useState<DeviceSelector[]>(() => [normalizeDeviceSelector(initialDevice)]);
  const [deviceLabels, setDeviceLabels] = React.useState<Record<string, string>>({});

  const [mode, setMode] = React.useState<TuiMode>(initialTarget ? "instrument" : "project");
  const [surface, setSurface] = React.useState<InstrumentSurface>("actions");
  const [debugSurface, setDebugSurface] = React.useState<DebugSurface>("debug");
  const [focus, setFocus] = React.useState<Focus>(initialTarget ? "panel" : "processes");
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteIndex, setPaletteIndex] = React.useState(0);
  const [processes, setProcesses] = React.useState<ProcessCandidate[]>([]);
  const [processesLoading, setProcessesLoading] = React.useState(true);
  const [processesError, setProcessesError] = React.useState<string | null>(null);
  const [processIndex, setProcessIndex] = React.useState(0);
  const [processQuery, setProcessQuery] = React.useState("");
  const [processFilterActive, setProcessFilterActive] = React.useState(false);
  const [pickerIndex, setPickerIndex] = React.useState(0);
  const [sessionIndex, setSessionIndex] = React.useState(0);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [targetLaunch, setTargetLaunch] = React.useState<PendingTargetLaunch | null>(null);
  const [projectCreateRequest, setProjectCreateRequest] = React.useState<ProjectCreateRequest | null>(null);
  const [showHelp, setShowHelp] = React.useState(false);
  const [inputCaptured, setInputCaptured] = React.useState(false);

  const visibleProcesses = React.useMemo(() => {
    const query = processQuery.trim().toLowerCase();
    if (!query) return processes;
    return processes.filter((process) =>
      `${process.pid} ${process.name} ${process.matchedTargets.join(" ")}`.toLowerCase().includes(query),
    );
  }, [processQuery, processes]);

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
    if (initialTarget) workbench.attach(initialTarget, initialProc, initialDevice);
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

  const openSession = (opened: ReturnType<typeof workbench.open>): void => {
    if (!opened) {
      setNotice(`session cap reached (${MAX_SESSIONS}) — Ctrl+W closes active session`);
      return;
    }
    setNotice(null);
    setMode("instrument");
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
    openSession(workbench.open(selectedRequest));
  };

  const openProjectMode = (message: string): void => {
    setMode("project");
    setFocus("panel");
    setNotice(message);
  };

  useInput((ch, key) => {
    const inputRoute = routeGlobalInput(inputCaptured || targetLaunch !== null, ch, key);
    if (inputRoute === "quit") {
      void workbench.closeAll().then(() => exit());
      return;
    }

    if (processFilterActive) {
      if (key.escape || key.return) {
        setProcessFilterActive(false);
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
        const route = selectPaletteRoute({ mode, surface }, paletteIndex);
        setMode(route.mode);
        setSurface(route.surface);
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
      const selected = MODE_PALETTE_ITEMS.findIndex((item) =>
        item.mode === mode && (mode !== "instrument" || item.surface === surface));
      setPaletteIndex(selected >= 0 ? selected : 0);
      setPaletteOpen(true);
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
      if (mode === "instrument") setSurface((current) => cycleSurface(current));
      else if (mode === "debug") setDebugSurface((current) => current === "debug" ? "observe" : "debug");
      return;
    }
    if (key.tab) {
      if (active || mode === "project" || mode === "probe") setFocus("panel");
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
      else if (ch === "/") setProcessFilterActive(true);
      else if (ch === "r") void refreshProcesses();
      else if (ch === "v" && deviceOptions.length > 1) {
        const current = deviceOptions.findIndex((candidate) => deviceSelectorKey(candidate) === deviceSelectorKey(device));
        const next = deviceOptions[(Math.max(0, current) + 1) % deviceOptions.length]!;
        setDevice(next);
        setProcesses([]);
        setProcessIndex(0);
        setNotice(`device switched to ${deviceLabels[deviceSelectorKey(next)] ?? deviceSelectorLabel(next)} — discovering processes`);
      }
      else if (ch === "n" && selectedProcess) {
        setProjectCreateRequest((current) => ({
          id: (current?.id ?? 0) + 1,
          process: selectedProcess.name,
          suggestedName: suggestedTargetName(selectedProcess.name),
          device,
        }));
        openProjectMode(`Create target prefilled from ${selectedProcess.name} (PID ${selectedProcess.pid})`);
      }
      else if (key.return && selectedProcess) {
        if (selectedProcess.matchedTargets.length > 1) {
          const targetIndex = targets.indexOf(selectedProcess.matchedTargets[0]!);
          if (targetIndex >= 0) setPickerIndex(targetIndex);
          setFocus("targets");
          setNotice(`${selectedProcess.matchedTargets.length} targets match PID ${selectedProcess.pid} — choose one explicitly`);
        } else openLaunch(launchForProcess(selectedProcess));
      }
      return;
    }

    if (focus === "targets") {
      if (key.upArrow) setPickerIndex((index) => Math.max(0, index - 1));
      else if (key.downArrow) setPickerIndex((index) => Math.min(Math.max(0, targets.length - 1), index + 1));
      else if (ch && "nerud".includes(ch)) {
        openProjectMode("Project mode owns create/edit/rename/unregister/delete; use n/e/r/u/d there");
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
    if (mode === "probe") {
      return <ProbePanel focused={panelFocused} onCaptureChange={setInputCaptured} onLaunch={openLaunch} />;
    }
    if (!active) return <NoSession mode={mode} />;
    if (mode === "analysis") {
      return <AnalysisPanel session={active} focused={panelFocused} onCaptureChange={setInputCaptured} />;
    }
    if (mode === "debug") {
      return (
        <>
          <Box paddingX={1}>
            <Text dimColor>{debugSurface === "debug" ? "[debug] · observe" : "debug · [observe]"} · ] next</Text>
          </Box>
          <Box display={debugSurface === "debug" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
            <DebugPanel
              key={`d${active.id}`}
              session={active}
              focused={panelFocused && debugSurface === "debug"}
              onCaptureChange={setInputCaptured}
            />
          </Box>
          <Box display={debugSurface === "observe" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
            <Observe
              key={`do${active.id}`}
              session={active}
              focused={panelFocused && debugSurface === "observe"}
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
            {SURFACES.map((item) => item === surface ? `[${item}]` : item).join(" · ")} · ] next
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
        <Box display={surface === "explorer" ? "flex" : "none"} flexDirection="column" flexGrow={1}>
          <Explorer
            key={`e${active.id}`}
            session={active}
            focused={panelFocused && surface === "explorer"}
            onCaptureChange={setInputCaptured}
          />
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

  return (
    <Box flexDirection="column">
      <StatusHeader session={active} />
      <ModeBar route={route} paletteOpen={paletteOpen} />
      <Box>
        <Sidebar
          deviceLabel={deviceLabels[deviceSelectorKey(device)] ?? deviceSelectorLabel(device)}
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
        />
        <Box
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
              onCancel={() => setTargetLaunch(null)}
              onLaunch={(request) => {
                setTargetLaunch(null);
                openSession(workbench.open(request));
              }}
            />
          ) : modeContent()}
        </Box>
      </Box>
    </Box>
  );
}

export async function runTui(target?: string, proc?: string, device?: DeviceSelector): Promise<void> {
  render(<App initialTarget={target} initialProc={proc} initialDevice={device} />);
}
