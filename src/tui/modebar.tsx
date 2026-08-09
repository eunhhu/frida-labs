import React from "react";
import { Box, Text } from "ink";

export type TuiMode = "project" | "analysis" | "instrument";

export type ModeRoute =
  | {
      mode: "project";
      view: "list" | "create" | "edit" | "rename" | "unregister" | "delete-confirm";
    }
  | { mode: "instrument" | "analysis"; sessionId: number | null };

export const MODES: readonly TuiMode[] = ["project", "analysis", "instrument"];

export type WorkspaceSurface = "actions" | "explorer" | "record" | "debug" | "repl" | "observe";
/** Compatibility name for extensions compiled against the prior TUI types. */
export type InstrumentSurface = WorkspaceSurface;

export interface ModePaletteItem {
  id: string;
  label: string;
  mode: TuiMode;
  surface?: InstrumentSurface;
}

export interface ModeSelection {
  mode: TuiMode;
  surface: InstrumentSurface;
}
export type GlobalInputRoute = "quit" | "captured" | "global";
export type JourneyStage = "connect" | "analyze" | "instrument";

export function routeGlobalInput(
  captured: boolean,
  input: string,
  key: { ctrl?: boolean; escape?: boolean },
): GlobalInputRoute {
  if (key.ctrl && input === "q") return "quit";
  if (captured) return "captured";
  return "global";
}

export function modeRoute(mode: TuiMode, sessionId: number | null): ModeRoute {
  if (mode === "project") return { mode, view: "list" };
  return { mode, sessionId };
}

export const MODE_PALETTE_ITEMS: readonly ModePaletteItem[] = [
  { id: "project", label: "1 Connect · choose and manage a game", mode: "project" },
  { id: "analysis", label: "2 Analyze · discover and verify structure", mode: "analysis", surface: "actions" },
  { id: "instrument", label: "3 Instrument · run linked game features", mode: "instrument", surface: "actions" },
];

export function journeyStage(route: ModeRoute): JourneyStage {
  if (route.mode === "project") return "connect";
  return route.mode === "analysis" ? "analyze" : "instrument";
}

export function paletteItemAt(index: number): ModePaletteItem {
  if (!Number.isFinite(index)) return MODE_PALETTE_ITEMS[0]!;
  const normalized = ((Math.trunc(index) % MODE_PALETTE_ITEMS.length) + MODE_PALETTE_ITEMS.length)
    % MODE_PALETTE_ITEMS.length;
  return MODE_PALETTE_ITEMS[normalized]!;
}

export function selectPaletteRoute(current: ModeSelection, index: number): ModeSelection {
  const item = paletteItemAt(index);
  return {
    mode: item.mode,
    surface: item.surface ?? (item.mode === current.mode ? current.surface : "actions"),
  };
}

export function modeAt(index: number): TuiMode {
  if (!Number.isFinite(index)) return MODES[0]!;
  const normalized = ((Math.trunc(index) % MODES.length) + MODES.length) % MODES.length;
  return MODES[normalized]!;
}

export function nextMode(mode: TuiMode): TuiMode {
  return modeAt(MODES.indexOf(mode) + 1);
}

export function ModeBar({
  route,
  connected,
  compact,
}: {
  route: ModeRoute;
  connected: boolean;
  compact: boolean;
}): React.JSX.Element {
  const stage = journeyStage(route);
  const steps: Array<{ id: JourneyStage; label: string }> = [
    { id: "connect", label: "1 Connect" },
    { id: "analyze", label: "2 Analyze" },
    { id: "instrument", label: "3 Instrument" },
  ];
  return (
    <Box paddingX={1}>
      <Text>
        {steps.map((step) => step.id === stage ? `[${step.label}]` : ` ${step.label} `).join("  →  ")}
        {!compact && <>{"   "}<Text dimColor>{connected ? "live" : "choose game"}</Text></>}
      </Text>
    </Box>
  );
}

export function ModePalette({ index }: { index: number }): React.JSX.Element {
  const selected = paletteItemAt(index);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Choose workspace</Text>
      {MODE_PALETTE_ITEMS.map((item) => (
        <Text key={item.id} color={item.id === selected.id ? "cyan" : undefined}>
          {item.id === selected.id ? "❯ " : "  "}{item.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ choose · Enter open · Esc back</Text>
    </Box>
  );
}
