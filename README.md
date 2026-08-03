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

## Drive a game

```sh
flab run <target>                 # compile + attach + REPL (hot reload on save)
flab run <target> --spawn         # spawn instead of attach
flab tui                          # ink TUI: pick target, drive rpc.exports
flab tui <target>                 # TUI, skip the picker
flab build <target>               # compile only
flab targets                      # list registered targets
flab depcheck                     # enforce targets → agent/lib dependency direction
flab doctor                       # environment sanity (runtime, frida server, processes)
bun run typecheck                 # agent + host typecheck
```

`flab` is `bun run flab` (bin: `src/bin.ts`) or the compiled binary from
`bun run build-bin`. Every command takes `--json` for agent consumption.

Targets are registered in `frida-labs.json` — the file is the list. The
manifest stores the Windows process name (`Game.exe`); on macOS/Linux the
session layer automatically also matches the extension-less name.

## Recon a new game before writing a target

```sh
flab probe "Some Game.exe"
```

`_probe` injects an engine-agnostic agent into any process: it detects
Unity (IL2CPP / Mono), Unreal, Cocos2d-x, FNA, and exposes the matching
exploration surface (module/export browsing, memory scan/peek/poke/freeze/
watch, string search, tracing, plus Mono class/method introspection when a
Unity Mono runtime is present — FNA/Mono consolidation lands in Phase B).
toolkit a real target should import.

## Add a target

```sh
flab new <name> ["Process Name.exe"]
```

Scaffolds `agent/targets/<name>/index.ts` and registers it in
`frida-labs.json`. That's the whole contract — no docs to update, nothing
else to touch. Edit the entry; every save hot-reloads into the live game.

## Layout

```
agent/
  lib/                  reusable engines: mem, hook, search, mono/, ue/, il2cpp,
                        detect, watch, strings, cocos, log
  targets/<game>/       per-game code — entry is index.ts
src/
  bin.ts                flab entry (CLI vs TUI dispatch)
  core/
    index.ts            public barrel — the programmatic interface
    manifest.ts         frida-labs.json target registry
    session.ts          compile / attach / inject / hot-reload / rpc engine
    lifecycle.ts        Device spawn/child gating + crash signals
    commands.ts         command registry (CLI and TUI both render from it)
    depcheck.ts         targets → agent/lib dependency-direction gate
    compile.ts          frida-compile wrapper (build + watch)
    scaffold.ts         target scaffolder (flab new)
    libref.ts           agent/lib API surface extraction (flab lib)
  cli/index.ts          argv → registry frontend
  tui/index.tsx         ink TUI frontend
```

`src/core/index.ts` is the single programmatic interface: frontends import
the barrel, never individual core modules.

## Conventions

- `rpc.exports` is the entire control surface; return JSON-serializable
  values only (pointers as strings). Call them by bare name in the REPL/TUI.
  The convention (rolling out in Phase B) is for targets to also expose
  `__describe()` returning the rpc surface (names, or `{name, args, doc}`
  descriptors) for tooling introspection; `GameSession.describe()` falls
  back to export names seen so far until then.
- Log through `lib/log.ts` (`ok`/`warn`/`err`) — never bare `console.log`
  (module load order is not deterministic across targets).
- Reusable code belongs in `agent/lib/`; targets hold only game-specific
  glue. `flab depcheck` fails the build when a target imports anything that
  does not resolve under `agent/lib`.
- No TODO stubs, dead code, or commented-out experiments in merged targets.

## Agent integration

`CLAUDE.md` carries the machine-readable conventions; `.gjc/skills/`
provides `new-frida-target` and `frida-debug` workflow skills for gjc
(project skill discovery must be enabled: `gjc config set skills.enablePiProject true`).
