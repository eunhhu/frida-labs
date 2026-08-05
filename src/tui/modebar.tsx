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
  { id: "project", label: "Project management", mode: "project" },
  { id: "instrument", label: "Instrument actions", mode: "instrument", surface: "actions" },
  { id: "debug", label: "Debug timeline/actions", mode: "debug" },
  { id: "probe", label: "Probe attach/spawn", mode: "probe" },
  { id: "analysis", label: "Analysis · read only", mode: "analysis" },
  { id: "repl", label: "Instrument · REPL", mode: "instrument", surface: "repl" },
  { id: "explorer", label: "Instrument · Explorer", mode: "instrument", surface: "explorer" },
  { id: "observe", label: "Instrument · Observe", mode: "instrument", surface: "observe" },
];

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

export function ModeBar({ route, paletteOpen }: { route: ModeRoute; paletteOpen: boolean }): React.JSX.Element {
  return (
    <Box paddingX={1}>
      <Text>
        {MODES.map((candidate) => candidate === route.mode ? `[${candidate}]` : ` ${candidate} `).join(" ")}
        {"  "}<Text color={paletteOpen ? "yellow" : undefined} bold={paletteOpen}>
          ^p palette{paletteOpen ? " [open]" : ""}
        </Text>
      </Text>
    </Box>
  );
}

export function ModePalette({ index }: { index: number }): React.JSX.Element {
  const selected = paletteItemAt(index);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">mode/action palette</Text>
      {MODE_PALETTE_ITEMS.map((item) => (
        <Text key={item.id} color={item.id === selected.id ? "cyan" : undefined}>
          {item.id === selected.id ? "❯ " : "  "}{item.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · enter open · Ctrl+P/Esc cancel</Text>
    </Box>
  );
}
