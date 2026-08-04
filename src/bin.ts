// flab — single entry point. No args (and a TTY) → TUI; args → CLI.

export {};

const argv = process.argv.slice(2);

if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const { runTui } = await import("./tui/index.js");
  await runTui(undefined);
} else if (argv[0] === "tui") {
  const { runTui } = await import("./tui/index.js");
  // flab tui [target] [--proc P] — entry-path targets need --proc, same as run.
  const procIdx = argv.indexOf("--proc");
  const proc = procIdx >= 0 ? argv[procIdx + 1] : undefined;
  const target = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
  await runTui(target, proc);
} else {
  const { runCli } = await import("./cli/index.js");
  process.exit(await runCli(argv));
}
