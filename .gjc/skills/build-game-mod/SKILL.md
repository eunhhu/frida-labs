---
name: build-game-mod
description: Analyze an authorized owned-offline game or fully owned, consenting, isolated private lab; then build, live-verify, and package a game-specific frida-labs Instrument whose descriptors drive the human TUI and vendor-neutral ACP/MCP Agent API. Use for new games, Instruments, QoL/content, attach/spawn analysis, and cleanup/reattach verification. Never use for public play, anti-cheat bypass, or unauthorized processes.
---

# Build Game Mod

Read `docs/agent-game-mod-guide.md` completely and follow it as the completion
gate. Resolve the request's game, process, device, attach/spawn mode, and feature
priorities. Recon the exact selected device before scaffolding. When a human can
perform one isolated action, use bounded `record.plan/start/status/stop/summary/read`
evidence. Build one target
whose live descriptors, human labels, categories, and argument UI metadata form
input, checkbox, slider, and select controls in the TUI and the same advanced console/NDJSON
Agent surface. flab generates help from descriptors; do not implement a
target-local `modHelp()` export. Produce subsystem coverage, safe reversible
actions, an objectives/win-loss and economy/reward semantic model, and discovered
aim assist, ESP/awareness, movement assistance, accessibility, and training features.
Continuous assists stay off by default, require a live engagement gate and
explicit offline confirmation, and never include auto-fire. Produce cleanup,
real runtime receipts, a clean reattach, a checksummed package, and target-local
usage. Prefer `flab acp` or `flab mcp`; direct `flab agent --json` remains
compatible. Use their shared `flab.control.v1` for Record, source, module-link,
build, live, and package work.

Do not claim success from compilation alone. Emit `LIVE VERIFICATION BLOCKED`
with the exact blocker when the game or device cannot be exercised.
