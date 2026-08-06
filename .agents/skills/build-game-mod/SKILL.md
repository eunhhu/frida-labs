---
name: build-game-mod
description: Analyze an authorized offline or single-player game on a local, USB/mobile, exact Frida device, or remote endpoint; map objectives/win-loss, economy/rewards, gameplay, and accessibility/training surfaces; then build and live-verify a game-specific frida-labs target whose descriptors drive a visible TUI mod menu, REPL, and persistent AI action session. Use when asked to add a game, create mods/trainers/QoL or new runtime content, map game systems, attach or spawn a target, or finish a target through cleanup and reattach evidence. Do not use for online cheating, anti-cheat bypass, or processes the user is not authorized to test.
---

# Build Game Mod

Read `docs/agent-game-mod-guide.md` in full before taking action. Treat its
phases, evidence requirements, device invariant, deliverables, and definition
of done as the execution contract.

## Execute

1. Confirm the request targets an authorized offline, single-player, or test
   instance. Decline online cheating or anti-cheat bypass.
2. Parse `GAME`, `PROCESS`, `DEVICE`, `MODE`, and `FEATURES` from the request.
   Discover missing process/device facts with `flab devices --json` and
   `flab processes ... --json`; ask only when authorization or identity remains
   ambiguous.
3. Run preflight and a persistent generic-probe recon on the exact selected
   device before scaffolding. Build an evidence-backed semantic model covering
   objectives/win-loss transitions, rewards, local economy sources/sinks,
   progression, combat, entities, save persistence, and available aim assist,
   ESP/awareness, movement trainer, accessibility, and training surfaces.
4. Create or update one target. Reuse `agent/lib/`; keep game-specific glue in
   `agent/targets/<slug>/index.ts`.
5. Expose a truthful live `__describe()` inventory. Include human `label` and
   `category` metadata so the TUI is a readable mod menu, while stable RPC names
   remain callable from the REPL and NDJSON session.
6. Provide real `modInfo`, `modHelp`, `modState`, domain actions, and cleanup.
   Synthesize game-specific completion, economy, reward, combat, aim assist,
   ESP/awareness, and movement-training features only from discovered paths.
   Make every mutation bounded, reversible where possible, idempotent, and off
   by default. Continuous assistance requires a discovered engagement gate and
   explicit offline confirmation. Do not add auto-fire or claim content creation
   without a discovered creation path.
7. Run static gates, then exercise the live REPL, TUI, and persistent machine
   session. Test each shipped action, cleanup, close, and one clean reattach.
8. Write `agent/targets/<slug>/README.md`,
   `artifacts/<slug>/semantic-model.json`, and bounded experiment/verification
   receipts under `artifacts/<slug>/`.

Do not report completion from compile-only evidence. If live access is missing,
state `LIVE VERIFICATION BLOCKED` and name the exact missing device, process,
scene, permission, or user action.
