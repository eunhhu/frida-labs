// flab — single entry point. Human TTY launches use Ink; expert/machine modes use CLI.

export {};

const argv = process.argv.slice(2);
const { humanTuiSource } = await import("./cli/human-route.js");
const humanSource = humanTuiSource(argv, Boolean(process.stdin.isTTY && process.stdout.isTTY));

if (humanSource === "default") {
  const { runTui } = await import("./tui/index.js");
  await runTui(undefined);
} else if (humanSource === "tui" || humanSource === "run") {
  const { runTui } = await import("./tui/index.js");
  const { parseCliArgs } = await import("./cli/args.js");
  const { deviceSelectorFromFlags } = await import("./core/devices.js");
  const parsed = parseCliArgs(argv);
  if (parsed.error) throw new Error(parsed.error.message);
  const allowed = humanSource === "run"
    ? ["proc", "spawn", "no-watch", "device", "host", "device-timeout"]
    : ["help", "proc", "device", "host", "device-timeout"];
  const unsupported = Object.keys(parsed.flags).find((flag) => !allowed.includes(flag));
  if (unsupported) throw new Error(`--${unsupported} is not valid for ${humanSource}`);
  if (humanSource === "tui" && parsed.flags.help) {
    console.log([
      "flab tui [target] [--proc P] [--device DEVICE | --host HOST]",
      "",
      "Guided human flow: Connect → Analyze → Instrument.",
      "Omit target to search running apps or choose a saved game.",
      "Provide target to connect it immediately using saved settings.",
    ].join("\n"));
  } else {
    if (parsed.args.length > 1 || (humanSource === "run" && parsed.args.length !== 1)) {
      throw new Error(humanSource === "run"
        ? "usage: flab run <target> [--proc P] [--spawn] [--device DEVICE | --host HOST]"
        : "usage: flab tui [target] [--proc P] [--device DEVICE | --host HOST]");
    }
    const proc = typeof parsed.flags.proc === "string" ? parsed.flags.proc : undefined;
    const target = parsed.args[0];
    const device = deviceSelectorFromFlags(parsed.flags.device, parsed.flags.host, parsed.flags["device-timeout"]);
    await runTui(target, proc, device, {
      spawn: parsed.flags.spawn === true,
      noWatch: parsed.flags["no-watch"] === true,
    });
  }
} else {
  const { runCli } = await import("./cli/index.js");
  process.exit(await runCli(argv));
}
