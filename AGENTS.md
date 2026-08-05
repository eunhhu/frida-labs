# frida-labs agent instructions

- Read `CLAUDE.md` before changing code; it is the compact architecture and
  verification reference shared by this repository.
- For a new game, game analysis, mod/trainer/QoL/content request, or live
  attach/spawn task, use the `build-game-mod` project skill and read
  `docs/agent-game-mod-guide.md` completely.
- Treat the selected Frida device as invariant across process discovery,
  attach/spawn, reconnect, and verification. Never reuse a PID across devices.
- Keep reusable runtime code in `agent/lib/` and game glue in
  `agent/targets/<game>/`. Frontends use `src/core/index.ts` only.
- Require truthful live descriptors, bounded JSON results, owned cleanup, and
  runtime receipts. Compilation is not proof of attach or behavior.
- Work only on authorized offline/single-player/test instances. Do not bypass
  anti-cheat, interfere with online play, or access another user's process.
