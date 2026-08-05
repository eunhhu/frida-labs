---
name: frida-debug
description: Run, attach, and diagnose an existing frida-labs target through compile, REPL, TUI, and runtime failures. Use for a focused debug request. For building a complete game-specific mod, QoL/content surface, mod menu, and coverage report, use build-game-mod instead.
when_to_use: The user wants to run an existing target, attach to a game, figure out why an agent will not inject, why rpc calls fail, or why a hook crashes the target process.
---

# frida-labs debug workflow

Use this to run an existing target and diagnose failures. Repo conventions
are in `frida-labs/CLAUDE.md`.

## Standard run

```sh
cd frida-labs
flab run <target>                # attach
flab run <target> --spawn        # spawn
flab tui <target>                # ink TUI instead of the REPL
flab probe --pid <positive-pid>   # attach unambiguously by PID
```

The host compiles the agent, attaches, and drops you into a REPL where the
target's `rpc.exports` are callable by bare name. Saving any file under
`agent/` recompiles and hot-reloads in place.

In the TUI, `Ctrl+P` selects Project, Instrument, Debug, Probe, or Analysis
without recreating the active session. Instrument retains the Actions, REPL,
Explorer, and Observe surfaces. Use Debug for crash/exception/hook-verification
evidence; Probe for disjoint name/PID/spawn requests and explicit target
spawn/child gating; Analysis only for current live actions described as
`analysis` + `read`. Use `j`/`k` for retained rows and `PageUp`/`PageDown` to
request the next bounded page.

## Diagnosis ladder

Work top-down; stop at the first rung that fails.

1. **Compiles?** `flab build <target>` — a frida-compile error here is a
   TypeScript / bundling problem, not a Frida problem. Shared barrel and UE
   accessors are lazy/import-safe; prefer direct modules only for bundle size.
2. **Typechecks?** `bun run typecheck`.
3. **Frida reachable?** `frida --version` must match the `frida` npm version
   in `package.json`. A mismatch causes cryptic attach errors.
4. **Process found?** Run `flab processes` first. The session layer already
   matches a configured `Game.exe` against a running extension-less `Game`
   on macOS/Linux. For launchers or duplicate names, use the reported PID:
   `flab probe --pid <pid>`. Plain positional digits remain process names; PID
   mode must be selected explicitly.
5. **Agent loads but rpc fails?** Inspect the live `__describe()` surface. A
   missing, malformed, or throwing descriptor is an authorization failure, not
   a reason to fall back to cached exports. Check the host console for the
   agent's `ok(...)` / `err(...)` lines; a thrown `rpc.exports` exception returns
   to the REPL as an error.
6. **Target process crashes on inject?** `Interceptor.attach` on JITted
   managed code (Mono under Rosetta, some IL2CPP) can crash the process.
   Move the logic to a `setInterval` poll loop over raw memory instead and
   document the constraint in the target file header.
7. **Need lifecycle context?** Use TUI Debug mode. It distinguishes process
   crash, agent exception, detach, spawn, child, and hook receipt events and
   shows receipt/debug drop counters. Do not relabel a detach as a crash.

## Verifying a change

- Minimum: `bun run typecheck` + `flab build <target>` + `flab depcheck` pass.
- Real verification: the game is running, the agent attaches, and the
  relevant `rpc.exports` calls return sane values in the REPL. If you could
  not run the game, say exactly that — do not claim live verification.
- Exercise the corresponding TUI mode when the change affects Project,
  Instrument, Debug, Probe, or Analysis behavior; mode switches must not detach.
