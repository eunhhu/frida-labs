# frida-labs

Cross-game Frida workspace. Bun runtime only — no make, no shell scripts;
everything below works the same on Windows and Unix.

## Commands

```sh
bun install
flab run <target> [--spawn]      # compile + attach + human Instrument dashboard
flab run <target> --console      # opt-in advanced console (.help or /help)
flab tui [target]                # three-mode Connect/Analyze/Instrument TUI
flab processes                   # discover processes and target matches
flab devices                     # enumerate local/USB/remote Frida devices
flab processes --device usb      # discover on first USB/mobile device
flab run <target> --device <id>  # exact visible device id
flab run <target> --host H:27042 # explicit remote endpoint
flab probe "Some Game.exe"       # one-shot engine-agnostic recon
flab probe --pid 1234            # explicit numeric attach; positional digits stay names
flab capabilities --json         # discover persistent AI-agent protocol
flab acp detect --json           # discover installed ACP upstream agents
flab acp [--upstream <id|json>]  # ACP v1 gateway + automatic flab MCP injection
flab mcp                         # direct stdio MCP server for any MCP harness
flab agent --json                # global author/link/build/verify/package API
flab probe --pid 1234 --session --json # persistent typed NDJSON session
flab new <name> ["Proc.exe"]     # scaffold + register a target
flab target <operation> ...      # set/rename/unregister/delete
flab build <target>              # compile only
flab package <target>            # checksummed distributable Instrument artifact
flab depcheck                    # targets → agent/lib dependency gate
flab doctor                      # environment sanity (runtime, frida server, processes)
bun run typecheck
```

`flab` = `bun run flab` (bin: `src/bin.ts`). All commands support `--json`
for machine consumption.

The TUI keeps one Workbench/Store across exactly three modes: Connect, Analyze,
and Instrument. Every visible selectable list or form is capped at three rows.
Analyze contains read-only Actions, Explorer, and Record surfaces; Instrument
contains descriptor-driven Controls, an advanced Console, and Events. Controls
render inputs, checkboxes, sliders, selects, and linked live state from the same
schema used by agents. Mode and surface switches never reattach. Record
offers exactly Plan, Record, and Stop + summarize, then persists bounded
evidence under `artifacts/records/`. Generic probe, every saved target, and the
target scaffold expose the shared `agent/lib/recording.ts` RPC/descriptors.
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
  `tui/index.tsx` (ink), `core/control.ts` (vendor-neutral Agent API),
  `core/acp.ts` (ACP gateway), and `core/mcp.ts` (MCP tools) use the
  same SessionEngine, ActionService, ProjectService, Instrument source,
  module-link, Record, and package boundaries. Put shared behavior in core, not
  in a frontend. `core/records.ts` owns persisted, bounded human-play traces.
- **agent/** (frida-gum): runs inside the game. `lib/` is the reusable
  toolkit (mem, hook, search, mono, ue, il2cpp, assist, detect, watch, strings,
  cocos); `targets/<name>/` is per-game glue.

Data crosses the boundary as JSON only. Targets use `defineInstrument()` plus
`read`/`write`/`control`/`hook` and `field.*` helpers so one declaration generates
both callable `rpc.exports` and typed `__describe()` metadata; return pointers as
strings. Never hand-maintain parallel handler and descriptor inventories.
`GameSession.describe()` fails closed
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
- New game-specific surfaces use `defineInstrument()` and `field.*` with concise
  `label`, `category`, and UI metadata. Instrument renders input/checkbox/slider/
  select controls plus linked state while stable RPC names stay shared by the
  console and NDJSON callers. flab generates `rpc.exports`, `__describe()`, and
  `.help`/`/help`; targets do not implement parallel exports, descriptor arrays,
  or `modHelp()`.
- TUI modules import the `src/core/index.ts` barrel only. They never import
  `frida`, `agent/lib`, or target modules directly; authorization and launch
  validation remain core responsibilities.
- Verify with `bun run typecheck`, `flab build <target>`, and
  `flab depcheck` before reporting done; for behavioral claims, attach to
  the real game.

## Agent workflows

For new games, Instruments, QoL/content work, or end-to-end attach/spawn
analysis, read `docs/agent-game-mod-guide.md` and invoke the `build-game-mod`
project skill. It requires evidence-based subsystem coverage, a descriptor-led
TUI Instrument, the same advanced-console/NDJSON action surface, cleanup, and a clean reattach.
The completion contract includes objective/win-loss and economy/reward semantic
mapping plus applicable default-off aim assist, ESP/awareness, reversible
movement, accessibility, and training features for authorized owned-offline or
fully isolated private-lab testing.
Target-specific user instructions belong in `agent/targets/<name>/README.md`;
do not add individual-game details to root README/CLAUDE files.

Harness entry points:

- GJC: `.gjc/skills/build-game-mod`; `.gjc/config.yml` enables project scan;
  `.mcp.json` exposes flab in standalone `--mcp-config` mode; invoke
  `/skill:build-game-mod ...`.
- Codex: `.agents/skills/build-game-mod`; `.codex/config.toml` exposes flab MCP;
  invoke `$build-game-mod ...`.
- Claude Code: `.claude/skills/build-game-mod`; invoke `/build-game-mod ...`.
- OpenCode: shared `.agents` skill plus `/game-mod ...` from
  `.opencode/commands/game-mod.md`.

The narrower `.gjc/skills/new-frida-target` and `.gjc/skills/frida-debug`
remain useful for scaffold-only or debug-only work.

The public automation boundary is `src/core/index.ts`: CLI uses
`CommandRegistry`; TUI and `flab.control.v1` use the same `SessionEngine`,
`ProjectService`, `ActionService`, Instrument source, module-link, and package
services. Neither frontend imports Frida or target modules directly.
Target mutation JSON has exact operation-specific success/failure shapes. Probe
supports one-shot evaluation and `--session --json`; the latter is strict
`flab.ndjson.v1` and uses the same ActionService authorization as the TUI.
ACP-capable clients prefer `flab acp`, which auto-detects or selects an upstream
ACP agent and injects `flab mcp` into each ACP session. MCP-native harnesses use
`flab mcp`; `flab agent --json` remains the direct compatibility transport.
All authorize with a concrete owned-offline/private-lab profile, then perform
connect, Record-assisted analysis, source/link, build, live verification,
cleanup, and packaging without TUI scraping. See
`docs/agent-control-api.md`. “Educational” wording alone is not authorization;
public play, production economies, third-party accounts, and anti-cheat bypass
remain outside the workflow.
