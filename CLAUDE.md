# frida-labs

Cross-game Frida workspace. Bun runtime only — no make, no shell scripts;
everything below works the same on Windows and Unix.

## Commands

```sh
bun install
flab run <target> [--spawn]      # compile + attach + REPL (hot reload)
flab tui [target]                # five-mode Project/Instrument/Debug/Probe/Analysis TUI
flab processes                   # discover processes and target matches
flab devices                     # enumerate local/USB/remote Frida devices
flab processes --device usb      # discover on first USB/mobile device
flab run <target> --device <id>  # exact visible device id
flab run <target> --host H:27042 # explicit remote endpoint
flab probe "Some Game.exe"       # one-shot engine-agnostic recon
flab probe --pid 1234            # explicit numeric attach; positional digits stay names
flab capabilities --json         # discover persistent AI-agent protocol
flab probe --pid 1234 --session --json # persistent typed NDJSON session
flab new <name> ["Proc.exe"]     # scaffold + register a target
flab target <operation> ...      # set/rename/unregister/delete
flab build <target>              # compile only
flab depcheck                    # targets → agent/lib dependency gate
flab doctor                      # environment sanity (runtime, frida server, processes)
bun run typecheck
```

`flab` = `bun run flab` (bin: `src/bin.ts`). All commands support `--json`
for machine consumption.

The TUI starts in Project mode and keeps one Workbench/Store across Project,
Instrument, Debug, Probe, and Analysis. `Ctrl+P` opens the mode/action palette.
Instrument leads with managed create/list/status/update/stop/delete actions, then
retains Actions, REPL, Explorer, and Observe without reattaching. Debug centers
crash/exception/hook-verification evidence.
Probe accepts disjoint name, positive-PID, and spawn requests; target launches
present independent spawn- and child-gating controls. Analysis is authorized
only by the current live descriptor as `analysis` + `read`. `j`/`k` scroll the
retained rows; `PageUp`/`PageDown` re-run the action for agent-backed result pages.
Project delete requires exact typed confirmation in both the panel and
`ProjectService`.
The visible TUI device is authoritative for process discovery and launch; `v`
cycles available devices. `flab tui --host HOST[:PORT]` selects an explicit
endpoint. Sessions retain resolved device id/type/platform through reconnect.

## Architecture

Two processes, one boundary:

- **src/** (Bun host): `core/session.ts` compiles
  `agent/targets/<name>/index.ts` with frida-compile, attaches/spawns via
  the `frida` npm package, injects, and hot-reloads on save.
  `core/index.ts` is the public barrel — the programmatic interface.
  `cli/index.ts` (argv) uses the `core/commands.ts` registry;
  `tui/index.tsx` (ink) uses the same core SessionEngine, ActionService, and
  ProjectService boundaries. Put shared behavior in core, not in a frontend.
- **agent/** (frida-gum): runs inside the game. `lib/` is the reusable
  toolkit (mem, hook, search, mono, ue, il2cpp, detect, watch, strings,
  cocos); `targets/<name>/` is per-game glue.

Data crosses the boundary as JSON only. `rpc.exports` functions are callable
from the host by bare name; return pointers as strings. Targets expose
`__describe()` with typed action metadata. `GameSession.describe()` fails closed
when it is missing, malformed, or throws; cached exports never authorize an
action. Agent log lines flow host-side via `lib/log.ts` (`ok`/`warn`/`err`)—
never bare `console.log`.

## Adding a target

`flab new <name>` transactionally scaffolds and registers the entry.
`flab target` owns later set/rename/unregister/delete operations. Unregister
preserves source files; delete removes eligible conventional sources only with
`--confirm <exact-name>`. Do not mutate source plus manifest independently. Do
not document individual games in repo-level docs.

## Conventions

- `frida-labs.json` stores the Windows process name; `session.ts` also
  matches the extension-less name on macOS/Linux automatically.
  `flab probe --pid <positive-integer>` selects PID attach explicitly; a
  positional digit string is still resolved as a process name.
- A target may persist `device` as local/USB/exact-id/remote-endpoint. Runtime
  `--device` or `--host` overrides it. Never enumerate a PID on one device and
  attach it through another; `core/devices.ts` owns selection and identity.
- Targets import only from `agent/lib/` — `flab depcheck` enforces it.
- Every `agent/lib/` module and the `../../lib/index.js` barrel is import-safe:
  no process access at import time. Engine bridges remain lazy; direct module
  imports are preferred only to keep bundles small.
- A runtime bridge for an engine `lib/` doesn't cover yet belongs in
  `agent/lib/<engine>/` from the start — target-local helper modules are
  rejected by `flab depcheck`.
- No TODO stubs, dead code, or commented-out experiments in merged targets.
- New game-specific surfaces provide concise `label` and `category` descriptor
  metadata. Instrument renders these as the mod menu while stable RPC names stay
  shared by REPL and NDJSON callers.
- TUI modules import the `src/core/index.ts` barrel only. They never import
  `frida`, `agent/lib`, or target modules directly; authorization and launch
  validation remain core responsibilities.
- Verify with `bun run typecheck`, `flab build <target>`, and
  `flab depcheck` before reporting done; for behavioral claims, attach to
  the real game.

## Agent workflows

For new games, mods/trainers, QoL/content work, or end-to-end attach/spawn
analysis, read `docs/agent-game-mod-guide.md` and invoke the `build-game-mod`
project skill. It requires evidence-based subsystem coverage, a descriptor-led
TUI mod menu, the same REPL/NDJSON action surface, cleanup, and a clean reattach.
Target-specific user instructions belong in `agent/targets/<name>/README.md`;
do not add individual-game details to root README/CLAUDE files.

Harness entry points:

- GJC: `.gjc/skills/build-game-mod`; `.gjc/config.yml` enables project scan;
  invoke `/skill:build-game-mod ...`.
- Codex: `.agents/skills/build-game-mod`; invoke `$build-game-mod ...`.
- Claude Code: `.claude/skills/build-game-mod`; invoke `/build-game-mod ...`.
- OpenCode: shared `.agents` skill plus `/game-mod ...` from
  `.opencode/commands/game-mod.md`.

The narrower `.gjc/skills/new-frida-target` and `.gjc/skills/frida-debug`
remain useful for scaffold-only or debug-only work.

The public automation boundary is `src/core/index.ts`: CLI uses
`CommandRegistry`, TUI uses the same `SessionEngine`, `ProjectService`, and
`ActionService`, and neither frontend imports Frida or agent modules directly.
Target mutation JSON has exact operation-specific success/failure shapes. Probe
supports one-shot evaluation and `--session --json`; the latter is strict
`flab.ndjson.v1` and uses the same ActionService authorization as the TUI.
