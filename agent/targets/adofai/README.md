# A Dance of Fire and Ice offline Instrument

Target process: `A Dance of Fire and Ice.exe`. Use only in an owned offline
level or isolated training scene.

## Flow

Human dashboard:

```sh
bun run flab -- run adofai
```

Equivalent expert-console calls (`--console`):

```js
await assistRead() // ready=false until a level is loaded
await assistApply({ noFail: true, infiniteMargin: true }, true)
await assistEnforce(true, true, 250)
await assistRead()
await assistReset()
```

The Instrument resolves the current build's live `scrController._instance`,
captures the selected field values before the first write, and immediately
reads them back. `assistReset()` stops enforcement and restores captured values
on the active controller. Discovery, Record, and owned managed traces remain
available through the same descriptor-driven human and Agent interfaces.

## Current build facts

The Windows Steam build inspected on 2026-08-09 exposes `noFail`,
`noFailInfiniteMargin`, and `freeroamInvulnerability` on `scrController`.
In offline level 1-X, the same intentionally over-fast input failed at 0% with
assistance off and reached completion state with assistance on. The positive
receipt recorded state 4, floor 10, `percentComplete=1`, all requested fields
true, and 349 enforcement applications. Evidence lives in
`artifacts/windows-steam-qa/adofai-live-stress-negative.png`,
`adofai-live-stress-positive.png`, and `adofai-live-hold.jsonl`; clean reattach
is recorded in `adofai-live-clean.jsonl`.
