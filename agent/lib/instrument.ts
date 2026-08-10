// Declarative Instrument authoring. A target declares each callable once;
// this module generates both rpc.exports and the descriptor inventory used by
// the human dashboard and every agent protocol.

export type InstrumentCapability = "instrument" | "debug" | "analysis";
export type InstrumentEffect = "read" | "write" | "hook" | "control";
export type InstrumentReturn = "scalar" | "json" | "table" | "hex" | "verification";
export type InstrumentArgType = "string" | "number" | "integer" | "boolean" | "json" | "address" | "pattern";
export type InstrumentUiValue = string | number | boolean;

export interface InstrumentUiOption {
  label: string;
  value: InstrumentUiValue;
}

export interface InstrumentArg {
  name: string;
  type?: InstrumentArgType | `${InstrumentArgType}?`;
  optional?: boolean;
  ui?: {
    control?: "input" | "checkbox" | "slider" | "select";
    label?: string;
    placeholder?: string;
    default?: InstrumentUiValue;
    min?: number;
    max?: number;
    step?: number;
    options?: InstrumentUiOption[];
  };
}

export interface InstrumentActionOptions {
  label: string;
  category?: string;
  doc?: string;
  args?: InstrumentArg[];
  returns?: InstrumentReturn;
  status?: string;
  capabilities?: InstrumentCapability[];
}

type InstrumentHandler = (...args: any[]) => any;

export interface InstrumentActionDefinition {
  readonly kind: "flab.instrument.action";
  readonly run: InstrumentHandler;
  readonly descriptor: {
    label: string;
    category: string;
    args: InstrumentArg[];
    doc?: string;
    capabilities: InstrumentCapability[];
    effect: InstrumentEffect;
    returns: InstrumentReturn;
    statusAction?: string;
  };
}

export type InstrumentActions = Record<string, InstrumentActionDefinition>;

function action(
  effect: InstrumentEffect,
  defaultCapabilities: InstrumentCapability[],
  options: InstrumentActionOptions,
  run: InstrumentHandler,
): InstrumentActionDefinition {
  if (!options.label.trim()) throw new Error("Instrument action label must be non-empty");
  return {
    kind: "flab.instrument.action",
    run,
    descriptor: {
      label: options.label.trim(),
      category: options.category?.trim() || "Other",
      args: options.args ? [...options.args] : [],
      ...(options.doc ? { doc: options.doc } : {}),
      capabilities: options.capabilities ? [...options.capabilities] : defaultCapabilities,
      effect,
      returns: options.returns ?? "json",
      ...(options.status ? { statusAction: options.status } : {}),
    },
  };
}

export function read(options: InstrumentActionOptions, run: InstrumentHandler): InstrumentActionDefinition {
  return action("read", ["instrument", "analysis"], options, run);
}

export function analyze(options: InstrumentActionOptions, run: InstrumentHandler): InstrumentActionDefinition {
  return action("read", ["analysis"], options, run);
}

export function write(options: InstrumentActionOptions, run: InstrumentHandler): InstrumentActionDefinition {
  return action("write", ["instrument"], options, run);
}

export function control(options: InstrumentActionOptions, run: InstrumentHandler): InstrumentActionDefinition {
  return action("control", ["instrument"], options, run);
}

export function hook(options: InstrumentActionOptions, run: InstrumentHandler): InstrumentActionDefinition {
  return action("hook", ["instrument"], options, run);
}

interface BaseFieldOptions {
  label?: string;
  optional?: boolean;
  default?: InstrumentUiValue;
  placeholder?: string;
}

function typed(type: InstrumentArgType, optional: boolean | undefined): InstrumentArgType | `${InstrumentArgType}?` {
  return optional ? `${type}?` : type;
}

function input(name: string, type: InstrumentArgType, options: BaseFieldOptions = {}): InstrumentArg {
  return {
    name,
    type: typed(type, options.optional),
    ui: {
      control: "input",
      ...(options.label ? { label: options.label } : {}),
      ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      ...(options.default !== undefined ? { default: options.default } : {}),
    },
  };
}

export const field = {
  text(name: string, options: BaseFieldOptions = {}): InstrumentArg {
    return input(name, "string", options);
  },
  json(name: string, options: BaseFieldOptions = {}): InstrumentArg {
    return input(name, "json", options);
  },
  integer(name: string, options: BaseFieldOptions = {}): InstrumentArg {
    return input(name, "integer", options);
  },
  number(name: string, options: BaseFieldOptions = {}): InstrumentArg {
    return input(name, "number", options);
  },
  address(name: string, options: BaseFieldOptions = {}): InstrumentArg {
    return input(name, "address", options);
  },
  pattern(name: string, options: BaseFieldOptions = {}): InstrumentArg {
    return input(name, "pattern", options);
  },
  checkbox(name: string, options: Omit<BaseFieldOptions, "placeholder"> = {}): InstrumentArg {
    return {
      name,
      type: typed("boolean", options.optional),
      ui: {
        control: "checkbox",
        ...(options.label ? { label: options.label } : {}),
        ...(options.default !== undefined ? { default: options.default } : {}),
      },
    };
  },
  offline(options: { optional?: boolean; label?: string } = {}): InstrumentArg {
    return field.checkbox("offlineConfirmed", {
      optional: options.optional,
      label: options.label ?? "Owned offline session",
    });
  },
  slider(name: string, options: {
    label?: string;
    optional?: boolean;
    integer?: boolean;
    min: number;
    max: number;
    step: number;
    default?: number;
  }): InstrumentArg {
    return {
      name,
      type: typed(options.integer ? "integer" : "number", options.optional),
      ui: {
        control: "slider",
        ...(options.label ? { label: options.label } : {}),
        min: options.min,
        max: options.max,
        step: options.step,
        ...(options.default !== undefined ? { default: options.default } : {}),
      },
    };
  },
  select(name: string, options: {
    label?: string;
    optional?: boolean;
    type?: "string" | "number" | "integer" | "boolean";
    default?: InstrumentUiValue;
    options: InstrumentUiOption[];
  }): InstrumentArg {
    return {
      name,
      type: typed(options.type ?? "string", options.optional),
      ui: {
        control: "select",
        ...(options.label ? { label: options.label } : {}),
        ...(options.default !== undefined ? { default: options.default } : {}),
        options: [...options.options],
      },
    };
  },
};

export function instrumentDescriptors(actions: InstrumentActions): unknown[] {
  return Object.entries(actions).map(([name, definition]) => ({
    name,
    ...definition.descriptor,
  }));
}

export function instrumentHandlers(actions: InstrumentActions): Record<string, InstrumentHandler> {
  return Object.fromEntries(Object.entries(actions).map(([name, definition]) => [name, definition.run]));
}

export interface InstrumentDefinition {
  info?: InstrumentActionDefinition;
  state?: InstrumentActionDefinition;
  actions?: InstrumentActions;
  reset?: InstrumentActionDefinition;
  dispose?: InstrumentActionDefinition;
}

/** Generate the complete RPC surface and __describe inventory from one declaration. */
export function defineInstrument(definition: InstrumentDefinition): Record<string, InstrumentHandler> {
  const reserved = new Set(["__describe", "modInfo", "modState", "resetAll", "dispose"]);
  for (const name of Object.keys(definition.actions ?? {})) {
    if (reserved.has(name)) {
      throw new Error(`Instrument action ${name} is reserved; use the matching top-level field`);
    }
  }
  const actions: InstrumentActions = {
    ...(definition.info ? { modInfo: definition.info } : {}),
    ...(definition.state ? { modState: definition.state } : {}),
    ...(definition.actions ?? {}),
    ...(definition.reset ? { resetAll: definition.reset } : {}),
    ...(definition.dispose ? { dispose: definition.dispose } : {}),
  };
  for (const [name, actionDefinition] of Object.entries(actions)) {
    if (actionDefinition.kind !== "flab.instrument.action") {
      throw new Error(`Instrument action ${name} must use read/analyze/write/control/hook`);
    }
    const statusName = actionDefinition.descriptor.statusAction;
    if (!statusName) continue;
    const status = actions[statusName];
    if (!status || status.descriptor.effect !== "read" ||
        !status.descriptor.capabilities.includes("analysis") ||
        status.descriptor.args.some((arg) => !arg.optional && !arg.type?.endsWith("?"))) {
      throw new Error(`Instrument action ${name} has invalid status action ${statusName}`);
    }
  }
  return {
    ...instrumentHandlers(actions),
    __describe: () => instrumentDescriptors(actions),
  };
}
