# Block Blast! game mod

Tested with Block Blast! `10.4.9` (`com.block.juggle`) on the arm64 Android
device `R3CWB0GCWMX`. The target uses the game's real Java/Cocos interfaces:

- `JsCallJava.evalString()` for live game JS and shipped traits;
- `Cocos2dxLocalStorage` for typed score and adventure progress;
- `Trait.dynamicEnableTraitsAsync()` for no-fail and unlimited revives.

Use only in an authorized offline/single-player session. Rankings, cloud state,
purchases, ads, and remote values are excluded.

## Start

```sh
# Human menu: Start here → Progress/Content/Gameplay
bun run flab -- tui blockblast --device R3CWB0GCWMX

# Advanced human console
bun run flab -- run blockblast --device R3CWB0GCWMX --no-watch

# One persistent AI session; send NDJSON on stdin
bun run flab -- run blockblast --device R3CWB0GCWMX --session --json --no-watch

# Start a stopped app, inject before main, then resume
bun run flab -- run blockblast --device R3CWB0GCWMX --spawn --no-watch
```

Replace the selector with `--device usb`, another exact device id, or
`--host host:port` for a remote Frida endpoint.

## Useful mod flow

```js
await progressRead()
await scoreSet(50000, true)
await adventureUnlockThrough(96, true)
await gameReload()
await survivalSetEnabled(true)
await survivalStatus()
await resetAll()
await gameReload()
```

The `true` argument is an explicit assertion that the game is fully offline.
Score/chapter writes are captured and reversible until `resetAll()`. Call
`gameReload()` after a write or restore when the visible scene must reread the
save immediately.

`survivalSetEnabled(true)` loads four shipped game traits as one understandable
mode: classic/adventure no-fail plus unlimited revives. Disable it with
`survivalSetEnabled(false)` or `resetAll()`.

`classicBoardClearNow(true)` is a one-shot classic-mode action. It first
requires a live classic score proxy. Adventure scenes are rejected before the
board mutation because their board model differs.

Persistent AI requests use string arguments:

```json
{"id":"read","op":"action","mode":"analysis","action":"progressRead","args":[]}
{"id":"score","op":"action","mode":"instrument","action":"scoreSet","args":["50000","true"]}
{"id":"unlock","op":"action","mode":"instrument","action":"adventureUnlockThrough","args":["96","true"]}
{"id":"survive","op":"action","mode":"instrument","action":"survivalSetEnabled","args":["true"]}
{"id":"state","op":"action","mode":"analysis","action":"modState","args":[]}
{"id":"reset","op":"action","mode":"instrument","action":"resetAll","args":[]}
{"id":"close","op":"close"}
```

## Game API coverage

| Feature | Game interface | Reset | Live result |
| --- | --- | --- | --- |
| Current/best score | four typed `class*Score` keys | Yes | `0/9374 → 9375 → 0/9374` |
| Adventure levels | `chapterNum/lastChapterNum` | Yes | level `1 → 2 → 1`; total `96` read live |
| No-fail | `NoFailBlockTrait` | Yes | dynamically loaded and `active=true` |
| Revives | three classic/adventure revive traits | Yes | all three loaded; total active traits `4/4` |
| Classic board clear | `clearAllBlocksImmediate()` | No | method resolved; adventure proxy absence rejected without changing its board |
| Runtime | Cocos module + Java/trait bridges | Read-only | `libcocos2djs.so` and exact APIs read from PID 16563 |
| QoL/performance | Activity flag + EGL observer | Yes | keep-awake and removable frame callbacks verified previously |

The score, chapter, and trait cycle ran in one persistent NDJSON attach while
the phone had no default network route. Every save value was read back, then
restored. Airplane mode and Wi-Fi were returned to their original settings.
When the secure lock screen paused Cocos before trait cleanup, the process was
force-stopped after save restoration; that removed all runtime-only traits.

## Safety and limits

- Block Blast has score/chapter/board systems rather than gold or item
  cooldowns, so its menu follows those game-specific systems.
- The classic board-clear success path still needs an unlocked classic board;
  the tested adventure mismatch is now a preflight rejection.
- `resetAll()` removes temporary bridge keys, restores captured save values,
  disables owned traits, and resets window/listener state. Keep the game
  foregrounded while resetting so Cocos can answer.
- The agent exposes fixed mod operations, not arbitrary game-JS evaluation.
