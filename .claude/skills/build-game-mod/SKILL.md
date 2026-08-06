---
name: build-game-mod
description: Analyze an authorized offline or single-player game on a local, USB/mobile, exact Frida device, or remote endpoint; map objectives/win-loss, economy/rewards, gameplay, and accessibility/training surfaces; then build and live-verify a game-specific frida-labs target whose descriptors drive a visible TUI mod menu, REPL, and persistent AI action session. Use when asked to add a game, create mods/trainers/QoL or new runtime content, map game systems, attach or spawn a target, or finish a target through cleanup and reattach evidence. Do not use for online cheating, anti-cheat bypass, or unauthorized processes.
---

# Build Game Mod

Read `docs/agent-game-mod-guide.md` in full and execute every applicable phase.

Resolve `GAME`, `PROCESS`, `DEVICE`, `MODE`, and `FEATURES`; discover missing
facts on the exact device. Recon with the persistent generic probe before
scaffolding. Implement one target whose truthful `__describe()` descriptors,
including human `label` and `category`, drive the TUI menu, REPL, and NDJSON
surface. Provide discovery/help/state/cleanup actions, evidence-based subsystem
coverage, an objectives/win-loss and economy/reward semantic model, and
game-specific aim assist, ESP/awareness, movement trainer, accessibility, and
training candidates. Ship only discovered, bounded, default-off features;
continuous assists require an engagement gate and explicit offline confirmation.
Run static gates, real live action tests, cleanup, reattach, target-local usage,
and receipts. Never add auto-fire.

Do not stop at scaffolding or compile-only checks. If live access is missing,
state `LIVE VERIFICATION BLOCKED` with the exact blocker. Do not assist online
cheating, anti-cheat bypass, or unauthorized process access.
