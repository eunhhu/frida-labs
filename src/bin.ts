// flab — single entry point. No args (and a TTY) → TUI; args → CLI.

export {};

const argv = process.argv.slice(2);

if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const { runTui } = await import("./tui/index.js");
  await runTui(undefined);
} else if (argv[0] === "tui") {
  const { runTui } = await import("./tui/index.js");
  const { parseCliArgs } = await import("./cli/args.js");
  const { deviceSelectorFromFlags } = await import("./core/devices.js");
  const parsed = parseCliArgs(argv);
  if (parsed.error) throw new Error(parsed.error.message);
  const unsupported = Object.keys(parsed.flags).find((flag) => !["help", "proc", "device", "host", "device-timeout"].includes(flag));
  if (unsupported) throw new Error(`--${unsupported} is not valid for tui`);
  if (parsed.flags.help) {
    console.log([
      "flab tui [target] [--proc P] [--device DEVICE | --host HOST]",
      "",
      "Guided human flow: Connect → Analyze → Instrument.",
      "Omit target to search running apps or choose a saved game.",
      "Provide target to connect it immediately using saved settings.",
    ].join("\n"));
  } else {
    if (parsed.args.length > 1) throw new Error("usage: flab tui [target] [--proc P] [--device DEVICE | --host HOST]");
    const proc = typeof parsed.flags.proc === "string" ? parsed.flags.proc : undefined;
    const target = parsed.args[0];
    const device = deviceSelectorFromFlags(parsed.flags.device, parsed.flags.host, parsed.flags["device-timeout"]);
    await runTui(target, proc, device);
  }
} else {
  const { runCli } = await import("./cli/index.js");
  process.exit(await runCli(argv));
}
