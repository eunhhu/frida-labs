---
description: Build and live-verify a game-specific Frida mod menu and REPL
agent: build
---

Load the `build-game-mod` project skill from `.agents/skills/build-game-mod`.
Read `docs/agent-game-mod-guide.md` in full and follow its completion contract.

User request: $ARGUMENTS

Do not stop after recon, planning, or scaffolding. Implement and verify the TUI
menu, REPL, persistent AI action surface, cleanup/reattach path, coverage report,
and target-local usage. Work only against an authorized offline/single-player
instance; do not bypass anti-cheat or affect online play.
