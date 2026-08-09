import type { CanonicalRpcArgDescriptor, CanonicalRpcDescriptor, RpcUiValue } from "../core/index.js";

export interface InstrumentFormField {
  arg: CanonicalRpcArgDescriptor;
  raw: string;
}

function rawValue(value: RpcUiValue): string {
  return typeof value === "string" ? value : String(value);
}

function initialRaw(arg: CanonicalRpcArgDescriptor): string {
  if (arg.ui.default !== undefined) return rawValue(arg.ui.default);
  if (arg.optional) return "";
  if (arg.ui.control === "checkbox") return "false";
  if (arg.ui.control === "slider") return String(arg.ui.min ?? 0);
  if (arg.ui.control === "select") return rawValue(arg.ui.options?.[0]?.value ?? "");
  return "";
}

export function createInstrumentForm(descriptor: CanonicalRpcDescriptor): InstrumentFormField[] {
  return descriptor.args.map((arg) => ({ arg, raw: initialRaw(arg) }));
}

export function instrumentFieldLabel(field: InstrumentFormField): string {
  return field.arg.ui.label ?? field.arg.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function optionIndex(field: InstrumentFormField): number {
  return field.arg.ui.options?.findIndex((option) => rawValue(option.value) === field.raw) ?? -1;
}

function boundedNumber(field: InstrumentFormField, direction: -1 | 1): string {
  const min = field.arg.ui.min ?? 0;
  const max = field.arg.ui.max ?? min;
  const step = field.arg.ui.step ?? 1;
  const current = field.raw === "" ? (direction > 0 ? min : max) : Number(field.raw);
  const base = Number.isFinite(current) ? current : min;
  const next = Math.min(max, Math.max(min, base + direction * step));
  const precision = field.arg.type === "integer"
    ? 0
    : Math.min(8, Math.max(0, `${step}`.split(".")[1]?.length ?? 0));
  return precision === 0 ? String(Math.round(next)) : next.toFixed(precision).replace(/(?:\.0+|(\.\d*?)0+)$/, "$1");
}

export function adjustInstrumentField(field: InstrumentFormField, direction: -1 | 1): InstrumentFormField {
  if (field.arg.ui.control === "checkbox") {
    const next = field.raw === "" ? direction > 0 : field.raw !== "true";
    return { ...field, raw: String(next) };
  }
  if (field.arg.ui.control === "slider") return { ...field, raw: boundedNumber(field, direction) };
  if (field.arg.ui.control === "select") {
    const options = field.arg.ui.options ?? [];
    if (options.length === 0) return field;
    const current = optionIndex(field);
    const next = (Math.max(0, current) + direction + options.length) % options.length;
    return { ...field, raw: rawValue(options[next]!.value) };
  }
  return field;
}

export function replaceInstrumentField(field: InstrumentFormField, raw: string): InstrumentFormField {
  return field.arg.ui.control === "input" ? { ...field, raw } : field;
}

export function resetInstrumentField(field: InstrumentFormField): InstrumentFormField {
  return { ...field, raw: initialRaw(field.arg) };
}

export function instrumentFormRawArgs(fields: readonly InstrumentFormField[]): string[] {
  let length = fields.length;
  while (length > 0 && fields[length - 1]!.arg.optional && fields[length - 1]!.raw === "") length--;
  return fields.slice(0, length).map((field) => {
    if (field.raw !== "" || !field.arg.optional) return field.raw;
    if (field.arg.ui.control === "checkbox") return "false";
    if (field.arg.ui.control === "slider") return String(field.arg.ui.default ?? field.arg.ui.min ?? 0);
    if (field.arg.ui.control === "select") return rawValue(field.arg.ui.default ?? field.arg.ui.options?.[0]?.value ?? "");
    return "";
  });
}

export function sliderBar(field: InstrumentFormField, width = 12): string {
  const min = field.arg.ui.min ?? 0;
  const max = field.arg.ui.max ?? min + 1;
  const value = Number(field.raw);
  const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const filled = Math.round(ratio * width);
  return `${"━".repeat(filled)}●${"─".repeat(Math.max(0, width - filled))}`;
}

export function instrumentFieldValue(field: InstrumentFormField): string {
  if (field.arg.ui.control === "checkbox") {
    if (field.raw === "") return "[-] auto";
    return field.raw === "true" ? "[✓] on" : "[ ] off";
  }
  if (field.arg.ui.control === "slider") {
    return `◀ ${sliderBar(field)} ${field.raw || "auto"} ▶`;
  }
  if (field.arg.ui.control === "select") {
    const option = field.arg.ui.options?.find((candidate) => rawValue(candidate.value) === field.raw);
    return `◀ ${(option?.label ?? field.raw) || "auto"} ▶`;
  }
  if (field.raw) return `> ${field.raw}`;
  return `> ${field.arg.ui.placeholder ?? (field.arg.optional ? "auto / empty" : "type value")}`;
}
