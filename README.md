# frida-labs

Cross-game Frida debugging workspace. One reusable agent library, one
per-game target folder, one Bun host that compiles, injects, hot-reloads,
and gives you a REPL (or an ink TUI) into the live game process.

Everything runs on the **Bun runtime only** — no make, no shell scripts,
Windows and Unix alike.

## Setup

```sh
bun install
```

## Let an AI harness build the game mod

The repository ships one completion contract and native entry points for GJC,
Codex, Claude Code, and OpenCode. Give the agent the game, process or bundle id,
device, attach/spawn mode, and feature priorities. The finished target must
produce the same game-specific TUI mod menu, REPL, and persistent AI action
surface, with live cleanup/reattach evidence.

```sh
# GJC
gjc '/skill:build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'

# Codex
codex '$build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'

# Claude Code
claude '/build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'

# OpenCode: start `opencode`, then enter this command
/game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"
```

Read the full [AI harness game-mod guide](docs/agent-game-mod-guide.md) for
headless commands, USB/mobile/remote selectors, the recon sequence, descriptor
contract, coverage matrix, runtime tests, and the exact definition of done.

## Drive a game

```sh
flab processes                     # discover live processes + target matches
flab devices                       # list local, USB/mobile, and connected remote devices
flab processes --device usb        # discover processes on the first USB device
flab probe --pid 1234 --device <id> # PID is resolved only on that exact device
flab probe com.example.game --device usb --spawn
flab run <target> --host 10.0.0.8:27042 # explicit frida-server endpoint
flab probe "Some Game.exe"         # one-shot generic analysis attach by name
flab probe --pid 1234              # explicit PID attach; positional digits stay names
flab capabilities --json           # AI-agent protocol + instrument lifecycle schema
flab probe --pid 1234 --session --json # persistent NDJSON agent session
flab run <target>                 # compile + attach + REPL (hot reload on save)
flab run <target> --spawn         # spawn instead of attach
flab tui                          # five-mode TUI: Project/Instrument/Debug/Probe/Analysis
flab tui <target>                 # TUI, attach target and open Instrument mode
flab build <target>               # compile only
flab targets                      # list registered targets
flab target set <target> --proc P # update target
flab target rename <old> <new>    # rename registry + conventional sources
flab target unregister <name>     # remove registry entry; preserve source files
flab target delete <name> --confirm <name>
flab depcheck                     # enforce targets → agent/lib dependency direction
flab doctor                       # environment sanity (runtime, frida server, processes)
bun run typecheck                 # agent + host typecheck
```

The TUI starts in **Project** mode so target lifecycle is visible immediately.
`Ctrl+P` opens the mode/action palette. **Probe** attaches by name/PID or spawns;
its target-launch form exposes spawn- and child-gating independently.
**Instrument** puts the managed create/list/status/update/stop/delete lifecycle
first, then retains Actions, REPL, Explorer, and Observe without recreating
sessions. Stable instrument IDs preserve ownership and verification history.
**Debug** centers crash, exception, detach,
and hook-verification evidence. **Analysis** permits only live-descriptor actions
authorized as `analysis` + `read`; `j`/`k` scroll retained rows and
`PageUp`/`PageDown` re-run the action for bounded result pages rather than slicing
cached data.

The left sidebar always shows the selected device. `v` cycles currently visible
local/USB/remote devices, refreshes that device's process list, and binds later
attach/spawn/reconnect operations to the same identity. Start with
`flab tui --host HOST[:PORT]` for an endpoint not already visible. The process
list supports `/` filtering, shows the exact PID for duplicate
names, and uses `◆` for processes that match a registered target. `n` opens a
target-create form prefilled from the selected process. `Ctrl+D/T/S` focus the persistent process/target/session
sidebar, `Tab` returns to the panel, and `Ctrl+R/W/Q` reconnect, close, and exit.
While a form owns text, Escape cancels it and other global shortcuts do not
consume the input. Project delete requires the exact target name in its TUI
confirmation form.

`flab` is `bun run flab` (bin: `src/bin.ts`) or the compiled binary from
`bun run build-bin`. Every command takes `--json` for agent consumption.

Targets are registered in `frida-labs.json` — the file is the list. A target may
store a default selector such as `{"kind":"usb"}`, `{"kind":"id","id":"..."}`,
or `{"kind":"endpoint","address":"host:27042"}` in its `device` field. Runtime
`--device`/`--host` overrides it. The
manifest stores the Windows process name (`Game.exe`); on macOS/Linux the
session layer automatically also matches the extension-less name.

## Recon a new game before writing a target

```sh
flab probe "Some Game.exe"
```

`_probe` injects an engine-agnostic agent into any process: it detects
Unity (IL2CPP / Mono), Unreal, Cocos2d-x, FNA, and exposes the matching
exploration surface (module/export browsing, memory scan/peek/poke/freeze/
watch, string search, tracing, plus Mono class/method introspection).
`--pid <positive-integer>` selects numeric attach explicitly; a positional string
of digits remains a process name. One-shot Probe stays convenient for a single
query. For AI agents, `--session --json` keeps the same attach alive and accepts
strict `flab.ndjson.v1` requests (`ping`, `describe`, typed `action`, `close`) on
stdin while stdout stays NDJSON-only and diagnostics go to stderr.

## AI agent session

Discover the complete contract first:

```sh
flab capabilities --json
flab probe --pid 1234 --session --json
```

Then send one JSON object per line. The `ready` envelope already includes every
live descriptor and resolved device identity, so an agent can see all allowed
actions and verify where the PID lives before calling one:

```json
{"id":"1","op":"action","mode":"analysis","action":"modules","args":["unity"]}
{"id":"2","op":"action","mode":"instrument","action":"instrumentStart","args":["trace","0x1234","{\"label\":\"damage\",\"args\":2}"]}
{"id":"3","op":"action","mode":"analysis","action":"instrumentStatus","args":["ins-1"]}
{"id":"4","op":"close"}
```

Machine actions cross the same live-descriptor authorization, argument coercion,
bounded result, and verification path as the TUI. Run `bun run test:runtime` for
the opt-in native fixture test covering attach, analysis, trace/watch/freeze,
managed CRUD, cleanup, reattach, and the public NDJSON transport.

## Add a target

```sh
flab new <name> ["Process Name.exe"]
```

Scaffolds `agent/targets/<name>/index.ts` and registers it transactionally in
`frida-labs.json`. `flab target` provides update/rename/unregister/delete
operations with rollback-safe source handling. Unregister preserves sources;
delete requires `--confirm <exact-name>`. JSON target mutations use exact success
and failure objects so CLI consumers can match them by deep equality. Edit the
entry; every save hot-reloads.

## Layout

```
agent/
  lib/                  reusable engines: mem, hook, search, mono/, ue/, il2cpp,
                        detect, watch, instruments, strings, cocos, log
  targets/<game>/       per-game code — entry is index.ts
src/
  bin.ts                flab entry (CLI vs TUI dispatch)
  core/
    index.ts            public barrel — the programmatic interface
    manifest.ts         frida-labs.json target registry
    session.ts          compile / attach / inject / hot-reload / rpc engine
    actions.ts          action policy, coercion, bounded receipts/debug events
    machine.ts          strict persistent NDJSON protocol for AI agents
    devices.ts          local/USB/device-id/remote selection and identity
    processes.ts        live process discovery and target matching
    lifecycle.ts        Device spawn/child gating + crash signals
    commands.ts         CLI registry + exact target mutation contracts
    depcheck.ts         targets → agent/lib dependency-direction gate
    compile.ts          frida-compile wrapper (build + watch)
    projects.ts         transactional target lifecycle
    scaffold.ts         backward-compatible flab new adapter
    libref.ts           bounded agent/lib callable surface catalog
  cli/index.ts          argv → registry frontend
  tui/index.tsx         five-mode ink frontend over core services
```

`src/core/index.ts` is the single programmatic interface: frontends import
the barrel, never individual core modules.

## Conventions

- `rpc.exports` is the entire control surface; return JSON-serializable
  values only (pointers as strings). Call them by bare name in the REPL/TUI.
  Targets also expose `__describe()` returning the rpc surface (`name`, typed
  `args`, `doc`, `capabilities`, `effect`, `returns`) for tooling introspection.
  Add human-facing `label` and `category` fields to turn the descriptor list
  into a readable game-specific mod menu without changing stable RPC names.
  `GameSession.describe()` fails closed when that live descriptor is missing,
  malformed, or throws; cached/export-name authorization is never substituted.
- Log through `lib/log.ts` (`ok`/`warn`/`err`) — never bare `console.log`
  (module load order is not deterministic across targets).
- Reusable code belongs in `agent/lib/`; targets hold only game-specific
  glue. `flab depcheck` fails the build when a target imports anything that
  does not resolve under `agent/lib`.
- No TODO stubs, dead code, or commented-out experiments in merged targets.

## Agent integration

For complete target creation, use the
[build-game-mod workflow](docs/agent-game-mod-guide.md). Start with
`flab devices --json`, then `flab processes --device <selector> --json`.
Use `flab probe <process>` or
`flab probe --pid <positive-pid>` for one-shot discovery, then create and validate
a reusable target. CLI and TUI integrations go through `src/core/index.ts`,
`CommandRegistry`, and `SessionEngine`; frontends never import Frida or agent code
directly. Device selectors are carried through discovery, attach/spawn,
reconnect, lifecycle events, TUI status, and the machine `ready` envelope.
