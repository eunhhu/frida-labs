# PUMP IT UP RISE offline training target

Target process: `PUMP IT UP RISE.exe` (Steam app 2756930). Use only in the
owned local Warm Up mode. Do not use the judgment Instrument in public or
competitive play.

## Flow

Human dashboard:

```sh
bun run flab -- run piu
```

Equivalent expert-console calls (`--console`):

```js
await modState()
await toggle(true, true)
await judgmentStats()
await toggle(false)
await resetAll()
```

The Instrument resolves `PIUMobileStepDLL.PUMPPlayer::JudgeUnit`, owns its
IL2CPP implementation, and starts disabled. `judgmentStats()` exposes bounded
original/corrected distributions so an agent can distinguish an installed hook
from an actually exercised one.

## Live evidence

Verification ran on 2026-08-09 in the local Warm Up song `Yellow Dot`, 5K
Single level 7. With no gameplay input, the hook received 168 MISS judgments
and corrected all 168 to PERFECT. `piu-gameplay-live.png` visibly shows
`PERFECT COMBO`; after `toggle(false)`, `piu-after-disable.png` shows MISS and a
depleted life bar. The machine-readable activation, method identity,
distributions, disable, and cleanup receipt is
`artifacts/windows-steam-qa/piu-gameplay-live.jsonl`.

This target does not automate public matchmaking, network state, scores, or
leaderboards. A clean reattach must show `enabled=false`, `installed=false`,
and `clean=true` before a run is accepted.
