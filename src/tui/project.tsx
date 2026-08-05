import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  ProjectError,
  currentProjectService,
  deviceSelectorLabel,
  type DeviceSelector,
  type ProjectResult,
  type ProjectService,
  type TargetConfig,
} from "../core/index.js";

const VIEW = 12;
type Target = { name: string; config: TargetConfig };
type TargetMode = "attach" | "spawn";
export interface ProjectCreateRequest { id: number; process: string; suggestedName: string; device?: DeviceSelector }
export type ProjectCommand = "create" | "edit" | "rename" | "unregister" | "delete";

export function projectCommand(
  input: string,
  key: { ctrl?: boolean; meta?: boolean },
): ProjectCommand | null {
  if (key.ctrl || key.meta) return null;
  return input === "n" ? "create"
    : input === "e" ? "edit"
      : input === "r" ? "rename"
        : input === "u" ? "unregister"
          : input === "d" ? "delete"
            : null;
}

type Form =
  | { kind: "create"; step: "name" | "process" | "mode"; name: string; process: string; mode: TargetMode; device?: DeviceSelector }
  | { kind: "edit"; step: "process" | "mode" | "entry"; name: string; process: string; mode: TargetMode; entry: string }
  | { kind: "rename"; step: "name" | "strategy"; name: string; nextName: string; moveConventionalSources: boolean }
  | { kind: "unregister"; name: string }
  | { kind: "delete"; name: string; confirmation: string };

type ErrorDetail = { code: string; message: string; residue?: string };
type Report =
  | { kind: "success"; result: ProjectResult; refreshError?: ErrorDetail }
  | { kind: "error"; error: ErrorDetail };

function errorDetail(error: unknown): ErrorDetail {
  if (error instanceof ProjectError) {
    return { code: error.code, message: error.message, residue: error.residue };
  }
  return {
    code: "unexpected",
    message: error instanceof Error ? error.message : String(error),
  };
}

function conventionalEntry(name: string): string {
  return `agent/targets/${name}/index.ts`;
}

function updateText(form: Form, change: (value: string) => string): Form {
  if (form.kind === "create" && form.step === "name") return { ...form, name: change(form.name) };
  if (form.kind === "create" && form.step === "process") return { ...form, process: change(form.process) };
  if (form.kind === "edit" && form.step === "process") return { ...form, process: change(form.process) };
  if (form.kind === "edit" && form.step === "entry") return { ...form, entry: change(form.entry) };
  if (form.kind === "rename" && form.step === "name") return { ...form, nextName: change(form.nextName) };
  if (form.kind === "delete") return { ...form, confirmation: change(form.confirmation) };
  return form;
}

function isTextStep(form: Form): boolean {
  return form.kind === "delete"
    || (form.kind === "create" && form.step !== "mode")
    || (form.kind === "edit" && form.step !== "mode")
    || (form.kind === "rename" && form.step === "name");
}

export function ProjectPanel(props: {
  focused: boolean;
  blockedTargetNames: readonly string[];
  createRequest?: ProjectCreateRequest | null;
  onChanged(): void;
  onCaptureChange(active: boolean): void;
}): React.JSX.Element {
  const [service] = useState<ProjectService>(() => currentProjectService());
  const [targets, setTargets] = useState<Target[]>([]);
  const [cursor, setCursor] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const capture = useRef(false);
  const consumedCreateRequest = useRef(0);
  const captureCallback = useRef(props.onCaptureChange);
  captureCallback.current = props.onCaptureChange;

  const refresh = (preferredName?: string): void => {
    const next = service.list();
    setTargets(next);
    setCursor((current) => {
      if (preferredName) {
        const preferred = next.findIndex((target) => target.name === preferredName);
        if (preferred >= 0) return preferred;
      }
      return Math.min(current, Math.max(0, next.length - 1));
    });
  };

  useEffect(() => {
    try {
      refresh();
    } catch (error) {
      setReport({ kind: "error", error: errorDetail(error) });
    }
  }, [service]);

  useEffect(() => () => {
    if (capture.current) {
      capture.current = false;
      captureCallback.current(false);
    }
  }, []);

  const setCapture = (active: boolean): void => {
    if (capture.current === active) return;
    capture.current = active;
    captureCallback.current(active);
  };

  const openForm = (next: Form): void => {
    setReport(null);
    setForm(next);
    setCapture(true);
  };

  const closeForm = (): void => {
    setForm(null);
    setCapture(false);
  };

  useEffect(() => {
    const request = props.createRequest;
    if (!request || request.id === consumedCreateRequest.current) return;
    consumedCreateRequest.current = request.id;
    openForm({
      kind: "create",
      step: "name",
      name: request.suggestedName,
      process: request.process,
      mode: "attach",
      ...(request.device ? { device: request.device } : {}),
    });
  }, [props.createRequest]);

  const apply = async (operation: () => Promise<ProjectResult>): Promise<void> => {
    setBusy(true);
    setReport(null);
    let result: ProjectResult;
    try {
      result = await operation();
    } catch (error) {
      setReport({ kind: "error", error: errorDetail(error) });
      setBusy(false);
      return;
    }

    let refreshError: ErrorDetail | undefined;
    try {
      refresh(result.name);
    } catch (error) {
      refreshError = errorDetail(error);
    }
    setReport({ kind: "success", result, refreshError });
    setBusy(false);
    closeForm();
    props.onChanged();
  };

  const clamped = Math.min(cursor, Math.max(0, targets.length - 1));
  const selected = targets[clamped];

  useInput((input, key) => {
    if (form) {
      if (busy) return;
      if (key.escape) {
        closeForm();
        return;
      }

      if (form.kind === "unregister") {
        if (input.toLowerCase() === "y") {
          void apply(() => service.remove({ name: form.name, policy: "unregister" }));
        } else if (input.toLowerCase() === "n" || key.return) {
          closeForm();
        }
        return;
      }

      if (form.kind === "create" && form.step === "mode") {
        if (key.leftArrow || key.upArrow || input.toLowerCase() === "a") setForm({ ...form, mode: "attach" });
        else if (key.rightArrow || key.downArrow || input.toLowerCase() === "s") setForm({ ...form, mode: "spawn" });
        else if (key.return) {
          void apply(() => service.create({
            name: form.name.trim(),
            process: form.process.trim(),
            mode: form.mode,
            ...(form.device ? { device: form.device } : {}),
          }));
        }
        return;
      }

      if (form.kind === "edit" && form.step === "mode") {
        if (key.leftArrow || key.upArrow || input.toLowerCase() === "a") setForm({ ...form, mode: "attach" });
        else if (key.rightArrow || key.downArrow || input.toLowerCase() === "s") setForm({ ...form, mode: "spawn" });
        else if (key.return) setForm({ ...form, step: "entry" });
        return;
      }

      if (form.kind === "rename" && form.step === "strategy") {
        if (key.leftArrow || key.upArrow || input.toLowerCase() === "m") {
          setForm({ ...form, moveConventionalSources: true });
        } else if (key.rightArrow || key.downArrow || input.toLowerCase() === "g") {
          setForm({ ...form, moveConventionalSources: false });
        } else if (key.return) {
          void apply(() => service.rename(form.name, form.nextName.trim(), {
            moveConventionalSources: form.moveConventionalSources,
          }));
        }
        return;
      }

      if (key.return) {
        if (form.kind === "create" && form.step === "name") {
          setForm({ ...form, step: "process" });
        } else if (form.kind === "create" && form.step === "process") {
          setForm({ ...form, step: "mode" });
        } else if (form.kind === "edit" && form.step === "process") {
          setForm({ ...form, step: "mode" });
        } else if (form.kind === "edit" && form.step === "entry") {
          void apply(() => service.update(form.name, {
            process: form.process.trim(),
            mode: form.mode,
            entry: form.entry.trim(),
          }));
        } else if (form.kind === "rename" && form.step === "name") {
          setForm({ ...form, step: "strategy" });
        } else if (form.kind === "delete") {
          if (form.confirmation !== form.name) {
            setReport({
              kind: "error",
              error: {
                code: "confirmation",
                message: `typed confirmation must exactly match "${form.name}"`,
              },
            });
          } else {
            void apply(() => service.remove({
              name: form.name,
              policy: "delete-sources",
              confirmation: form.confirmation,
            }));
          }
        }
        return;
      }

      if (isTextStep(form)) {
        if (key.ctrl && input.toLowerCase() === "u") {
          setForm((current) => current ? updateText(current, () => "") : current);
        } else if (key.backspace || key.delete) {
          setForm((current) => current ? updateText(current, (value) => value.slice(0, -1)) : current);
        } else if (!key.ctrl && !key.meta && input) {
          setForm((current) => current ? updateText(current, (value) => value + input) : current);
        }
      }
      return;
    }

    // Ink delivers one keypress to every mounted useInput handler. Global
    // Ctrl shortcuts are owned by App; never reinterpret their character as
    // a destructive project command (for example Ctrl+D as delete).
    if (key.ctrl || key.meta) return;
    const command = projectCommand(input, key);

    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => Math.min(Math.max(0, targets.length - 1), current + 1));
      return;
    }
    if (command === "create") {
      openForm({ kind: "create", step: "name", name: "", process: "", mode: "attach" });
      return;
    }
    if (!selected) return;
    if ((command === "rename" || command === "unregister" || command === "delete") && props.blockedTargetNames.includes(selected.name)) {
      setReport({
        kind: "error",
        error: { code: "live_session", message: `close the live/connecting ${selected.name} session before rename, unregister, or delete` },
      });
      return;
    }
    if (command === "edit") {
      openForm({
        kind: "edit",
        step: "process",
        name: selected.name,
        process: selected.config.process,
        mode: selected.config.mode,
        entry: selected.config.entry,
      });
    } else if (command === "rename") {
      openForm({
        kind: "rename",
        step: "name",
        name: selected.name,
        nextName: selected.name,
        moveConventionalSources: selected.config.entry === conventionalEntry(selected.name),
      });
    } else if (command === "unregister") {
      openForm({ kind: "unregister", name: selected.name });
    } else if (command === "delete") {
      openForm({ kind: "delete", name: selected.name, confirmation: "" });
    }
  }, { isActive: props.focused });

  const windowStart = Math.max(0, Math.min(clamped - (VIEW >> 1), Math.max(0, targets.length - VIEW)));
  const visible = targets.slice(windowStart, windowStart + VIEW);

  const formView = form && (
    <Box flexDirection="column" borderStyle="round" borderColor={form.kind === "delete" ? "red" : "yellow"} paddingX={1}>
      {form.kind === "create" && form.step === "name" && (
        <>
          <Text bold>create target · 1/3 name</Text>
          <Text>name: {form.name}<Text inverse> </Text></Text>
          <Text dimColor>lowercase name · enter next · ctrl+u clear · escape cancel</Text>
        </>
      )}
      {form.kind === "create" && form.step === "process" && (
        <>
          <Text bold>create {form.name || "(unnamed)"} · 2/3 process</Text>
          <Text>process: {form.process}<Text inverse> </Text></Text>
          <Text dimColor>process name or executable path · enter next · ctrl+u clear</Text>
        </>
      )}
      {form.kind === "create" && form.step === "mode" && (
        <>
          <Text bold>create {form.name || "(unnamed)"} · 3/3 mode</Text>
          <Text>{form.mode === "attach" ? "[attach]" : " attach "}  {form.mode === "spawn" ? "[spawn]" : " spawn "}</Text>
          <Text dimColor>←/→ or a/s select · enter create · escape cancel</Text>
        </>
      )}

      {form.kind === "edit" && form.step === "process" && (
        <>
          <Text bold>edit {form.name} · 1/3 process</Text>
          <Text>process: {form.process}<Text inverse> </Text></Text>
          <Text dimColor>backspace edits · ctrl+u clears · enter next · escape cancel</Text>
        </>
      )}
      {form.kind === "edit" && form.step === "mode" && (
        <>
          <Text bold>edit {form.name} · 2/3 mode</Text>
          <Text>{form.mode === "attach" ? "[attach]" : " attach "}  {form.mode === "spawn" ? "[spawn]" : " spawn "}</Text>
          <Text dimColor>←/→ or a/s select · enter next · escape cancel</Text>
        </>
      )}
      {form.kind === "edit" && form.step === "entry" && (
        <>
          <Text bold>edit {form.name} · 3/3 entry</Text>
          <Text>entry: {form.entry}<Text inverse> </Text></Text>
          <Text dimColor>repo-relative existing source · ctrl+u clear · enter save</Text>
        </>
      )}

      {form.kind === "rename" && form.step === "name" && (
        <>
          <Text bold>rename {form.name} · 1/2 new name</Text>
          <Text>new name: {form.nextName}<Text inverse> </Text></Text>
          <Text dimColor>ctrl+u clear · enter choose source policy · escape cancel</Text>
        </>
      )}
      {form.kind === "rename" && form.step === "strategy" && (
        <>
          <Text bold>rename {form.name} → {form.nextName || "(empty)"} · 2/2 policy</Text>
          <Text color={form.moveConventionalSources ? "cyan" : undefined}>
            {form.moveConventionalSources ? "[move conventional sources]" : " move conventional sources "}
          </Text>
          <Text color={!form.moveConventionalSources ? "cyan" : undefined}>
            {!form.moveConventionalSources ? "[registry only — source entry unchanged]" : " registry only — source entry unchanged "}
          </Text>
          <Text dimColor>←/→ or m/g select · enter rename · escape cancel</Text>
        </>
      )}

      {form.kind === "unregister" && (
        <>
          <Text bold color="yellow">UNREGISTER ONLY: {form.name}</Text>
          <Text>Removes the registry entry. Source files are kept.</Text>
          <Text dimColor>y confirm unregister · n/enter/escape cancel</Text>
        </>
      )}

      {form.kind === "delete" && (
        <>
          <Text bold color="red">DELETE SOURCES: {form.name}</Text>
          <Text color="red">Unregisters the target and permanently deletes its conventional source directory.</Text>
          <Text>This is different from unregister, which keeps all source files.</Text>
          <Text>type exact name "{form.name}": {form.confirmation}<Text inverse> </Text></Text>
          <Text dimColor>enter delete only on exact match · ctrl+u clear · escape cancel</Text>
        </>
      )}
      {busy && <Text color="yellow">applying project operation…</Text>}
    </Box>
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="column">
        <Text bold>projects</Text>
        <Text dimColor>↑/↓ select · n/e/r/u/d manage · d deletes sources</Text>
      </Box>
      {targets.length === 0 && <Text dimColor>no registered targets — press n to create one</Text>}
      {visible.map((target, index) => {
        const absoluteIndex = windowStart + index;
        return (
          <Text key={target.name} color={absoluteIndex === clamped ? "cyan" : undefined}>
            {absoluteIndex === clamped ? "❯ " : "  "}{target.name}
            <Text dimColor>  {target.config.mode} · {target.config.process}</Text>
          </Text>
        );
      })}
      {selected && !form && (
        <Box flexDirection="column" marginTop={1}>
          <Text><Text bold>{selected.name}</Text> · {selected.config.mode} · {selected.config.process}</Text>
          <Text dimColor>entry: {selected.config.entry}</Text>
          <Text dimColor>device: {selected.config.device ? deviceSelectorLabel(selected.config.device) : "local (default)"}</Text>
          {props.blockedTargetNames.includes(selected.name) && (
            <Text color="yellow">live/connecting session · rename, unregister, and delete disabled</Text>
          )}
          {selected.config.processByPlatform && Object.keys(selected.config.processByPlatform).length > 0 && (
            <Text dimColor>platform processes: {JSON.stringify(selected.config.processByPlatform)}</Text>
          )}
        </Box>
      )}
      {formView}
      {report?.kind === "success" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">
            {report.result.operation}: {report.result.name} · {report.result.entry}
          </Text>
          {report.result.warnings.map((warning, index) => (
            <Text key={index} color="yellow">warning: {warning}</Text>
          ))}
          {report.refreshError && (
            <>
              <Text color="red">refresh [{report.refreshError.code}]: {report.refreshError.message}</Text>
              {report.refreshError.residue && <Text color="red">residue: {report.refreshError.residue}</Text>}
            </>
          )}
        </Box>
      )}
      {report?.kind === "error" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">[{report.error.code}] {report.error.message}</Text>
          {report.error.residue && <Text color="red">residue: {report.error.residue}</Text>}
        </Box>
      )}
    </Box>
  );
}
