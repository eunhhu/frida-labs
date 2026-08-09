# Windows Steam E2E QA — 2026-08-09

## Scope

- Host: `DESKTOP-F9JRF79`; compatibility sweep used an interactive desktop
  session, and the final feature runs used interactive session 1.
- Authorization: user-owned offline installs.
- Method: one game at a time, main-menu compatibility only; read-only generic
  probe, engine/module discovery, Record surface, cleanup, and clean reattach.
- Registered Instruments additionally exercised `modInfo`, `modHelp`,
  `modState`, cleanup, and clean target reattach.
- Registered-target feature runs used bounded synthetic input and target
  actions inside owned offline/private scenarios. No anti-cheat bypass, public
  match, or production economy interaction was attempted.

## Steam result

| Result | Count |
| --- | ---: |
| Installed game entries | 22 |
| Passed | 20 |
| Failed | 0 |
| Safety-skipped | 2 |

Passed: A Dance of Fire and Ice, ASTRONEER, Banana Shooter, Citywars Tower
Defense, Forager, Geometry Dash, Human Fall Flat, MECCHA CHAMELEON, Muck,
Palworld, PUMP IT UP RISE, Raft, Rhythm Doctor, Supermarket Together, Terraria,
The Escapists 2, The Farmer Was Replaced, The Forest, tModLoader, and World
Crafter TD.

Skipped:

- PUBG: BATTLEGROUNDS — BattlEye-protected public game; local anti-cheat
  components detected.
- Stumble Guys — public competitive online title; no isolated offline path was
  selected.

Target-specific clean reattach passed for `adofai`, `mecchachameleon`, `piu`,
and `terraria`. The remaining passes establish generic runtime compatibility,
not game-specific feature semantics.

## Registered Instrument gameplay semantics

| Instrument | Real scenario and positive result | Negative/reset result |
| --- | --- | --- |
| ADOFAI | Offline 1-X: over-fast input completed with `noFail`/infinite margin; state 4, floor 10, completion 1, 349 enforcement applications | Identical input with assists off failed at 0%; clean reattach had no owned state |
| MECCHA CHAMELEON | Password-protected one-player server: PostRender ESP drew projected boxes for live actors; UE5 Mover MaxSpeed 500→1500 and the same 300 ms input moved ~86.5→168.4 units | Overlay hook removed; Mover values restored exactly; clean reattach empty |
| PUMP IT UP RISE | Local Warm Up `Yellow Dot`: 168 natural MISS judgments were intercepted and corrected to 168 PERFECT | After disable the game visibly produced MISS COMBO 297; clean reattach had no hook |
| Terraria | Offline `sunwoo` / `솔로`: CLR bridge read live player/inventory/world state; god mode restored naturally reduced HP 288→400; environment/NoKB/max-summon wrote `true/99`; time changed to visible night; item type 8 was created in empty slot 10 | Continuous values restored to captured `false/8`; item removed; day restored; intentional detach without `resetAll()` still left no timer/features/captures or forced flags on reattach |

These are feature-semantic receipts, not just successful RPC calls. Supporting
JSONL and screenshots are under `artifacts/windows-steam-qa/` using each target
name as the prefix. Terraria's Windows path uses the already loaded .NET CLR;
no Mono export or external `dotnet` installation is required.

Full bounded receipt: `artifacts/windows-steam-qa/report.json`
SHA-256: `40ff58c8297322a43dc47109570c21a113a92bad051f51f0ab19983c80b0e372`

## Platform and interface regression

- macOS: 118 tests, 0 failures, 954 expectations; typecheck and depcheck pass.
- Windows: 118 tests, 0 failures, 954 expectations; typecheck and depcheck pass.
- Runtime harness: attach, analysis, trace/watch/freeze, NDJSON, global Control,
  Record limits/pages, cleanup, and reattach pass on both platforms; hardware
  watch is verified.
- TUI harness: lifecycle, Probe validation, exactly three modes/contextual
  surfaces, paging, close races, live-handle preservation, detach, and crash
  classification pass on both platforms.

## Coding harnesses

- Codex CLI 0.146.0: repository `.codex/config.toml` auto-discovered `flab`;
  a read-only ephemeral run called `flab_control(capabilities)` once and received
  `flab.control.v1`.
- GJC 0.11.2: `.gjc/skills/build-game-mod` discovery passed; standalone
  `.mcp.json` mode called `flab_control(capabilities)` once and received
  `flab.control.v1`.
- GJC ACP is intentionally not advertised: this release rejects
  session-supplied MCP servers in SDK-backed ACP mode.
- Claude Code 2.1.215: `.mcp.json` discovery passed, but the local project server
  remains pending user approval and the stored OAuth session is expired. The
  model-backed MCP call is therefore blocked until the user re-authenticates and
  approves the project server; no trust or credential state was bypassed.
- ACP gateway and direct MCP stdio handshakes pass against protocol fixtures on
  both platforms. No compatible real ACP adapter is installed on the Windows
  host.

## Cleanup

No tested Steam process, native fixture, or QA scheduled task remained after the
run. The isolated Windows checkout remains at
`C:\Users\user\work\frida-labs-qa-current` with the full report and logs.
