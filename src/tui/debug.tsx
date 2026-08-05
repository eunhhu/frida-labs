import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { DebugEvent } from "../core/index.js";
import { workbench } from "./workbench.js";
import { ActionPalette, type ActionPanelProps } from "./instrument.js";

const TIMELINE_EVENTS = 8;

const kindColor: Record<DebugEvent["kind"], string> = {
  "process-crash": "red",
  "agent-exception": "red",
  "session-detached": "magenta",
  spawn: "cyan",
  child: "blue",
  "hook-receipt": "green",
};

function oneLine(value: string, limit = 180): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, Math.max(0, limit - 1))}…`;
}

function clock(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "--:--:--";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toISOString().slice(11, 19);
}

/** Debug-only actions plus a bounded, normalized event timeline. */
export function DebugPanel(props: ActionPanelProps): React.JSX.Element {
  const [capturing, setCapturing] = useState(false);
  const [view, setView] = useState<"actions" | "timeline">("timeline");
  const [reconnectResult, setReconnectResult] = useState<string | null>(null);
  const onCaptureChange = useCallback((active: boolean) => {
    setCapturing(active);
    props.onCaptureChange(active);
  }, [props.onCaptureChange]);

  useInput((input) => {
    if (input === "v") {
      setView((current) => current === "actions" ? "timeline" : "actions");
    } else if (input === "R") {
      const accepted = workbench.reconnect(props.session.id, true);
      setReconnectResult(accepted ? "reconnect requested" : "reconnect not available in the current state");
    }
  }, { isActive: props.focused && !capturing });

  const events = props.session.debugEvents.slice(-TIMELINE_EVENTS);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="magenta">DEBUG</Text>
        <Text color="yellow">view [{view}] · v switch · R reconnect/confirm probe spawn</Text>
        <Text dimColor>
          receipt drops {props.session.droppedReceipts} · debug event drops {props.session.droppedDebugEvents}
        </Text>
      </Box>
      {reconnectResult && <Text color="yellow">{reconnectResult}</Text>}

      {view === "actions" ? (
        <ActionPalette
          {...props}
          mode="debug"
          title="Debug actions"
          receiptRows={5}
          onCaptureChange={onCaptureChange}
        />
      ) : (
        <Box flexDirection="column" borderTop borderStyle="single" borderColor="gray">
          <Text bold>debug timeline · latest {events.length}/{props.session.debugEvents.length}</Text>
          {events.length === 0 && <Text dimColor>no debug events</Text>}
          {events.map((event, index) => (
            <Box key={`${event.timestamp}:${event.kind}:${index}`} flexDirection="column">
              <Text>
                <Text dimColor>{clock(event.timestamp)} </Text>
                <Text color={kindColor[event.kind]}>[{event.kind}]</Text>
                {event.action ? ` ${event.action}` : ""}
                {event.actionStatus ? (
                  <Text color={event.actionStatus === "passed" ? "green" : event.actionStatus === "failed" ? "red" : "yellow"}>
                    {` ${event.actionStatus.toUpperCase()}`}
                  </Text>
                ) : null}
                {` ${oneLine(event.summary)}`}
              </Text>
              {(event.detail || event.report || event.verification) && (
                <Text dimColor>
                  {event.detail ? oneLine(event.detail) : ""}
                  {event.report ? `${event.detail ? " · " : ""}${oneLine(event.report.summary)}` : ""}
                  {event.verification
                    ? `${event.detail || event.report ? " · " : ""}verification ${event.verification.state} · fired ${event.verification.fired}`
                    : ""}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
