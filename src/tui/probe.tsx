import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { deviceSelectorLabel, type DeviceSelector, type LaunchRequest, type TargetLaunch } from "../core/index.js";

export type ProbeRequest = Exclude<LaunchRequest, { kind: "target" }>;
export type ProbeVariant = ProbeRequest["kind"];

export type ProbeBuildResult =
  | { ok: true; request: ProbeRequest }
  | { ok: false; error: string };

const VARIANTS: readonly ProbeVariant[] = [
  "probe-attach-name",
  "probe-attach-pid",
  "probe-spawn",
];

const LABELS: Record<ProbeVariant, string> = {
  "probe-attach-name": "running app name",
  "probe-attach-pid": "process ID",
  "probe-spawn": "launch executable",
};

function variantAt(index: number): ProbeVariant {
  const normalized = ((index % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
  return VARIANTS[normalized]!;
}

export function buildProbeRequest(variant: ProbeVariant, input: string, childGating: boolean): ProbeBuildResult {
  const value = input.trim();

  switch (variant) {
    case "probe-attach-name":
      if (!value) return { ok: false, error: "process name is required" };
      return {
        ok: true,
        request: {
          kind: "probe-attach-name",
          process: value,
          ...(childGating ? { childGating: true } : {}),
        },
      };

    case "probe-attach-pid": {
      if (!/^\d+$/.test(value)) {
        return { ok: false, error: "PID must be a positive safe integer" };
      }
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        return { ok: false, error: "PID must be a positive safe integer" };
      }
      return {
        ok: true,
        request: {
          kind: "probe-attach-pid",
          pid,
          ...(childGating ? { childGating: true } : {}),
        },
      };
    }

    case "probe-spawn":
      if (!value) return { ok: false, error: "executable is required" };
      return { ok: true, request: { kind: "probe-spawn", executable: value } };
  }
}
export function buildTargetLaunch(
  target: string,
  processOverride: string | undefined,
  spawnGating: boolean,
  childGating: boolean,
  device?: DeviceSelector,
): TargetLaunch {
  const name = target.trim();
  if (!name) throw new Error("target is required");
  const process = processOverride?.trim();
  return {
    kind: "target",
    target: name,
    ...(process ? { processOverride: process } : {}),
    ...(spawnGating ? { spawnGating: true } : {}),
    ...(childGating ? { childGating: true } : {}),
    ...(device ? { device } : {}),
  };
}

export function TargetLaunchPanel(props: {
  target: string;
  processOverride?: string;
  device?: DeviceSelector;
  deviceLabel?: string;
  onLaunch(request: TargetLaunch): void;
  onCancel(): void;
}): React.JSX.Element {
  const [spawnGating, setSpawnGating] = useState(false);
  const [childGating, setChildGating] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (input === "a") {
      setAdvanced((active) => !active);
      return;
    }
    if (advanced && input === "s") {
      setSpawnGating((active) => !active);
      return;
    }
    if (advanced && input === "c") {
      setChildGating((active) => !active);
      return;
    }
    if (key.return) {
      props.onLaunch(buildTargetLaunch(
        props.target,
        props.processOverride,
        spawnGating,
        childGating,
        props.device,
      ));
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
      <Text bold color="cyan">Connect saved game</Text>
      <Text>Game tools: <Text bold>{props.target}</Text></Text>
      <Text>Running app: {props.processOverride ?? "use saved process name"}</Text>
      <Text>Device: {props.deviceLabel ?? (props.device ? deviceSelectorLabel(props.device) : "use saved/default device")}</Text>
      <Text> </Text>
      <Text bold color="green">Enter → connect and open Mods</Text>
      <Text dimColor>Esc → back · a → {advanced ? "hide" : "show"} advanced launch options</Text>
      {advanced && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">Advanced launch options</Text>
          <Text color={spawnGating ? "cyan" : undefined}>
            [{spawnGating ? "x" : " "}] Pause newly spawned processes (s)
          </Text>
          <Text color={childGating ? "cyan" : undefined}>
            [{childGating ? "x" : " "}] Follow child processes (c)
          </Text>
          <Text dimColor>Most games do not need these. Use them for launchers or child processes.</Text>
        </Box>
      )}
    </Box>
  );
}

export interface ProbePanelProps {
  focused: boolean;
  onLaunch(request: LaunchRequest): void;
  onCaptureChange(active: boolean): void;
}

export function ProbePanel(props: ProbePanelProps): React.JSX.Element {
  const [variant, setVariant] = useState<ProbeVariant>("probe-attach-name");
  const [input, setInput] = useState("");
  const [childGating, setChildGating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => () => props.onCaptureChange(false), [props.onCaptureChange]);
  const setEditingCaptured = (active: boolean): void => {
    setEditing(active);
    props.onCaptureChange(active);
  };

  useInput((ch, key) => {
    if (!editing) {
      if (key.leftArrow || key.upArrow) {
        setVariant((current) => variantAt(VARIANTS.indexOf(current) - 1));
        setError(null);
        return;
      }
      if (key.rightArrow || key.downArrow) {
        setVariant((current) => variantAt(VARIANTS.indexOf(current) + 1));
        setError(null);
        return;
      }
      if (key.tab) {
        if (variant !== "probe-spawn") setChildGating((active) => !active);
        return;
      }
      if (key.return) {
        setEditingCaptured(true);
        setError(null);
        return;
      }
      if (key.escape) {
        setInput("");
        setError(null);
        return;
      }
      if (!key.ctrl && !key.meta && ch) {
        setEditingCaptured(true);
        setInput((value) => value + ch);
        setError(null);
      }
      return;
    }

    if (key.return) {
      const result = buildProbeRequest(variant, input, childGating);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditingCaptured(false);
      props.onLaunch(result.request);
      return;
    }
    if (key.escape) {
      setEditingCaptured(false);
      setInput("");
      setError(null);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      setError(null);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (ch) {
      setInput((value) => value + ch);
      setError(null);
    }
  }, { isActive: props.focused });

  const prompt = variant === "probe-attach-name"
    ? "process name"
    : variant === "probe-attach-pid"
      ? "PID"
      : "executable";

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold color="yellow">Manual connect (advanced)</Text>
        <Text>Use this only when the running-app or saved-game lists cannot identify the target.</Text>
        <Text dimColor>←/→ method · type value · Enter connect · Esc clear</Text>
      </Box>
      <Text>
        {VARIANTS.map((candidate) => candidate === variant ? `[${LABELS[candidate]}]` : ` ${LABELS[candidate]} `).join(" ")}
      </Text>
      <Box marginTop={1}>
        <Text color="green">{prompt}: </Text>
        <Text>{input}</Text>
        {props.focused && editing && <Text inverse> </Text>}
      </Box>
      {variant !== "probe-spawn" && (
        <Text color={childGating ? "cyan" : undefined}>
          [{childGating ? "x" : " "}] Follow child processes (Tab)
        </Text>
      )}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}
