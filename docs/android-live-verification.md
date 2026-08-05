# Android live-verification report

Captured on 2026-08-05 against an authorized Samsung SM-S911N running Android
15 (arm64), exact Frida device `R3CWB0GCWMX`. Host CLI was 17.15.3 and the
device server was 17.9.9. Tests used attach mode; bundle identifiers were
resolved to live PIDs even when Android/Frida exposed a localized app name.

## Scope decision

| App | Package | Decision |
| --- | --- | --- |
| Block Blast! 10.4.9 | `com.block.juggle` | Local score, adventure, no-fail, revive, and guarded board APIs built and tested offline |
| GrowCastle 1.50.14 | `com.raongames.growcastle` | Local gold, level, skill, battle, wave, and QoL APIs built; rankings and purchases excluded |
| The Battle Cats KR 15.5.0 | `jp.co.ponos.battlecatskr` | Read-only/local QoL target tested; battle work blocked by the owner's unaccepted 620 MB data download |
| Clash Royale, Lucky Defense, MilkChoco, PUBG MOBILE, Pokemon GO, Wuthering Waves | — | Excluded: online competitive/co-op/live-service or anti-cheat scope |

Unknown non-game packages were inventoried but not injected. No anti-cheat,
premium currency, purchase, leaderboard, event, remote save, or server-state
modification was attempted.

## Live result

| Target | Runtime mapping | Reversible controls | Runtime evidence | Cleanup |
| --- | --- | --- | --- | --- |
| `blockblast` | Cocos2d-x, Java local storage, live JS trait loader | Score/best score, adventure unlock, no-fail, unlimited revives, guarded classic clear, QoL | score `0/9374→9375`, level `1→2`, four survival traits active `4/4`; adventure board mismatch rejected | Six save keys restored; runtime traits removed; bridge keys cleaned |
| `growcastle` | Unity IL2CPP, 78 assemblies, 1,681 `Scripts.dll` classes | Gold, player level, skill points, pause, no-cooldown hooks, guarded wave skip, time/FPS/QoL | gold `125→126`, level `2→3`, points `1→2`, pause `false→true`; all read back | All four values restored; listener/replacement cleanup implemented |
| `battlecatskr` | `libnative-lib.so`, 58 game JNI exports | Keep-awake, EGL FPS meter, removable native touch observer | Safe corner tap fired 2 callbacks; 537 frames; 27.92 FPS | Reset, close, and fresh attach clean |

Block Blast's Java `JsCallJava.evalString`, `Cocos2dxLocalStorage`, and
`Trait.dynamicEnableTraitsAsync` paths were recovered from the live build, so
the earlier HEK-only limitation no longer applies. The classic clear method was
also resolved, but its first call occurred in an adventure scene and failed on
the absent classic score proxy without changing the board. The shipped action
now checks that proxy before mutation. Battle Cats unit/stage/battle/content
work remains disabled until the owner accepts the 620 MB data download and
opens an offline battle scene. These remaining blockers are not claimed as
coverage.

For persistent-write testing, the phone was put in airplane mode with mobile
data already off. The route was verified absent, values were changed and read
back, then reset. Airplane mode was disabled and Wi-Fi returned to its original
enabled state. A secure pattern lock later paused the Cocos runtime before the
trait-disable RPC could answer; save restoration still completed through the
Java storage API, and force-stopping the game removed the runtime-only traits.
Recon-created `flab_*` and `__flab_mod_result_*` database keys were explicitly
removed. GrowCastle's final active-skill firing check and Block Blast's classic
clear success path require the owner to unlock the phone and open those scenes.

## Interface and agent verification

The live TUI journey was exercised as `1 Connect → 2 Mods → 3 Inspect`, including
typed boolean input, action execution, verification receipt, reset receipt,
help, the advanced-tool palette, and an 80×24 compact terminal. Human REPLs
stayed alive for all three targets and Tab completed RPC names. One persistent
NDJSON process remains the supported AI interface; agents do not scrape or
drive the TUI. Mobile application enumeration now maps localized process names
back to saved bundle-id targets, so selecting `Block Blast!` or `냥코 대전쟁`
from Connect opens the game-specific target instead of a generic probe.
The complete first-run path was repeated after this fix: `Ctrl+V` selected the
phone, Connect listed all three games with saved-target diamonds, Block Blast
opened a short review screen, the next Enter attached PID 11539, and Mods showed
the descriptor-driven game actions; `Ctrl+Q` then closed the session cleanly.

All selectors use the same core path:

```sh
bun run flab -- tui growcastle --device usb
bun run flab -- tui growcastle --device R3CWB0GCWMX
bun run flab -- tui growcastle --host 10.0.0.8:27042
bun run flab -- run growcastle --device usb --session --json --no-watch
```

Both transport overrides were exercised live: `--device usb` attached to the
phone, and `--host 127.0.0.1:27043` attached through a temporary ADB-forwarded
Frida endpoint. A persistent remote NDJSON session emitted `ready`, completed a
typed `modState` action, acknowledged `close`, and exited 0. The temporary port
forward was removed afterward. If Android freezes a cached background app,
attach now explains that the game must be foregrounded or relaunched instead of
returning Frida's opaque stop timeout alone. Block Blast was also force-stopped,
started through Frida spawn, injected before main, resumed, and read back the
live Cocos module/engine from PID 11539. A subsequent attach reported clean
state. GrowCastle and Battle Cats remain registered as attach targets.

## Reproduction gate

The final repository gate passed:

```text
bun test                         91 passed, 0 failed
bun run typecheck               passed
bun run flab -- depcheck --json 0 violations across 37 files
bun tests/tui-mode-harness.ts    all scenarios passed
bun run test:runtime             27 native attach/session checks passed
flab build blockblast            passed
flab build growcastle            passed
flab build battlecatskr          passed
git diff --check                 passed
```

Per-target commands, coverage tables, cleanup behavior, and limitations live
next to each target in `agent/targets/<target>/README.md`. Raw device inventory,
preflight files, verification receipts, APK recon, and TUI screenshots are kept
under ignored `artifacts/` so device-specific evidence is not shipped as source.
