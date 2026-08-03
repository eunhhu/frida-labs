# frida-labs

Cross-game Frida workspace. Bun runtime only — no make, no shell scripts;
everything below works the same on Windows and Unix.

## Commands

```sh
bun install
flab run <target> [--spawn]      # compile + attach + REPL (hot reload)
flab tui [target]                # ink TUI frontend
flab probe "Some Game.exe"       # engine-agnostic recon of ANY process (--spawn to spawn)
flab new <name> ["Proc.exe"]     # scaffold + register a target
flab build <target>              # compile only
flab depcheck                    # targets → agent/lib dependency gate
flab doctor                      # environment sanity (runtime, frida server, processes)
bun run typecheck
```

`flab` = `bun run flab` (bin: `src/bin.ts`). All commands support `--json`
for machine consumption.

## Architecture

Two processes, one boundary:

- **src/** (Bun host): `core/session.ts` compiles
  `agent/targets/<name>/index.ts` with frida-compile, attaches/spawns via
  the `frida` npm package, injects, and hot-reloads on save.
  `core/index.ts` is the public barrel — the programmatic interface.
  `cli/index.ts` (argv) and `tui/index.tsx` (ink) are thin frontends over
  the barrel and the `core/commands.ts` registry — put shared behavior in
  core, not in a frontend.
- **agent/** (frida-gum): runs inside the game. `lib/` is the reusable
  toolkit (mem, hook, search, mono, ue, il2cpp, detect, watch, strings,
  cocos); `targets/<name>/` is per-game glue.

Data crosses the boundary as JSON only. `rpc.exports` functions are
callable from the host by bare name; return pointers as strings. The
convention (rolling out to targets in Phase B) is for targets to also expose
`__describe()` (rpc names, or `{name, args, doc}` descriptors) so
`GameSession.describe()` can introspect the surface; without it, describe()
falls back to export names seen so far. Agent log lines
flow host-side via `lib/log.ts` (`ok`/`warn`/`err`) — never bare
`console.log`.

## Adding a target

`flab new <name>` is the entire contract: it scaffolds the entry and
registers it in `frida-labs.json`. No other file (including this one)
needs to change when a target is added — keep it that way. Do not
document individual games in repo-level docs.

## Conventions

- `frida-labs.json` stores the Windows process name; `session.ts` also
  matches the extension-less name on macOS/Linux automatically.
- Targets import only from `agent/lib/` — `flab depcheck` enforces it.
- Every `agent/lib/` module must be import-safe: no work at import time.
  The one documented exception is the UE reflection module's eager
  discovery, so non-UE targets must NOT import `../../lib/index.js`
  eagerly — import specific lib modules (`lib/mem.js`,
  `lib/mono/index.js`, …) instead.
- A runtime bridge for an engine `lib/` doesn't cover yet belongs in
  `agent/lib/<engine>/` from the start — target-local helper modules are
  rejected by `flab depcheck`.
- No TODO stubs, dead code, or commented-out experiments in merged targets.
- Verify with `bun run typecheck`, `flab build <target>`, and
  `flab depcheck` before reporting done; for behavioral claims, attach to
  the real game.

## Skills

`.gjc/skills/new-frida-target` and `.gjc/skills/frida-debug` encode the
workflows for agents. Project skill discovery requires
`gjc config set skills.enablePiProject true`.
