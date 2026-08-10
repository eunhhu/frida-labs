---
name: build-game-mod
description: Analyze an authorized owned-offline game or fully owned, consenting, isolated private lab on a local, USB/mobile, exact Frida device, or remote endpoint; map objectives/win-loss, economy/rewards, gameplay, and accessibility/training surfaces; then build, live-verify, and package a game-specific frida-labs Instrument whose descriptors drive the human TUI and vendor-neutral ACP/MCP Agent API. Use when asked to add a game, create Instruments/QoL or new runtime content, map game systems, attach or spawn, or finish cleanup and reattach evidence. Do not use for public play, anti-cheat bypass, or processes the user is not authorized to test.
---

# Build Game Mod

Read `docs/agent-game-mod-guide.md` in full before taking action. Treat its
phases, evidence requirements, device invariant, deliverables, and definition
of done as the execution contract.

## Execute

1. Confirm an owned-offline instance or fully owned, consenting, isolated
   private lab. Anti-cheat must be absent or officially disabled; decline public
   play, production economies, third-party accounts, and anti-cheat bypass.
2. Parse `GAME`, `PROCESS`, `DEVICE`, `MODE`, and `FEATURES` from the request.
   Discover missing process/device facts with `flab devices --json` and
   `flab processes ... --json`; ask only when authorization or identity remains
   ambiguous.
3. Run preflight and a persistent generic-probe recon on the exact selected
   device before scaffolding. When a human can perform one isolated gameplay
   action, use bounded `record.plan/start/status/stop/summary/read` evidence
   instead of guessing from names or screen state. Build a semantic model covering
   objectives/win-loss transitions, rewards, local economy sources/sinks,
   progression, combat, entities, save persistence, and available aim assist,
   ESP/awareness, movement assistance, accessibility, and training surfaces.
4. Create or update one target. Reuse `agent/lib/`; keep game-specific glue in
   `agent/targets/<slug>/index.ts`.
5. Use `defineInstrument()` plus `read`/`write`/`control`/`hook` and `field.*`
   helpers. Declare each action once; flab generates `rpc.exports`, truthful live
   `__describe()`, human input/checkbox/slider/select controls, console help, and
   NDJSON actions. Never hand-maintain parallel handlers and descriptor arrays.
6. Provide real `modInfo`, `modState`, domain actions, and cleanup. Human help
   is generated from descriptors; do not add a target-local `modHelp()` export.
   Synthesize game-specific completion, economy, reward, combat, aim assist,
   ESP/awareness, and movement-training features only from discovered paths.
   Make every mutation bounded, reversible where possible, idempotent, and off
   by default. Continuous assistance requires a discovered engagement gate and
   explicit offline confirmation. Do not add auto-fire or claim content creation
   without a discovered creation path.
7. Prefer `flab acp` for ACP clients or `flab mcp` for MCP harnesses; direct
   `flab agent --json` remains compatible. Use their shared `flab.control.v1`
   boundary for Record, source read/write, module linking, build, live actions,
   cleanup, and packaging. Exercise default `flab run <slug>` dashboard,
   opt-in advanced console (`--console`), and one reattach.
8. Write `agent/targets/<slug>/README.md`,
   `artifacts/<slug>/semantic-model.json`, and bounded experiment/verification
   receipts under `artifacts/<slug>/`.

Do not report completion from compile-only evidence. If live access is missing,
state `LIVE VERIFICATION BLOCKED` and name the exact missing device, process,
scene, permission, or user action.
