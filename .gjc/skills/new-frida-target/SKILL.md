---
name: new-frida-target
description: Scaffold and register a minimal frida-labs target, then prove it compiles. Use only when the user explicitly asks for scaffold-only target lifecycle work. For end-to-end game analysis, mods, QoL, content, a TUI mod menu, REPL, or live verification, use build-game-mod instead.
when_to_use: The user explicitly wants only a minimal target scaffold or manifest registration, without full live game-mod delivery.
---

# New frida-labs target

If the request includes game analysis, playable mods, QoL/content features, a
mod menu/REPL, or live attach verification, load `build-game-mod` and follow
`docs/agent-game-mod-guide.md` instead of this narrower scaffold workflow.

You are adding a new game target to the frida-labs workspace. The repo layout
and conventions are documented in `frida-labs/CLAUDE.md` — read it first if
you have not already.

## Procedure

1. **Gather facts.** Ask only for what you cannot infer:
   - target name (lowercase, `[a-z0-9_-]`) — usually the game short name
   - process name for attach, or full executable path for spawn
   - engine/runtime: Unreal (UE reflection), Unity IL2CPP, Unity Mono, or
     other/native — this decides which `agent/lib/` modules to import
2. **Scaffold.** Run:
   ```sh
   cd frida-labs && flab new <name> "<Process Name.exe>"
   ```
   This transactionally creates `agent/targets/<name>/index.ts` and registers
   it. The TUI Project mode uses the same service. Use `flab target set <name>
   ...` for config changes, `target rename`, or `target unregister` when sources
   must remain. `target delete <name> --confirm <name>` is the distinct
   destructive operation. Never edit source and manifest as separate lifecycle
   operations.
3. **Declare the Instrument once.** Use `defineInstrument()` with
   `read`/`write`/`control`/`hook` and `field.*`; it generates both
   `rpc.exports` and `__describe()`. Never hand-maintain parallel handler and
   descriptor inventories. Keep the target file game-specific. Reuse
   `agent/lib/` modules:
   - UE game → `import { ok, ue } from "../../lib/index.js"` (the barrel and
     UE accessors are side-effect-free/lazy)
   - Unity IL2CPP → `../../lib/il2cpp.js` (it wraps `frida-il2cpp-bridge`;
     new targets never import the bridge package directly — `flab depcheck`
     rejects it; depcheck has zero exceptions)
   - Unity Mono → `../../lib/mono/index.js`
   - native / other → `../../lib/mem.js`, `../../lib/hook.js`,
     `../../lib/search.js` plus `../../lib/log.js`
   If the runtime bridge you need does not exist yet, add it under
   `agent/lib/<engine>/` and keep it game-agnostic.
   Every declared action must include truthful capabilities, effect, returns,
   label/category, and `field.*` controls. Generated `__describe()` is the live
   callable inventory; host authorization fails closed when malformed. Grant
   `analysis` only to genuinely read-only actions; hooks, writes, and controls
   remain Instrument/Debug-only.
4. **Verify.** `bun run typecheck`, `flab build <name>`, and `flab depcheck`
   must all pass.
   Do not claim the target works until the bundle compiles. Actual attach
   verification requires the game running — say so explicitly if you could
   not test it live.
   Probe an unregistered process by name or with
   `flab probe --pid <positive-pid>`; positional digits are names unless `--pid`
   is selected. In the TUI, confirm the target appears in Project mode, that
   Instrument loads its live descriptor palette, and that a target launch
   presents independent spawn- and child-gating controls.
5. **Document.** The target file's header comment names the game, engine,
   and platform. Do NOT touch repo-level docs (README/CLAUDE.md) — targets
   must not require doc updates.

## Rules

- `rpc.exports` returns JSON-serializable values only (no NativePointer,
  no closures).
- Use `lib/log.ts` (`ok` / `warn` / `err`), never bare `console.log`.
- No TODO stubs, dead code, or commented-out experiments in the merged file.
- If a hook would crash the process (Mono JIT under Rosetta, anti-cheat
  integrity checks), fall back to a `setInterval` poll and document the
  reason in the file header.
