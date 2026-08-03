// flab — single entry point. No args (and a TTY) → TUI; args → CLI.

export {};

const argv = process.argv.slice(2);

if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const { runTui } = await import("./tui/index.js");
  await runTui(undefined);
} else if (argv[0] === "tui") {
  const { runTui } = await import("./tui/index.js");
  await runTui(argv[1]);
} else {
  const { runCli } = await import("./cli/index.js");
  process.exit(await runCli(argv));
}
