// CLI frontend — thin argv → registry mapper. Every command supports --json
// for agent consumption. Humans get the same information human-formatted.

import { commands, renderHelp, type CmdCtx } from "../core/index.js";

export async function runCli(argv: string[]): Promise<number> {
  const [cmdName, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else args.push(a);
  }

  const ctx: CmdCtx = {
    json: !!flags.json,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };

  if (!cmdName || cmdName === "help" || flags.help) {
    ctx.out(renderHelp());
    return cmdName ? 0 : 1;
  }

  const cmd = commands.find((c) => c.name === cmdName);
  if (!cmd) {
    ctx.err(`unknown command "${cmdName}"\n\n${renderHelp()}`);
    return 1;
  }
  try {
    return await cmd.run(args, flags, ctx);
  } catch (e) {
    ctx.err(ctx.json ? JSON.stringify({ error: (e as Error).message }) : (e as Error).message);
    return 1;
  }
}
