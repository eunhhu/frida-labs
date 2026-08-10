# GrowCastle game mod

Tested with GrowCastle `1.50.14` (`com.raongames.growcastle`) on the arm64
Android device `R3CWB0GCWMX`. This target calls live `Scripts.dll` IL2CPP game
APIs. FPS tools remain available, but progression, battle, and skill controls
are the primary menu.

Use only in an authorized offline/single-player session. Rankings, cloud sync,
crystals, purchases, ads, and remote state are excluded.

## Start

```sh
# Human dashboard: status + visible controls
bun run flab -- run growcastle --device R3CWB0GCWMX

# Advanced human console
bun run flab -- run growcastle --device R3CWB0GCWMX --console --no-watch

# One persistent AI session; send NDJSON on stdin
bun run flab -- run growcastle --device R3CWB0GCWMX --session --json --no-watch
```

Replace the selector with `--device usb`, another exact device id, or
`--host host:port`. Attach mode requires a live, foreground game. Android may
freeze a cached background process; reopen GrowCastle before attaching.

## Useful expert-console flow

```js
await progressRead()
await inventorySetGold(10000)
await progressSetPlayerLevel(50)
await progressSetSkillPoints(100)
await skillsSetNoCooldown(true)
await battleSetPause(false)
await modState()
await resetAll()
```

`resetAll()` restores the first gold, level, skill-point, pause, time-scale,
frame-target, and Activity values captured by the session. It also reverts the
three cooldown replacements and detaches every owned listener.

`waveSkip(count, true)` is deliberately different: it advances the current
battle through `GameMap.AddSkip`, so it is one-shot and cannot be undone by
`resetAll()`. It rejects calls unless a normal wave battle is active and the
caller explicitly confirms an offline session.

Persistent AI requests use string arguments:

```json
{"id":"read","op":"action","mode":"analysis","action":"progressRead","args":[]}
{"id":"gold","op":"action","mode":"instrument","action":"inventorySetGold","args":["10000"]}
{"id":"skills","op":"action","mode":"instrument","action":"skillsSetNoCooldown","args":["true"]}
{"id":"state","op":"action","mode":"analysis","action":"modState","args":[]}
{"id":"reset","op":"action","mode":"instrument","action":"resetAll","args":[]}
{"id":"close","op":"close"}
```

## Game API coverage

| Feature | Game function/field | Reset | Live result |
| --- | --- | --- | --- |
| Gold | `Inventory.get_Gold/set_Gold` | Yes | `125 → 126 → 125` |
| Player level | `Player.get_Level/set_Level` | Yes | `2 → 3 → 2` |
| Skill points | `Player.get_SkillPoint/set_SkillPoint` | Yes | `1 → 2 → 1` |
| Pause | `GameManager.get_Pause/set_Pause` | Yes | `false → true → false` |
| Unlimited skills | three `Reduce*Cooldown` methods | Yes | all three replacements installed; active-battle firing still requires a skill scene |
| Wave skip | `GameMap.AddSkip` | No | address/signature and inactive-battle guard verified; no online/live progression was performed |
| Game speed | `UnityEngine.Time` setter lock | Yes | `1.25` survived 18 game writes |
| Frame target | `UnityEngine.Application` setter lock | Yes | `30` survived 336 game writes; 29.99 FPS observed |
| Discovery | 78 assemblies, 1,681 `Scripts.dll` classes | Read-only | class/method signatures and live addresses returned |

The progression mutation cycle was exercised in one persistent NDJSON session
and read back after every write. Cleanup restored the on-screen values. The
cooldown cleanup now uses native `Interceptor.revert` for each replaced method;
the final firing test needs the phone unlocked and an active battle/skill scene.

## Safety and limits

- Gold here is the local `Inventory` value. Crystal/premium and purchase paths
  are intentionally absent.
- Do not use progression actions while cloud sync, ranking, or online events
  are active.
- Item insertion was mapped (`Items.Insert`, `Inventory.Add`) but no reversible
  item-code/name contract was proven, so the menu does not guess item ids.
- Always call `resetAll()` before detach or reload. If Android has frozen the
  app, foreground it first so managed restoration can run.
