# MECCHA CHAMELEON offline training target

Target process: `PenguinHotel-Win64-Shipping.exe`. Use only with an authorized
offline, single-player, local bot, or password-protected isolated training
instance. Do not use the overlay or movement controls in public play.

## Start

```sh
bun run flab -- run mecchachameleon --device local
bun run flab -- run mecchachameleon --device local --console
bun run flab -- run mecchachameleon --device local --session --json
```

## Equivalent expert-console flow

```js
await modInfo()
await espSnapshot()
await espInstall(true)
await moveRead()
await moveApply({ walk: 900, jump: 600, air: 0.5 }, true)
await moveEnforce(true, true, 250)
await modState()
await resetAll()
```

The configurable ESP owns its render hook and refresh timer. This build uses
UE5 Mover, not `UCharacterMovementComponent`; the reusable Mover Instrument
resolves `CommonLegacyMovementSettings`, captures exact live values before
writing, re-resolves the component across respawns, and retains failed
restoration records for retry.
`resetAll()` removes the overlay and restores captured movement values.

## Coverage and limits

| Surface | Implementation | Current evidence |
| --- | --- | --- |
| Actor awareness | UE actor classification, bounded projection, and owned PostRender hook | Steam private server: 515 frames, 5 tracked entities, 3 projected records; visible boxes in `artifacts/windows-steam-qa/meccha-esp-live.png` |
| Movement Instrument | Reflected UE5 Mover settings with live readback, enforcement, and original-value restore | Steam private server: MaxSpeed 500→1500, Acceleration 4000→8000, same 300 ms input moved ~86.5→168.4 units; exact restore passed |
| Aim assist | Generic engine and UE adapters exist under `agent/lib/` | Not exposed here: engagement, hostility, visibility, and control paths are not live-verified |
| Flight | A `FlyingMode` exists in the runtime graph | Not exposed: switching the active Mover state is not live-verified |
| Cleanup | Owned ESP hook/timer plus retained movement restoration state | Hook removal and movement restoration passed; clean reattach receipt is required in every run |

Live verification was run on 2026-08-09 against Steam app 4704690 in a
password-protected one-player server. Machine-readable receipts live in
`artifacts/windows-steam-qa/meccha-mover-e2e.jsonl`,
`meccha-motion-baseline.jsonl`, `meccha-motion-boosted.jsonl`, and
`meccha-esp-live.jsonl`. These receipts do not authorize public-match use.
