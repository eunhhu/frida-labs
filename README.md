# flab

Analyze an authorized game and build reusable Frida Instruments.

flab has one simple flow:

```text
1 Connect  →  2 Analyze  →  3 Instrument
```

The TUI is for people. ACP/MCP and the structured CLI are for AI agents. All
use the same device, session, action, Record, authoring, and cleanup engine.

## Start in 60 seconds

```sh
bun install
bun run flab
```

Then use the screen in this order (the number keys switch directly):

1. Press `1`: **Connect** — type the game name, choose it, and press Enter.
2. Press `2`: **Analyze** — inspect actions, explore memory, or Record one play scenario.
3. Press `3`: **Instrument** — use generated input fields, checkboxes, sliders,
   value choices, and a linked live-state pane.

Press `Ctrl+V` to switch local, USB/mobile, exact, or remote devices. Press
`Ctrl+P` switches the same three workspaces. Every selectable TUI list renders
at most three choices; advanced surfaces stay contextual under Analyze or
Instrument. An action form also renders at most three fields at once. Use
`←`/`→` or Space for checkboxes, sliders, and choices; type directly into input
fields; press `s` to refresh linked state.

You do not need to learn the full CLI to use the TUI.

## Choose one entry point

| Goal | Use | Start with |
| --- | --- | --- |
| Connect and use a game manually | Guided TUI | `bun run flab` |
| Give flab to an ACP coding agent | ACP gateway | `bun run flab -- acp` |
| Give flab to an MCP harness | MCP server | `bun run flab -- mcp` |
| Ask a coding agent to build a game-specific Instrument | Harness skill | See “Build an Instrument with an AI harness” below |
| Automate analysis through packaging | Agent Control API | `bun run flab -- agent --json` |
| Control one selected live session | Live JSON protocol | `bun run flab -- capabilities --json` |
| Run one bounded operation | Regular CLI | `bun run flab -- --help` |

An AI agent should not scrape the TUI or send arrow keys. An ACP client starts
`flab acp`; an MCP harness starts `flab mcp`; a basic process can keep one
`flab agent --json` process open and exchange typed NDJSON requests.

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

## Build an Instrument with an AI harness

Give the agent five facts. Plain language is fine:

```text
Use the build-game-mod workflow.
Game: Terraria
Process: Terraria.exe
Device: local
Start mode: attach
Wanted features: objectives/win-loss, progression, economy/rewards, combat,
cooldowns, inventory, content, aim assist, ESP/awareness, movement assistance,
accessibility, training, and QoL

This is my authorized owned-offline instance. Finish the game-specific
Instrument, human interface, Agent API, cleanup, reattach, and package.
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
codex '$build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, progression, economy, combat, aim assist, ESP, movement assistance, content, QoL"'
```

The complete copy-paste commands, remote/mobile variants, safety boundary,
recon sequence, coverage matrix, and definition of done are in
[the AI harness guide](docs/agent-game-mod-guide.md).

The latest physical Android device run, per-game coverage, blocked scope, and
reproducible verification results are in
[the Android live-verification report](docs/android-live-verification.md).
The owned-offline Windows compatibility sweep is in
[the Windows Steam E2E report](docs/windows-steam-e2e-report.md).

A finished Instrument provides the same game actions through:

- a game-specific control panel in `bun run flab -- tui <target>`;
- an advanced human console in `bun run flab -- run <target>` with generated
  `.help`, `/help`, and `:help` commands;
- a persistent agent session in `bun run flab -- run <target> --session --json`;
- the global authoring API in `bun run flab -- agent --json`;
- an auto-detected upstream ACP agent in `bun run flab -- acp`;
- the direct MCP tool server in `bun run flab -- mcp`;
- a checksummed package from `bun run flab -- package <target>`;
- a target-local README with tested commands, features, cleanup, and limits;
- an evidence-backed semantic model for win/loss, rewards, economy, entities,
  persistence, and applicable assist/training surfaces.

## Common commands

Run `bun run flab -- --help` for the grouped overview, or append `--help` to a
command for its exact usage.

### Connect and use

```sh
bun run flab                              # guided TUI
bun run flab -- tui terraria              # connect one saved game immediately
bun run flab -- devices                   # reachable devices
bun run flab -- processes Terraria        # search running apps
bun run flab -- run terraria              # saved target + advanced console (.help or /help)
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
bun run flab -- package terraria
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

## ACP and MCP agent access

Let flab find locally installed ACP agents, or select one when several exist:

```sh
bun run flab -- acp detect --json
bun run flab -- acp
bun run flab -- acp --upstream opencode
```

The ACP gateway is transparent: it proxies ACP v1 to the chosen coding agent
and injects flab as an MCP server into each ACP session. Harnesses that already
understand MCP can skip the gateway and start `bun run flab -- mcp` directly.
Both expose the same `flab_control` and cursor-based `flab_events` tools.

Claude Code can consume the repository `.mcp.json`, while Codex discovers the
equivalent `.codex/config.toml`. GJC's SDK-backed ACP does not accept session
MCP injection, so launch its standalone mode with
`gjc --mcp-config "$PWD/.mcp.json" ...` (absolute path required) instead.

Zed users add a custom External Agent whose command is the compiled `flab`
binary and whose args are `["acp"]`. A source-checkout and multi-agent example
is in the linked guide.

See [the Agent Control API guide](docs/agent-control-api.md) for explicit JSON
upstream commands, authorization, transport details, and operation schemas.

## Record one human play scenario

Analyze → Record has exactly three actions: Plan, Record, and Stop + summarize.
Enter a function name (or `module!function`), plan up to three candidates, start
a bounded capture, then perform one natural game action. flab persists function
entry/exit timing, threads, raw arguments, returns, durations, and optional
backtraces under `artifacts/records/`. The agent reads small pages or an
aggregate summary instead of needing video or a massive raw trace.

The Record RPC surface is linked into the generic probe, every saved Instrument,
and every newly scaffolded Instrument. Event/duration/storage limits stop and
detach hooks automatically; the TUI then opens the completed summary.

Record is causal runtime evidence, not a replacement for visual meaning. Add a
human note or screenshot when the mechanic depends on color, geometry, or
animation visible only on screen.

## Direct Agent Control API

Start the vendor-neutral control process before a game is selected:

```sh
bun run flab -- agent --json
```

It covers authorization, device/process discovery, Instrument registration and
source editing, module linking, build, static verification, live descriptor
actions, cleanup, and packaging. The full protocol and owned-offline/private-lab
authorization examples are in [the Agent Control API guide](docs/agent-control-api.md).

## Selected live-session protocol

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

## What a saved Instrument contains

Targets live in `agent/targets/<game>/index.ts` and are registered in
`frida-labs.json`. Their `__describe()` metadata drives all three interfaces.

Use short labels and stable categories such as `Objectives`, `Economy`,
`Player`, `Combat`, `World`, `Inventory`, `Entities`, `Assist`, `Visual`,
`Movement`, `Training`, `Content`, `QoL`, and `Debug`. Mark each action's
arguments, read/write effect, return type, and capabilities truthfully.

Required target behavior:

- make game-specific progression/combat/resource/content actions the primary menu when callable paths exist; treat FPS and keep-awake as secondary QoL;
- map objective/win-loss, reward, economy, persistence, and entity relationships
  before composing completion or resource mods;
- consider default-off aim assist, ESP/awareness, reversible movement,
  accessibility, and training features when the game exposes safe local paths;
- require explicit offline confirmation and a live engagement gate for
  continuous assists; do not implement auto-fire;
- expose real discovery, status, and cleanup actions;
- keep mutations off by default and validate ranges;
- capture original state before writes and restore it on reset/detach;
- own hooks, timers, watches, and freezes with removable handles;
- return bounded JSON-serializable values;
- report unsupported systems instead of inventing offsets or coverage.

## Repository map

```text
agent/lib/                 reusable engine, memory, hook, Record, and Instrument code
agent/targets/<game>/      game-specific glue and descriptors
src/core/                  shared session, Record, ACP/MCP, project, and protocol engine
src/tui/                   human Connect → Analyze → Instrument interface
src/cli/                   command-line adapter over the same core
tests/                     unit, protocol, TUI, launch, and native Frida runtime checks
docs/agent-game-mod-guide.md  full multi-harness execution contract
docs/agent-control-api.md     vendor-neutral authoring and automation protocol
```

Frontends import `src/core/index.ts`; they do not implement separate session or
Frida behavior. Targets may import reusable code only from `agent/lib/`, which
`flab depcheck` enforces.

## Safety boundary

Use flab only on a process and device you own or are authorized to test,
in owned-offline mode or a fully owned, consenting, isolated private test lab.
Private-lab anti-cheat must be absent or officially disabled. Do not bypass
anti-cheat, enter public matchmaking/leaderboards/production economies, or
affect another user's process, account, or data.
