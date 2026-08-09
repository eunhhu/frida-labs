# The Battle Cats KR target

Tested against The Battle Cats KR `15.5.0`, package
`jp.co.ponos.battlecatskr`, on Android device `R3CWB0GCWMX` (arm64). The
installed app currently stops at a user-confirmed 620 MB game-data download.
That download was not accepted, so battle-scene features remain blocked rather
than guessed.

## Start

```sh
bun run flab -- tui battlecatskr --device R3CWB0GCWMX
bun run flab -- run battlecatskr --device R3CWB0GCWMX --no-watch
bun run flab -- run battlecatskr --device R3CWB0GCWMX --session --json --no-watch
```

The app must already be running. Bundle-id attach is supported even when Frida
shows the localized process name `냥코 대전쟁`. Override the saved device with
`--device usb`, another exact id, or `--host host:port`.

Safe advanced-console calls available before the data download:

```js
await modInfo()
await runtimeRead()
await dataCatalog()
await qolKeepAwake(true)
await performanceStart()
await touchMonitorStart()
await touchMonitorStatus()
await resetAll()
```

Persistent-session examples:

```json
{"id":"runtime","op":"action","mode":"analysis","action":"runtimeRead","args":[]}
{"id":"touch","op":"action","mode":"debug","action":"touchMonitorStart","args":[]}
{"id":"touch-status","op":"action","mode":"analysis","action":"touchMonitorStatus","args":[]}
{"id":"reset","op":"action","mode":"instrument","action":"resetAll","args":[]}
{"id":"close","op":"close"}
```

## Coverage and live evidence

| System | Read | Modify/create | Live verification |
| --- | --- | --- | --- |
| Runtime | `libnative-lib.so`, 58 Battle Cats JNI exports | No | Bundle id resolved to localized PID 436 |
| Units/enemies/stages/items | Pack/list asset evidence | No loaded gameplay data | Catalog reports exact blockers |
| Battle/save/content | Native and APK evidence only | Disabled | No battle scene; save/currency writes excluded |
| Input | JNI `appTouch` status | Removable observer only | Safe corner tap produced 2 callbacks |
| QoL | Activity keep-awake | Reversible toggle | on/off/reset verified |
| Performance | EGL observation | Removable listener | 537 callbacks, 27.92 measured FPS |

The JNI touch symbol exists in the owning module but not Frida's global export
lookup; the target uses module-scoped lookup. Reset, close, and reattach left no
owned flag or listener.

## Blocker and safety boundary

Gameplay validation requires the owner to accept the in-game 620 MB download
and bring the app to an offline battle scene. Until then, do not claim unit,
stage, battle, save, content, premium currency, purchase, event, or server-state
modification. Online cheating and anti-cheat bypass remain out of scope.
