import type { TargetConfig } from "./manifest.js";
import type { ProjectResult } from "./projects.js";

export type TargetMutationOperation =
  | "set"
  | "rename"
  | "unregister"
  | "delete";

interface TargetMutationBase {
  ok: true;
  operation: TargetMutationOperation;
  target: string;
  warnings: string[];
}

export type TargetMutationSuccess =
  | (TargetMutationBase & {
      operation: "rename";
      entry: string;
      config: TargetConfig;
    })
  | (TargetMutationBase & {
      operation: "set";
      config: TargetConfig;
    })
  | (TargetMutationBase & {
      operation: "unregister";
      entry: string;
    })
  | (TargetMutationBase & {
      operation: "delete";
    });

export interface TargetMutationFailure {
  ok: false;
  operation: TargetMutationOperation;
  code: string;
  message: string;
  residue?: string;
}

export function targetMutationSuccess(
  operation: TargetMutationOperation,
  result: ProjectResult,
): TargetMutationSuccess {
  const base = {
    ok: true as const,
    operation,
    target: result.name,
  };
  const warnings = [...result.warnings];

  switch (operation) {
    case "rename":
      return { ...base, operation, entry: result.entry, config: result.config, warnings };
    case "set":
      return { ...base, operation, config: result.config, warnings };
    case "unregister":
      return { ...base, operation, entry: result.entry, warnings };
    case "delete":
      return { ...base, operation, warnings };
  }
}

export function targetMutationFailure(
  operation: TargetMutationOperation,
  code: string,
  message: string,
  residue?: string,
): TargetMutationFailure {
  return {
    ok: false,
    operation,
    code,
    message,
    ...(residue === undefined ? {} : { residue }),
  };
}
