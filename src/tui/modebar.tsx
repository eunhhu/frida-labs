import React from "react";
import { Box, Text } from "ink";

export type TuiMode = "project" | "instrument" | "debug" | "probe" | "analysis";

export type ModeRoute =
  | {
      mode: "project";
      view: "list" | "create" | "edit" | "rename" | "unregister" | "delete-confirm";
    }
  | { mode: "probe"; view: "form" | "launching" }
  | { mode: "instrument" | "debug" | "analysis"; sessionId: number | null };

export const MODES: readonly TuiMode[] = ["project", "instrument", "debug", "probe", "analysis"];

export type InstrumentSurface = "actions" | "repl" | "explorer" | "observe";

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
export type JourneyStage = "connect" | "mods" | "inspect";

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
  if (mode === "probe") return { mode, view: "form" };
  return { mode, sessionId };
}

export const MODE_PALETTE_ITEMS: readonly ModePaletteItem[] = [
  { id: "project", label: "1 Connect · Manage saved games", mode: "project" },
  { id: "probe", label: "1 Connect · Manual PID/name/spawn (advanced)", mode: "probe" },
  { id: "instrument", label: "2 Mods · Game controls", mode: "instrument", surface: "actions" },
  { id: "repl", label: "2 Mods · Command console (advanced)", mode: "instrument", surface: "repl" },
  { id: "explorer", label: "2 Mods · Memory explorer (advanced)", mode: "instrument", surface: "explorer" },
  { id: "observe", label: "2 Mods · Live output", mode: "instrument", surface: "observe" },
  { id: "analysis", label: "3 Inspect · Read game structure", mode: "analysis" },
  { id: "debug", label: "3 Inspect · Errors and hook checks", mode: "debug" },
];

export function journeyStage(route: ModeRoute): JourneyStage {
  if (route.mode === "instrument") return "mods";
  if (route.mode === "analysis" || route.mode === "debug") return "inspect";
  return "connect";
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
    surface: item.surface ?? current.surface,
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
  paletteOpen,
  connected,
  compact,
}: {
  route: ModeRoute;
  paletteOpen: boolean;
  connected: boolean;
  compact: boolean;
}): React.JSX.Element {
  const stage = journeyStage(route);
  const steps: Array<{ id: JourneyStage; label: string }> = [
    { id: "connect", label: "1 connect" },
    { id: "mods", label: "2 mods" },
    { id: "inspect", label: "3 inspect" },
  ];
  return (
    <Box paddingX={1}>
      <Text>
        {steps.map((step) => step.id === stage ? `[${step.label}]` : ` ${step.label} `).join("  →  ")}
        {!compact && <>{"   "}<Text dimColor>{connected ? "session stays connected" : "choose a game, then Enter"}</Text></>}
        {"   "}<Text color={paletteOpen ? "yellow" : undefined} bold={paletteOpen}>
          ^p {compact ? "tools" : "all tools"}{paletteOpen ? " [open]" : ""}
        </Text>
      </Text>
    </Box>
  );
}

export function ModePalette({ index }: { index: number }): React.JSX.Element {
  const selected = paletteItemAt(index);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">all tools</Text>
      {MODE_PALETTE_ITEMS.map((item) => (
        <Text key={item.id} color={item.id === selected.id ? "cyan" : undefined}>
          {item.id === selected.id ? "❯ " : "  "}{item.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ choose · Enter open · Ctrl+P/Esc back</Text>
    </Box>
  );
}
