// Agent bundle compilation — in-process via frida.Compiler (ships inside the
// `frida` npm package, so it keeps working in a `bun build --compile` binary
// with no node_modules around).

import frida from "frida";
import { join } from "node:path";
import { repoRoot, getTarget } from "./manifest.js";

export const AGENT_OUT = "_agent.js";

function compilerOptions() {
  return {
    projectRoot: repoRoot(),
    sourceMaps: frida.SourceMaps.Omitted,
    compression: frida.JsCompression.None,
    typeCheck: frida.TypeCheckMode.None, // tsc is the typechecker of record; compile must be fast
  };
}

function formatDiagnostics(diags: unknown): string {
  try {
    const list = diags as Array<{ messageText?: string; file?: { fileName?: string }; start?: number }>;
    return list.map((d) => `${d.file?.fileName ?? "?"}: ${d.messageText ?? JSON.stringify(d)}`).join("\n");
  } catch { return String(diags); }
}

/** Compile an agent entry (absolute path). Returns the bundle source. */
export async function compileEntry(entry: string): Promise<string> {
  const compiler = new frida.Compiler();
  let diagnostics = "";
  const onDiag = (d: unknown) => { diagnostics += formatDiagnostics(d) + "\n"; };
  compiler.diagnostics.connect(onDiag);
  try {
    return await compiler.build(entry, compilerOptions());
  } catch (e) {
    throw new Error(`compile failed: ${(e as Error).message}${diagnostics ? "\n" + diagnostics.trim() : ""}`);
  } finally {
    compiler.diagnostics.disconnect(onDiag);
  }
}

/** Compile a manifest target's agent entry. Returns the bundle source. */
export async function compileAgent(target: string): Promise<string> {
  try {
    return await compileEntry(join(repoRoot(), getTarget(target).entry));
  } catch (e) {
    throw new Error((e as Error).message.replace("compile failed:", `compile failed for "${target}":`));
  }
}

/**
 * Watch-compile an entry: invokes onBundle with every fresh bundle. Returns
 * a stop function. frida.Compiler.watch tracks the whole import graph.
 */
export async function watchEntry(entry: string, onBundle: (bundle: string) => void, onError: (msg: string) => void): Promise<() => void> {
  const compiler = new frida.Compiler();
  const cancellable = new frida.Cancellable();
  const onOutput = (bundle: string) => onBundle(bundle);
  const onDiag = (d: unknown) => onError(formatDiagnostics(d));
  compiler.output.connect(onOutput);
  compiler.diagnostics.connect(onDiag);
  await compiler.watch(entry, compilerOptions(), cancellable);
  return () => {
    compiler.output.disconnect(onOutput);
    compiler.diagnostics.disconnect(onDiag);
    // Without cancel() the compiler's fs watch keeps firing after stop().
    cancellable.cancel();
  };
}
