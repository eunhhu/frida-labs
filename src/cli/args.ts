export type CliFlagValue = string | boolean;

export interface ParsedCliArgs {
  command?: string;
  args: string[];
  flags: Record<string, CliFlagValue>;
  error?: { code: "unknown-flag" | "missing-flag-value"; message: string; flag: string };
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "no-watch",
  "registry-only",
  "session",
  "spawn",
]);

const VALUE_FLAGS = new Set([
  "confirm",
  "device",
  "device-timeout",
  "entry",
  "eval",
  "host",
  "limit",
  "mode",
  "out",
  "pid",
  "platforms",
  "proc",
  "query",
]);

function booleanLiteral(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** Parse long flags without consuming later positional args for booleans. */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const normalized = argv[0] === "--help" || argv[0] === "-h"
    ? ["help", ...argv.slice(1)]
    : argv;
  const [command, ...rest] = normalized;
  const flags: Record<string, CliFlagValue> = {};
  const args: string[] = [];

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (token === "--") {
      args.push(...rest.slice(index + 1));
      break;
    }
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline === undefined) flags[name] = true;
      else {
        const parsed = booleanLiteral(inline);
        if (parsed === null) {
          return { command, args, flags, error: { code: "unknown-flag", flag: name, message: `--${name} accepts only true or false` } };
        }
        flags[name] = parsed;
      }
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      return { command, args, flags, error: { code: "unknown-flag", flag: name, message: `unknown flag --${name}` } };
    }

    if (inline !== undefined) {
      if (inline === "") {
        return { command, args, flags, error: { code: "missing-flag-value", flag: name, message: `--${name} requires a value` } };
      }
      flags[name] = inline;
      continue;
    }

    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { command, args, flags, error: { code: "missing-flag-value", flag: name, message: `--${name} requires a value` } };
    }
    flags[name] = value;
    index++;
  }

  return { command, args, flags };
}

export function argvRequestsJson(argv: readonly string[]): boolean {
  return argv.some((token) => token === "--json" || token === "--json=true");
}
