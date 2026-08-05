# flab

Analyze and mod an authorized offline or single-player game with Frida.

flab has one simple flow:

```text
1 Connect a game  →  2 Use Mods  →  3 Inspect what is happening
```

The TUI is for people. The structured CLI is for AI agents. Both use the same
device, session, action, and cleanup engine.

## Start in 60 seconds

```sh
bun install
bun run flab
```

Then use the screen in this order (the number keys switch directly):

1. Press `1`: **Connect** — type the game name, choose it, and press Enter.
2. Press `2`: **Mods** — run the connected game's named controls and QoL actions.
3. Press `3`: **Inspect** — read game structure, hook checks, errors, and live output.

Press `Ctrl+V` to switch local, USB/mobile, exact, or remote devices. Press
`Ctrl+P` only when you need advanced tools such as manual PID/spawn, REPL,
memory explorer, or target management.

You do not need to learn the full CLI to use the TUI.

## Choose one entry point

| Goal | Use | Start with |
| --- | --- | --- |
| Connect and use a game manually | Guided TUI | `bun run flab` |
| Ask a coding agent to build a game-specific mod | Harness skill | See “Build a mod with an AI harness” below |
| Control one live session from software | Persistent JSON CLI | `bun run flab -- capabilities --json` |
| Run one bounded operation | Regular CLI | `bun run flab -- --help` |

An AI agent should not scrape the TUI or send arrow keys. It should keep one
`--session --json` child process open and exchange typed NDJSON requests.

## Connect local, USB/mobile, or remote

The selected device remains the same through process discovery, attach/spawn,
reconnect, and verification.

```sh
# See every reachable Frida device
bun run flab -- devices

# Search a local process
bun run flab -- processes Terraria

# Search the first USB/mobile device
bun run flab -- processes Terraria --device usb

# Use one exact discovered device
bun run flab -- processes Terraria --device <device-id>

# Use an explicit frida-server endpoint
bun run flab -- processes Terraria --host 10.0.0.8:27042
```

Selector summary:

| Target | Selector |
| --- | --- |
| This computer | `--device local` |
| First USB/mobile device | `--device usb` |
| First discovered remote | `--device remote` |
| Exact visible device | `--device <id>` |
| Explicit endpoint | `--host host:port` |

A PID belongs only to the device where it was discovered.

## Build a mod with an AI harness

Give the agent five facts. Plain language is fine:

```text
Use the build-game-mod workflow.
Game: Terraria
Process: Terraria.exe
Device: local
Start mode: attach
Wanted features: QoL, player, world, and content

This is my authorized offline/single-player instance. Finish the game-specific
menu, REPL, persistent AI controls, cleanup, reattach, and live verification.
```

Invoke the repository skill with the syntax your harness understands:

| Harness | Skill entry |
| --- | --- |
| GJC | `/skill:build-game-mod` |
| Codex CLI/app | `$build-game-mod` or **Build Game Mod** |
| Claude Code | `/build-game-mod` |
| OpenCode | `/game-mod` |

For example:

```sh
codex '$build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world"'
```

The complete copy-paste commands, remote/mobile variants, safety boundary,
recon sequence, coverage matrix, and definition of done are in
[the AI harness guide](docs/agent-game-mod-guide.md).

The latest physical Android device run, per-game coverage, blocked scope, and
reproducible verification results are in
[the Android live-verification report](docs/android-live-verification.md).

A finished target provides the same game actions through:

- a readable game-specific menu in `bun run flab -- tui <target>`;
- a human REPL in `bun run flab -- run <target>`;
- a persistent agent session in `bun run flab -- run <target> --session --json`;
- a target-local README with tested commands, features, cleanup, and limits.

## Common commands

Run `bun run flab -- --help` for the grouped overview, or append `--help` to a
command for its exact usage.

### Connect and use

```sh
bun run flab                              # guided TUI
bun run flab -- tui terraria              # connect one saved game immediately
bun run flab -- devices                   # reachable devices
bun run flab -- processes Terraria        # search running apps
bun run flab -- run terraria              # saved target + human REPL
bun run flab -- probe --pid 1234           # generic quick analysis
```

### Save and manage games

```sh
bun run flab -- targets
bun run flab -- new terraria "Terraria.exe"
bun run flab -- target set terraria --proc "Terraria.exe"
bun run flab -- target rename old-name new-name
bun run flab -- target unregister terraria
bun run flab -- target delete terraria --confirm terraria
```

`unregister` keeps source files. `delete` removes conventional target sources
and requires the exact target name.

### Diagnose and validate

```sh
bun run flab -- doctor
bun run flab -- build terraria
bun run flab -- depcheck
bun run typecheck
bun test
bun run test:runtime
```

If you built the standalone binary with `bun run build-bin`, replace
`bun run flab --` with `./flab`.

## Persistent AI session

Discover the contract, then start exactly one long-lived process:

```sh
bun run flab -- capabilities --json
bun run flab -- probe --pid 1234 --session --json
```

The first stdout line is a `ready` envelope containing the resolved device,
PID, and every allowed action. Send one JSON object per line:

```json
{"id":"1","op":"describe"}
{"id":"2","op":"action","mode":"analysis","action":"modules","args":[""]}
{"id":"3","op":"close"}
```

Managed trace, watch, and freeze actions return stable instrument IDs for
status, update, stop, and delete. Diagnostics stay on stderr; stdout remains
NDJSON-only. The protocol is `flab.ndjson.v1`.

## What a saved game target contains

Targets live in `agent/targets/<game>/index.ts` and are registered in
`frida-labs.json`. Their `__describe()` metadata drives all three interfaces.

Use short labels and stable categories such as `System`, `Player`, `World`,
`Inventory`, `Entities`, `Content`, `QoL`, and `Debug`. Mark each action's
arguments, read/write effect, return type, and capabilities truthfully.

Required target behavior:

- expose real discovery, status, and cleanup actions;
- keep mutations off by default and validate ranges;
- capture original state before writes and restore it on reset/detach;
- own hooks, timers, watches, and freezes with removable handles;
- return bounded JSON-serializable values;
- report unsupported systems instead of inventing offsets or coverage.

## Repository map

```text
agent/lib/                 reusable engine, memory, hook, watch, and instrument code
agent/targets/<game>/      game-specific glue and descriptors
src/core/                  shared device, session, action, project, and JSON protocol engine
src/tui/                   human Connect → Mods → Inspect interface
src/cli/                   command-line adapter over the same core
tests/                     unit, protocol, TUI, launch, and native Frida runtime checks
docs/agent-game-mod-guide.md  full multi-harness execution contract
```

Frontends import `src/core/index.ts`; they do not implement separate session or
Frida behavior. Targets may import reusable code only from `agent/lib/`, which
`flab depcheck` enforces.

## Safety boundary

Use flab only on a process and device you own or are authorized to test,
preferably offline or single-player. Do not bypass anti-cheat, interfere with
online play, or affect another user's process or data.
