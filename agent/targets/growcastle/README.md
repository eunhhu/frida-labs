# GrowCastle target

Tested against GrowCastle `1.50.14`, package `com.raongames.growcastle`, on
Android device `R3CWB0GCWMX` (arm64). Scope is local single-player analysis and
reversible QoL. Rankings, purchases, ads, and remote state are excluded.

## Start

```sh
bun run flab -- tui growcastle --device R3CWB0GCWMX
bun run flab -- run growcastle --device R3CWB0GCWMX --no-watch
bun run flab -- run growcastle --device R3CWB0GCWMX --session --json --no-watch
```

The app must already be running. Override the saved selector with
`--device usb`, another exact id, or `--host host:port` when needed.

Useful REPL calls:

```js
await assemblies()
await gameCatalog()
await classSearch("Castle")
await methodSearch("speed")
await classDescribe("Player")
await timeSetScale(1.25)
await qolSetTargetFps(30)
await performanceStart()
await timeRead()
await performanceStatus()
await resetAll()
```

Persistent-session examples:

```json
{"id":"catalog","op":"action","mode":"analysis","action":"gameCatalog","args":[]}
{"id":"speed","op":"action","mode":"instrument","action":"timeSetScale","args":["1.25"]}
{"id":"fps","op":"action","mode":"instrument","action":"qolSetTargetFps","args":["30"]}
{"id":"state","op":"action","mode":"analysis","action":"timeRead","args":[]}
{"id":"reset","op":"action","mode":"instrument","action":"resetAll","args":[]}
{"id":"close","op":"close"}
```

## Coverage and live evidence

| System | Read | Modify/create | Live verification |
| --- | --- | --- | --- |
| Runtime | 78 IL2CPP assemblies | No runtime creation | `Scripts.dll` has 1,681 classes |
| Player/world | Player, hero, castle, map, wave catalogs | No stats/resources writes | Player/Castle class descriptions returned live offsets/methods |
| Combat/inventory/progression | Bounded class/method catalogs | No item, gold, purchase, or save writes | Categories returned 39/128/81 matches |
| Game time | `Time.timeScale` | Persistent 0.25–3 lock | 1.25 held after 18 attempted game resets |
| Frame target | `Application.targetFrameRate` | Persistent 15–240 lock | 30 held after 336 attempted resets; 29.99 FPS measured |
| QoL | Activity keep-awake | Reversible toggle | `true → false → reset true` |
| Content | Class discovery only | No safe registration path proven | Explicitly unsupported |

Invalid scale `4` and FPS `10` were rejected. `resetAll()` detached both setter
hooks, restored time scale `1`, target FPS `60`, the original window flag, and
the frame listener. A fresh attach reported both locks inactive.

## Why speed and FPS use locks

GrowCastle writes both Unity properties repeatedly. A one-shot setter appeared
successful but reverted immediately. The target therefore owns removable
setter hooks while a value is active. This is why `timeRead()` exposes the hook
address and `interceptedWrites`; those counters are proof that the control is
still winning. Reset detaches first, then restores the captured original.

