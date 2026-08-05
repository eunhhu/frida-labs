# Block Blast! target

Tested against Block Blast! `10.4.9`, package `com.block.juggle`, on Android
device `R3CWB0GCWMX` (arm64). This target is intentionally fail-closed: the
shipped game traits are HEK bytecode and `libcocos2djs.so` is stripped, so it
does not claim unverified score, board, revive, or content writes.

## Start

```sh
# Human menu: press 2 for Mods, 3 for Inspect, ? for help
bun run flab -- tui blockblast --device R3CWB0GCWMX

# Human command console
bun run flab -- run blockblast --device R3CWB0GCWMX --no-watch

# Long-lived AI controller (NDJSON on stdin/stdout)
bun run flab -- run blockblast --device R3CWB0GCWMX --session --json --no-watch

# Start a stopped app, inject before main, resume, then open the human REPL
bun run flab -- run blockblast --device R3CWB0GCWMX --spawn --no-watch
```

Use `--device usb`, another exact device id, or `--host host:port` to override
the saved device. Attach mode requires the app to be running. Block Blast spawn
mode is also live-verified; runtime detection is lazy so resumed Cocos modules
appear even though the agent was injected before game initialization.

REPL examples:

```js
await modInfo()
await runtimeRead()
await featureCatalog()
await qolKeepAwake(true)
await performanceStart()
await performanceStatus()
await resetAll()
```

Persistent-session examples, one object per line:

```json
{"id":"describe","op":"describe"}
{"id":"catalog","op":"action","mode":"analysis","action":"featureCatalog","args":[]}
{"id":"awake","op":"action","mode":"instrument","action":"qolKeepAwake","args":["true"]}
{"id":"reset","op":"action","mode":"instrument","action":"resetAll","args":[]}
{"id":"close","op":"close"}
```

## Coverage and live evidence

| System | Read | Modify/create | Live verification |
| --- | --- | --- | --- |
| Runtime | Cocos module, process, architecture | No | `libcocos2djs.so` found in PID 29567 |
| Player/board | 5 shipped trait paths cataloged | No callable path proven | HEK bytecode + stripped exports |
| Progression | High-score trait cataloged | Intentionally disabled | No score/save write attempted |
| Visual/content | Skin and chapter traits cataloged | No safe factory path proven | Reported unsupported |
| QoL | Activity flag and EGL state | Keep-awake toggle | `false → true → reset false` |
| Performance | EGL frame observation | Removable listener | 2,040 callbacks, 118.94 measured FPS |

All 11 descriptors were exercised through the persistent protocol or TUI.
Exact-id attach, first-USB attach, explicit endpoint attach, persistent remote
NDJSON, and a stopped-app spawn/resume were exercised. Spawn PID 11539 exposed
the resumed `libcocos2djs.so` and a fresh attach was clean.
Reset, close, and a fresh attach reported `owned=false`, no listener, and
`clean=true`.

## Cleanup and limits

Always call `resetAll()` before `.exit`, hot reload, or an AI `close` request.
The target also calls the same cleanup from `dispose()`. No premium, remote,
advertising, or online state is modified. Gameplay writes stay unavailable
until a callable runtime path is proven and restored safely.
