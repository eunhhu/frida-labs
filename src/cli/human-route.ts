export type HumanTuiSource = "default" | "tui" | "run";

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((value) => value === `--${name}` || value.startsWith(`--${name}=`));
}

/** Decide which invocations belong to the human Ink frontend before CLI dispatch. */
export function humanTuiSource(argv: readonly string[], tty: boolean): HumanTuiSource | null {
  if (argv.length === 0) return tty ? "default" : null;
  if (argv[0] === "tui") return "tui";
  if (argv[0] !== "run" || !tty) return null;
  if (argv.includes("-h") || ["help", "console", "eval", "session", "json"].some((flag) => hasFlag(argv, flag))) return null;
  return "run";
}
