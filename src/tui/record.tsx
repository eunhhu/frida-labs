// Human-play Record surface. Three actions only: plan, record, stop. The
// resulting artifact replaces visual guesswork with call timing/args/returns.

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  AnalysisRecordMetadata,
  AnalysisRecordSummary,
  RecordPlanResult,
} from "../core/index.js";
import type { SessionState } from "./store.js";
import { workbench } from "./workbench.js";

export const RECORD_ACTIONS = ["plan", "record", "stop"] as const;

export function parseRecordQuery(value: string): { query: string; module?: string } {
  const text = value.trim();
  const separator = text.indexOf("!");
  if (separator <= 0 || separator === text.length - 1) return { query: text };
  return { module: text.slice(0, separator).trim(), query: text.slice(separator + 1).trim() };
}

function countFromAgent(value: unknown, field: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

export function RecordPanel(props: {
  session: SessionState;
  focused: boolean;
  onCaptureChange(active: boolean): void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<RecordPlanResult | null>(null);
  const [active, setActive] = useState<AnalysisRecordMetadata | null>(null);
  const [agentStatus, setAgentStatus] = useState<unknown>(null);
  const [summary, setSummary] = useState<AnalysisRecordSummary | null>(null);
  const [message, setMessage] = useState("Enter module!function or function, then plan.");
  const summarized = useRef(new Set<string>());

  useEffect(() => {
    const timer = setInterval(() => {
      void workbench.recordStatus(props.session.id).then((status) => {
        setActive(status.record);
        setAgentStatus(status.agent);
        const completed = status.completed;
        if (completed && !summarized.current.has(completed.id)) {
          summarized.current.add(completed.id);
          void workbench.recordSummary(props.session.id, completed.id).then((next) => {
            setSummary(next);
            setMessage(`Saved ${completed.eventsPath}. AI-ready summary generated.`);
          }).catch((error) => setMessage((error as Error).message));
        }
      }).catch(() => {});
    }, 750);
    return () => {
      clearInterval(timer);
      props.onCaptureChange(false);
    };
  }, [props.onCaptureChange, props.session.id]);

  const capture = (value: boolean): void => {
    setEditing(value);
    props.onCaptureChange(value);
  };

  const planNow = async (): Promise<void> => {
    if (active) { setMessage("Stop the active Record before changing its hook plan."); return; }
    const parsed = parseRecordQuery(query);
    if (!parsed.query) { setMessage("Type a function/export substring first."); return; }
    setBusy(true);
    setSummary(null);
    try {
      const next = await workbench.planRecord(props.session.id, parsed.query, parsed.module, 3);
      setPlan(next);
      setMessage(next.candidates.length
        ? `${next.candidates.length} bounded hook candidate(s) ready.`
        : "No candidate found. Try module!function with a narrower function substring.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const startNow = async (): Promise<void> => {
    if (active) { setMessage(`Record ${active.id} is already active.`); return; }
    if (!plan?.candidates.length) { setMessage("Plan hooks first."); return; }
    setBusy(true);
    setSummary(null);
    try {
      const metadata = await workbench.startRecord(
        props.session.id,
        `${plan.module ? `${plan.module}!` : ""}${plan.query} · human play`,
        plan.candidates.slice(0, 3),
        { maxEvents: 50_000, perProbeLimit: 10_000, sampleEvery: 1, maxDurationMs: 30 * 60_000 },
      );
      setActive(metadata);
      setMessage("Recording. Play one controlled scenario, then Stop.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const stopNow = async (): Promise<void> => {
    if (!active) { setMessage("No active Record."); return; }
    setBusy(true);
    try {
      const metadata = await workbench.stopRecord(props.session.id);
      setActive(null);
      if (metadata) {
        summarized.current.add(metadata.id);
        const next = await workbench.recordSummary(props.session.id, metadata.id);
        setSummary(next);
        setMessage(`Saved ${metadata.eventsPath}. AI-ready summary generated.`);
      }
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  useInput((input, key) => {
    if (editing) {
      if (key.escape) { capture(false); return; }
      if (key.return) { capture(false); void planNow(); return; }
      if (key.backspace || key.delete) { setQuery((value) => value.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) setQuery((value) => `${value}${input}`.slice(0, 300));
      return;
    }
    if (busy) return;
    if (input === "/") capture(true);
    else if (input.toLowerCase() === "p") void planNow();
    else if (input.toLowerCase() === "r") void startNow();
    else if (input.toLowerCase() === "s") void stopNow();
  }, { isActive: props.focused });

  const emitted = countFromAgent(agentStatus, "emitted") ?? active?.eventCount ?? 0;
  const dropped = countFromAgent(agentStatus, "dropped") ?? active?.dropped ?? 0;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold color="green">2. ANALYZE · RECORD HUMAN PLAY</Text>
      <Text dimColor>Screen vision optional: function timing + args + returns become an AI-readable artifact.</Text>
      <Text> </Text>
      <Text color={editing ? "yellow" : "cyan"}>query: {query || "(type / to edit)"}{editing ? "▌" : ""}</Text>
      <Text dimColor>Format: function or module!function. Narrow query = safer, clearer evidence.</Text>
      <Text> </Text>
      <Text color={busy || active ? "gray" : "cyan"}>[P] Plan hooks</Text>
      <Text color={!plan?.candidates.length || busy || active ? "gray" : "green"}>[R] Record one play scenario</Text>
      <Text color={!active || busy ? "gray" : "yellow"}>[S] Stop + summarize</Text>
      <Text> </Text>
      {plan?.candidates.slice(0, 3).map((candidate) => (
        <Text key={candidate.id} dimColor>{candidate.id} · {candidate.name} · {candidate.address}</Text>
      ))}
      {active && (
        <Text color="green">● {active.id} · events {emitted} · dropped {dropped}</Text>
      )}
      {summary && (
        <Box flexDirection="column" borderTop borderStyle="single" borderColor="gray">
          <Text bold>AI summary · {summary.record.eventCount} events</Text>
          {summary.functions.slice(0, 3).map((fn) => (
            <Text key={fn.probeId}>{fn.name} · calls {fn.enters} · avg {fn.durationMs.average ?? "?"}ms</Text>
          ))}
        </Box>
      )}
      <Text color={/error|failed|invalid|not found/i.test(message) ? "red" : "yellow"}>{message}</Text>
    </Box>
  );
}
