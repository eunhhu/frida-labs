# frida-labs

A cross-game **Frida** workspace: a reusable library, per-game target scripts,
and a single Bun runtime built on the Frida core TS backend (`frida` npm) that
compiles, injects, hot-reloads, and gives you an RPC REPL — all in one process.

## Layout

```
agent/
  lib/                     ── generic, cross-game utilities ──
    mem.ts                 guarded reads/writes, hexdump, AOB/string scan
    search.ts              modules / exports / imports / symbols
    hook.ts                trace(), stub(), detachAll()
    il2cpp.ts              Unity/IL2CPP helpers (opt-in import)
    mono/                  generic Mono runtime toolkit (any Mono Unity game)
    log.ts                 log() mirrored to the host via send()
    ue/                    generic Unreal Engine 5 toolkit (any UE game)
      reflection.ts          GObjects/GNames discovery, name/class/prop
      actor.ts               world location, camera, world->screen
      render.ts              ProcessEvent + AHUD/Canvas drawing (ESP)
      movement.ts            UCharacterMovementComponent trainer
  targets/                 ── one folder per game ──
    mecchachameleon/       UE5: ESP + trainer  (index.ts sets rpc.exports)
    piu/                   Unity rhythm game: judgment correction
    _scratch/              archived experiments
host/
  client.ts                the single runtime (compile + inject + hot-reload + REPL)
  config.ts                the target registry (process · mode · entry)
```

**Rule:** reusable code lives in `lib/`; a game only adds its class names and
glue under `targets/<game>/`. The UE reflection, ESP rendering and movement
trainer are all generic.

## Setup

```bash
bun install
```

Needs a Frida install matching the `frida` npm version (`frida --version`).

## Run (one command)

```bash
bun run start                    # default target (attach)
bun run start mecchachameleon    # explicit target
bun run start piu --spawn        # spawn the process instead of attaching
```

`start` compiles the target's agent, attaches (or spawns) via the Frida core TS
backend, injects, then **watch-recompiles + hot-reloads** on every source edit —
no restart, no second terminal. It drops you into a REPL where the target's
`rpc.exports` are callable by bare name:

```
mecchachameleon> await info()
mecchachameleon> await classes("/Script/PenguinHotel")
mecchachameleon> await espInstall()
mecchachameleon> espTest(true)
mecchachameleon> await moveApply({ walk: 1200, jump: 900, gravity: 0.5 })
mecchachameleon> await moveEnforce(true)
mecchachameleon> await espRemove()
mecchachameleon> .exit
```

Build the bundle without injecting:

```bash
bun run build            # -> _agent.js (default target)
bun run build piu        # a specific target
```

Type-check everything:

```bash
bun run typecheck
```

## Add a target

1. `agent/targets/<game>/index.ts` — import from `../../lib`, set `rpc.exports`.
2. Add one entry to `host/config.ts` (`process`, `mode`, `entry`).

That's it — `bun run start <game>` now works. No per-target scripts to add.
