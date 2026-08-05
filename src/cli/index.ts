// CLI frontend — thin argv → registry mapper.

import {
  commands,
  renderHelp,
  targetMutationFailure,
  type CmdCtx,
  type TargetMutationOperation,
} from "../core/index.js";
import { argvRequestsJson, parseCliArgs } from "./args.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

function mutationOperation(command: string | undefined, args: readonly string[]): TargetMutationOperation | undefined {
  if (command !== "target") return undefined;
  const operation = args[0];
  return (
    operation === "set" ||
    operation === "rename" ||
    operation === "unregister" ||
    operation === "delete"
  ) ? operation : undefined;
}

function writeFailure(
  ctx: CmdCtx,
  operation: TargetMutationOperation | undefined,
  code: string,
  message: string,
  residue?: string,
): void {
  ctx.out(JSON.stringify(
    operation
      ? targetMutationFailure(operation, code, message, residue)
      : { error: message },
  ));
}

export async function runCli(argv: string[], io: CliIo = consoleIo): Promise<number> {
  const parsed = parseCliArgs(argv);
  const cmdName = parsed.command;
  const { args, flags } = parsed;
  const requestedJson = argvRequestsJson(argv);
  const operation = mutationOperation(cmdName, args);

  const ctx: CmdCtx = {
    json: requestedJson || flags.json === true,
    out: io.out,
    err: io.err,
  };

  if (parsed.error) {
    if (ctx.json) writeFailure(ctx, operation, parsed.error.code, parsed.error.message);
    else ctx.err(`${parsed.error.message}\n\n${renderHelp()}`);
    return 2;
  }

  if (!cmdName || cmdName === "help" || flags.help) {
    if (ctx.json) {
      ctx.out(JSON.stringify({
        commands: commands.map(({ name, usage, summary, detail, allowedFlags }) => ({
          name,
          usage,
          summary,
          allowedFlags,
          ...(detail ? { detail } : {}),
        })),
        tui: "flab tui [target]",
      }));
    } else ctx.out(renderHelp());
    return cmdName ? 0 : 2;
  }

  const cmd = commands.find((candidate) => candidate.name === cmdName);
  if (!cmd) {
    const message = `unknown command "${cmdName}"`;
    if (ctx.json) writeFailure(ctx, undefined, "unknown-command", message);
    else ctx.err(`${message}\n\n${renderHelp()}`);
    return 2;
  }

  const unsupported = Object.keys(flags).find((flag) => !cmd.allowedFlags.includes(flag));
  if (unsupported) {
    const message = `--${unsupported} is not valid for ${cmd.name}`;
    if (ctx.json) writeFailure(ctx, operation, "unknown-flag", message);
    else ctx.err(`${message}\nusage: ${cmd.usage}`);
    return 2;
  }

  try {
    return await cmd.run(args, flags, ctx);
  } catch (caught) {
    const error = caught instanceof Error
      ? caught as Error & { code?: string; residue?: string }
      : undefined;
    const message = error?.message ?? String(caught);
    if (ctx.json) {
      writeFailure(
        ctx,
        operation,
        error?.code ?? "command-failed",
        message,
        error?.residue,
      );
    } else ctx.err(message);
    return 1;
  }
}