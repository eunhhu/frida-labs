# MECCHA CHAMELEON offline training target

Target process: `PenguinHotel-Win64-Shipping.exe`. Use only with an authorized
offline, single-player, local bot, or isolated training instance. Do not use
the overlay or movement controls in online competitive play.

## Start

```sh
bun run flab -- tui mecchachameleon --device local
bun run flab -- run mecchachameleon --device local
bun run flab -- run mecchachameleon --device local --session --json
```

## Flow

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

The configurable ESP owns its render hook and refresh timer. The movement
trainer captures exact live component values before writing, re-resolves the
component across respawns, and retains failed restoration records for retry.
`resetAll()` removes the overlay and restores captured movement values.

## Coverage and limits

| Surface | Implementation | Current evidence |
| --- | --- | --- |
| Actor awareness | Configured UE actor classification and bounded projection | Existing target path; final refactor compiles |
| Movement trainer | Reflected `UCharacterMovementComponent` fields with original-value restore | Static/unit coverage; final live scene not available |
| Aim assist | Generic engine and UE adapters exist under `agent/lib/` | Not exposed here: engagement, hostility, visibility, and control paths are not live-verified |
| Cleanup | Owned ESP hook/timer plus retained movement restoration state | Static/unit coverage |

`LIVE VERIFICATION BLOCKED`: `PenguinHotel-Win64-Shipping.exe` is not present on
the current test host, so this refactor does not claim a live ESP render,
movement write/readback, respawn, or clean-reattach result. A future verified
run must exercise each action in an isolated offline scene and update this file
with the exact build, device, receipts, and limitations.
