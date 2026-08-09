# Terraria offline Instrument

Target process: `Terraria.exe` on Windows or `Terraria.bin.osx` on macOS. Use
only in a user-owned offline single-player world.

## Start

```sh
bun src/bin.ts run terraria --device local
bun src/bin.ts run terraria --device local --console
bun src/bin.ts run terraria --host <host:port> --session --json
```

Human dashboard, opt-in advanced console, selected-session JSON, ACP, and MCP all call the same live
descriptors. Continuous mutations start disabled and require
`offlineConfirmed=true` when enabled.

Equivalent expert-console calls:

```js
await playerSnapshot()
await set("god", true, true)
await set("env", true, true)
await cmd("time night", true)
await cmd("give 8 1", true)
await modState()
await resetAll()
```

## Runtime adapters

| Platform | Adapter | Status |
| --- | --- | --- |
| Windows Steam 1.4.5.6 | `ICLRRuntimeHost` loads a self-contained managed reflection payload into Terraria's existing default AppDomain | Live verified |
| macOS FNA/Mono | Mono embedding API exported by `Terraria.bin.osx` | Implemented; retain per-build verification |

The Windows payload is compiled from `clr/TerrariaBridge.cs`, embedded in the
Frida bundle, and written under a content-addressed temporary DLL name. A
later attachment reuses the locked identical payload. `dispose()` stops its
managed timer before releasing the CLR host interfaces; the temporary DLL is
removable after the game exits.

## Windows feature evidence

| Surface | Result on owned `sunwoo` / `솔로` world |
| --- | --- |
| Player read | HP 400/400, mana 200/200, breath 200/200, defense, position, world, summons, and bounded non-empty inventory read live |
| God / NoKB / environment / max summons | `false/8` baseline → `true/99`; 54 enforcement applications; disable restored the captured `false/8` values |
| Long-running god mode | 15 seconds, 961 applications, `immune=true`, no timer error |
| Natural damage / detach cleanup | Live HP was 288/400 before activation and became 400/400 under god mode; the session then closed intentionally without `resetAll()`, and automatic `dispose()` removed the timer, features, seven captures, and immunity/environment flags before reattach |
| World time | day → dusk/night with visible night scene → dawn/day |
| Inventory | item type 8 created in empty slot 10, appeared in the live inventory snapshot, then `clear 10` removed it and restored the original empty slot |
| Cleanup / reattach | disabled features, zero captures, no timer; fresh Frida attachment queried the managed state as `clean=true` |

Receipts:

- `artifacts/windows-steam-qa/terraria-clr-feature-e2e.jsonl`
- `artifacts/windows-steam-qa/terraria-clr-inventory-e2e.jsonl`
- `artifacts/windows-steam-qa/terraria-clr-clean-reattach.jsonl`
- `artifacts/windows-steam-qa/terraria-clr-detach-cleanup.jsonl`
- `artifacts/windows-steam-qa/terraria-clr-post-detach.jsonl`
- `artifacts/windows-steam-qa/terraria-clr-inventory-live.png`

## Coverage and limits

Windows supports live snapshot, heal/mana/breath, day/time, give/clear/dupe,
tile teleport, summon count, revive/respawn, and continuous god, mana, breath,
no-knockback, flight resource, environmental immunity, max summons, and fast
item reuse. Inventory and world commands are one-shot and may persist if the
world is saved. `resetAll()` restores captured continuous flags/settings but
does not undo deliberate healing, time, teleport, or inventory commands.

Map right-click teleport, cursor teleport, and full map reveal currently remain
Mono-only. Mana, breath, flight, fast-use, teleport, revive/respawn, and dupe
are implemented on Windows but still require a scenario-specific gameplay
counterexample before they are labeled semantically confirmed for a new build.
