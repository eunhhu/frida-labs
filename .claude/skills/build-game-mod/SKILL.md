---
name: build-game-mod
description: Analyze an authorized owned-offline game or fully owned, consenting, isolated private lab; then build, live-verify, and package a game-specific frida-labs Instrument whose descriptors drive the human TUI and vendor-neutral ACP/MCP Agent API. Use for new games, Instruments, QoL/content, mapping, attach/spawn, cleanup, and reattach evidence. Do not use for public play, anti-cheat bypass, or unauthorized processes.
---

# Build Game Mod

Read `docs/agent-game-mod-guide.md` in full and execute every applicable phase.

Resolve `GAME`, `PROCESS`, `DEVICE`, `MODE`, and `FEATURES`; discover missing
facts on the exact device. Recon with the persistent generic probe before
scaffolding; when a human can perform one isolated action, capture bounded
`record.plan/start/status/stop/summary/read` evidence. Implement one target whose truthful `__describe()` descriptors,
including human `label` and `category`, drive the TUI, REPL, and NDJSON Agent
API. Provide discovery/help/state/cleanup actions, evidence-based subsystem
coverage, an objectives/win-loss and economy/reward semantic model, and
game-specific aim assist, ESP/awareness, movement assistance, accessibility, and
training candidates. Ship only discovered, bounded, default-off features;
continuous assists require an engagement gate and explicit offline confirmation.
Run static gates, real live action tests, cleanup, reattach, target-local usage,
and receipts. Never add auto-fire.

Do not stop at scaffolding or compile-only checks. If live access is missing,
state `LIVE VERIFICATION BLOCKED` with the exact blocker. Prefer `flab acp` or
`flab mcp`; direct `flab agent --json` remains compatible. Use their shared
`flab.control.v1` for Record/source/link/build/live/package operations. Do not assist public play,
anti-cheat bypass, or unauthorized process access.
