import { expect, test } from "bun:test";
import { normalizeRpcDescriptors } from "../src/core/actions.js";
import {
  adjustInstrumentField,
  createInstrumentForm,
  instrumentFieldValue,
  instrumentFormRawArgs,
  replaceInstrumentField,
  sliderBar,
} from "../src/tui/instrument-form.js";

function controls() {
  const normalized = normalizeRpcDescriptors([{
    name: "configure",
    capabilities: ["instrument"],
    effect: "control",
    returns: "json",
    args: [
      { name: "query", type: "string", ui: { control: "input", placeholder: "player" } },
      { name: "enabled", type: "boolean", ui: { control: "checkbox", label: "Enabled" } },
      { name: "speed", type: "number", ui: { control: "slider", min: 0.25, max: 3, step: 0.25, default: 1 } },
      { name: "profile", type: "string?", ui: { control: "select", options: [{ label: "Safe", value: "safe" }, { label: "Fast", value: "fast" }] } },
    ],
  }]);
  expect(normalized.warnings).toEqual([]);
  return normalized.descriptors[0]!;
}

test("Instrument form infers stable raw arguments for input, checkbox, slider, and select controls", () => {
  const fields = createInstrumentForm(controls());
  expect(fields.map((field) => field.raw)).toEqual(["", "false", "1", "safe"]);

  fields[0] = replaceInstrumentField(fields[0]!, "pawn");
  fields[1] = adjustInstrumentField(fields[1]!, 1);
  fields[2] = adjustInstrumentField(fields[2]!, 1);
  fields[3] = adjustInstrumentField(fields[3]!, 1);

  expect(instrumentFormRawArgs(fields)).toEqual(["pawn", "true", "1.25", "fast"]);
  expect(instrumentFieldValue(fields[1]!)).toBe("[✓] on");
  expect(instrumentFieldValue(fields[3]!)).toBe("◀ Fast ▶");
  expect(sliderBar(fields[2]!, 8)).toContain("●");
});

test("optional trailing fields are omitted while required empty input remains validation-visible", () => {
  const descriptor = normalizeRpcDescriptors([{
    name: "set",
    capabilities: ["instrument"],
    effect: "control",
    returns: "json",
    args: [
      { name: "value", type: "string" },
      { name: "confirmed", type: "boolean?" },
    ],
  }]).descriptors[0]!;
  expect(instrumentFormRawArgs(createInstrumentForm(descriptor))).toEqual([""]);
});
