# AI harness guide: build a game-specific mod menu and REPL

This is the shared execution contract for GJC, Codex, Claude Code, and
OpenCode. Every harness must produce the same files, runtime evidence, and user
experience.

Use it only against a game, process, and device you own or are authorized to
test, preferably offline or single-player. Do not bypass anti-cheat, interfere
with online play, or affect another user's process or data.

## What a completed run produces

A completed run is not just a Frida script. It produces:

1. `agent/targets/<slug>/index.ts`, registered in `frida-labs.json`.
2. A descriptor-driven game-specific mod menu in `flab tui <slug>`.
3. A game-specific REPL in `flab run <slug>` with tab completion over the same
   actions.
4. The same surface for AI controllers through
   `flab run <slug> --session --json`.
5. `agent/targets/<slug>/README.md` with exact launch commands, feature catalog,
   coverage matrix, cleanup, and limitations.
6. Local recon and verification receipts under `artifacts/<slug>/`.

The menu, REPL, and AI protocol are three views of one `rpc.exports` surface.
Do not implement separate feature sets for each frontend.

## TUI versus an AI-controlled persistent CLI

The TUI is for humans; an AI agent should not scrape terminal pixels or send
arrow keys. The agent starts one `flab ... --session --json` child process,
keeps its stdin/stdout open, and exchanges typed NDJSON requests until `close`.
That single process retains the Frida attachment, live descriptors, action
receipts, and managed instrument ids. Hot reload and reconnect stay inside the
same host workflow instead of requiring a new shell command per action.

Use one-shot CLI evaluation only when the coding harness cannot retain a PTY or
child stdin. It is suitable for bounded recon, not for instrument lifecycle or
cleanup verification.

## Give the harness one complete request

Replace every value in braces:

```text
Build a verified game-specific mod for GAME={game title}, PROCESS={process name,
bundle id, or positive PID}, DEVICE={local|usb|remote|device id|host:port},
MODE={attach|spawn}. Desired priorities: {player/world/inventory/entities/content/
QoL/debug features}. Use only my authorized offline or single-player instance.
Follow docs/agent-game-mod-guide.md and the build-game-mod skill. Do not stop at
recon or scaffolding: implement the descriptor-driven TUI menu, REPL, and AI
session surface; exercise every shipped action against the live target; restore
state on cleanup; write the per-target usage and coverage report. If a subsystem
cannot be reached safely, report the evidence and limitation instead of guessing.
```

Prefer an interactive harness for first-time live attach work. The game may
need to be brought to a particular scene, permissions may need approval, and
crashes or process restarts need human visibility.

## Harness commands

Run every command from the repository root.

If `flab` is not installed or the compiled binary is not on `PATH`, replace
`flab ...` with `bun run flab -- ...`.

### GJC

This repository enables its project skill in `.gjc/config.yml`. Start an
interactive run with an initial skill invocation:

```sh
gjc '/skill:build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'
```

Inside an existing GJC session, type:

```text
/skill:build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"
```

For a one-shot/headless run:

```sh
gjc -p '/skill:build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'
```

Use `gjc --tmux '...'` when the outer coding-agent session must survive a
terminal disconnect. `flab --session --json` remains the persistent game
instrumentation session inside it.

### Codex CLI or Codex app

Codex discovers `.agents/skills/build-game-mod/SKILL.md`. Start interactively:

```sh
codex '$build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'
```

Inside an existing task, mention `$build-game-mod` and the same parameters.
In the Codex desktop app, select **Build Game Mod** from the Skills surface and
paste the complete request above.

For non-interactive automation that may edit the workspace:

```sh
codex exec --sandbox workspace-write '$build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'
```

`codex exec` defaults to a read-only sandbox. Live process attach may also be
blocked by the sandbox or operating-system policy. Prefer interactive approval.
Use broader permissions only in a controlled environment after reviewing the
exact process and device.

### Claude Code

Claude Code discovers `.claude/skills/build-game-mod/SKILL.md` and the root
`CLAUDE.md`:

```sh
claude '/build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'
```

Inside an existing session, type the same `/build-game-mod ...` command. A
headless run is:

```sh
claude -p '/build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"'
```

Use an interactive run when attach commands require approval or the game must
be driven to a test scene.

### OpenCode

OpenCode discovers the shared `.agents/skills/build-game-mod/SKILL.md`. The
project command `.opencode/commands/game-mod.md` provides a predictable TUI
entry point:

```sh
opencode
```

Then type:

```text
/game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content"
```

For non-interactive use:

```sh
opencode run 'Use the build-game-mod project skill. GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="QoL, player, world, content". Complete live verification and the target-local guide.'
```

Use the Build agent, not the read-only Plan agent, when implementation is
expected.

## Device and process selection

Never assume the target is local. Discover first:

```sh
flab capabilities --json
flab devices --json
flab processes --device local --json
flab processes --device usb --json
flab processes --device <exact-device-id> --json
flab processes --host 10.0.0.8:27042 --json
```

| Target | Selector | Example |
| --- | --- | --- |
| Host machine | `--device local` | `flab processes --device local --json` |
| First USB/mobile device | `--device usb` | `flab probe com.game.app --device usb --spawn` |
| Exact visible device | `--device <id>` | `flab probe --pid 1234 --device R58...` |
| Discovered remote device | `--device remote` | `flab processes --device remote --json` |
| Explicit Frida endpoint | `--host host:port` | `flab run mygame --host 10.0.0.8:27042` |

The selected device is an invariant. Enumerate, resolve PID/name, attach or
spawn, reconnect, and verify on the same device identity. A PID from the host
has no meaning on a USB or remote device.

For mobile spawn, `PROCESS` is commonly the application identifier. For an
already-running app, discover the exact name or PID on that device. Record the
device id, type, platform, process name, PID, attach/spawn mode, and Frida
version in the target guide.

## Execution contract for the coding agent

### Phase 1: preflight and select one live target

1. Read `CLAUDE.md`, this guide, and `flab capabilities --json`.
2. Run `bun install` only when dependencies are missing.
3. Run `flab doctor` with the intended device selector.
4. Run `flab devices --json`, then `flab processes ... --json` on the same
   selector.
5. Resolve ambiguity by exact device id plus positive PID. Ask the user only if
   multiple plausible processes remain or authorization is unclear.
6. Save the selected target identity under `artifacts/<slug>/preflight.json`.

### Phase 2: persistent recon before implementation

Start with the generic probe agent. Prefer a positive PID for an already
running game:

```sh
flab probe --pid <pid> --device <selector> --session --json
flab probe <bundle-or-process> --device usb --spawn --session --json
flab probe --pid <pid> --host <host:port> --session --json
```

The process accepts one `flab.ndjson.v1` request per stdin line and emits JSON
envelopes on stdout. Diagnostics remain on stderr. Read the `ready` envelope,
then call `describe`:

```json
{"id":"1","op":"ping"}
{"id":"2","op":"describe"}
{"id":"3","op":"action","mode":"analysis","action":"engines","args":[],"offset":0}
{"id":"4","op":"action","mode":"analysis","action":"modules","args":[""],"offset":0}
```

Keep this process alive while mapping addresses and managed objects. Stable
instrument ids exist only inside that session. Close it explicitly:

```json
{"id":"close","op":"close"}
```

If the coding harness cannot keep stdin open, use bounded one-shot probe calls
for initial facts, then move to a harness terminal/PTY for lifecycle testing.
Do not substitute the human TUI for a machine protocol parser.

### Phase 3: build an evidence-based subsystem map

Inventory every discoverable subsystem before choosing mod actions. At minimum
consider:

- engine/runtime, modules, assemblies/images, classes, methods, fields, exports;
- player state, movement, combat, health/resources, progression, and skills;
- inventory, equipment, items, loot, crafting, and recipes;
- world, levels/scenes, time, weather, environment, and physics;
- actors/entities, NPCs, enemies, spawners, AI, and quests/events;
- input, camera, UI/HUD, audio, localization, and save/config state;
- repeatable QoL opportunities and safe content-extension points.

For each row record `discovered`, `read`, `modify`, `create/content`, `restore`,
and `live-verified` evidence. “All game elements” means a complete catalog of
what the live build exposes plus explicit unsupported rows. It does not mean
inventing offsets, claiming hidden coverage, or shipping unsafe writes.

Use existing engine libraries instead of rebuilding them in the target:

- Unreal: `agent/lib/ue/`
- Unity IL2CPP: `agent/lib/il2cpp.ts`
- Unity Mono or FNA/Mono: `agent/lib/mono/`
- Android Java: `agent/lib/java.ts`
- Apple Objective-C: `agent/lib/objc.ts`
- Native/Cocos/unknown: detection, search, memory, strings, hook, watch, and
  managed instruments under `agent/lib/`

Run `flab lib --json` for the current reusable API catalog.

### Phase 4: scaffold and implement the game target

Create only after recon establishes the process and engine:

```sh
flab new <slug> "<process-or-bundle>" --device <selector> --json
flab target set <slug> --proc "<corrected-process>" --json
```

Use `--host` instead of `--device` for an explicit endpoint. Keep game-specific
glue in `agent/targets/<slug>/index.ts`; reusable runtime logic belongs in
`agent/lib/`. Targets may import only from `agent/lib/`, enforced by
`flab depcheck`.

Expose these discovery actions unless the runtime makes one inapplicable:

- `modInfo()` — game/build/device/runtime facts and safety/coverage summary.
- `modHelp()` — categories, actions, examples, risks, and reset command.
- `modState()` — enabled toggles, owned handles, and restoration state.
- domain reads and controls such as `playerRead`, `playerSet`, `worldRead`,
  `inventoryGive`, `entitySpawn`, `qolSet`, and `contentStart`.
- `resetAll()` or `dispose()` — stop timers/hooks, release handles, and restore
  every value that can be restored safely.

Every callable must appear in the live `__describe()` inventory. Include:

```ts
{
  name: "playerSetSpeed",
  label: "Set movement speed",
  category: "Player",
  args: [{ name: "multiplier", type: "number" }],
  doc: "Set the local player's movement multiplier; resetAll restores the captured value.",
  capabilities: ["instrument"],
  effect: "write",
  returns: "json",
}
```

Use short labels and stable categories such as `System`, `Player`, `World`,
`Inventory`, `Entities`, `Content`, `QoL`, and `Debug`. The TUI shows the
category and label; the REPL and machine protocol retain the stable `name`.

Implementation invariants:

- Return JSON-serializable values only; stringify pointers and large integers.
- Bound every table, string, and dump. Add paging when a result can grow.
- Grant `analysis` only to genuinely read-only actions.
- Mark writes, hooks, and controls truthfully. Use `statusAction` for a
  verification-returning action when a read-only status action exists.
- Default mutations off. Validate ranges and reject ambiguous or destructive
  inputs.
- Capture original state before the first write; make repeated enable/disable
  calls idempotent; restore on disable, reload, detach, and `dispose()`.
- Own every hook, timer, watch, and freeze with a handle. Never leak callbacks
  across hot reload.
- Prefer game/runtime APIs over raw writes. Re-resolve managed objects that may
  move under GC or scene changes.
- Use `ok`/`warn`/`err` from `agent/lib/log.ts`, never bare `console.log`.
- Do not ship TODO stubs or pretend compile-only validation is live proof.

“New content” must use a discovered creation path: a game factory/spawner,
managed constructor, data registry, script/event system, or supported asset
pipeline. If arbitrary assets require external packaging or a restart,
document that second stage and ship only the runtime-verified portion. Never
relabel a value edit as new content.

### Phase 5: verify the three interfaces

Static gates:

```sh
bun run typecheck
flab build <slug> --json
flab depcheck --json
bun test
```

Live REPL:

```sh
flab run <slug> --device <selector>
flab run <slug> --host <host:port>
```

Run `:exports`, `await modInfo()`, `await modHelp()`, and `await modState()`.
Exercise every shipped action with a safe value and confirm its reset/disable
path.

Live TUI menu:

```sh
flab tui <slug> --device <selector>
flab tui <slug> --host <host:port>
```

Confirm:

1. The selected device and process are visible and correct.
2. Instrument shows every descriptor with a useful category, label, signature,
   effect, return type, and docs.
3. Analysis contains read-only actions only.
4. REPL tab completion includes every action.
5. Mode switches do not detach the session.
6. Debug shows real hook receipts, detach, exception, or crash evidence without
   mislabeling events.

Live AI session:

```sh
flab run <slug> --device <selector> --session --json
```

Exercise `describe`, every read action, each mutation's enable/update/status/
disable or reset flow, and `close`. Verify that the ready envelope reports the
expected device identity and descriptors.

For managed trace/watch/freeze, test the complete lifecycle:

```json
{"id":"1","op":"action","mode":"instrument","action":"instrumentStart","args":["trace","0x1234","{\"label\":\"damage\",\"args\":2}"],"offset":0}
{"id":"2","op":"action","mode":"analysis","action":"instrumentStatus","args":["ins-1"],"offset":0}
{"id":"3","op":"action","mode":"instrument","action":"instrumentUpdate","args":["ins-1","{\"label\":\"damage-v2\"}"],"offset":0}
{"id":"4","op":"action","mode":"instrument","action":"instrumentStop","args":["ins-1"],"offset":0}
{"id":"5","op":"action","mode":"instrument","action":"instrumentDelete","args":["ins-1"],"offset":0}
```

Do not hard-code `ins-1`; consume the id returned by `instrumentStart`.

### Phase 6: cleanup, reattach, and report

1. Call the target's reset/dispose action and `instrumentStopAll` when exposed.
2. Close the session and confirm the game remains responsive.
3. Reattach once and verify `modState()` starts clean with no duplicate hooks.
4. Test process restart or respawn when the target supports spawn.
5. Store bounded runtime receipts under `artifacts/<slug>/verification.json`.
6. Write `agent/targets/<slug>/README.md` with copy-paste commands for local,
   USB/exact-device, and remote endpoint use; feature examples; the coverage
   matrix; cleanup; tested build/device; and limitations.

## Definition of done

- [ ] Exact device and process identity recorded.
- [ ] Recon covers every subsystem category or marks it unsupported.
- [ ] Target registered and imports only from `agent/lib/`.
- [ ] `modInfo`, `modHelp`, `modState`, and cleanup are real, not stubs.
- [ ] Every callable has truthful descriptor metadata.
- [ ] TUI presents a readable game-specific menu.
- [ ] REPL discovery and calls work.
- [ ] Persistent NDJSON control works on the same device.
- [ ] Every mutation has a tested reset/disable path.
- [ ] Build, typecheck, depcheck, and tests pass.
- [ ] Live attach/spawn, actions, cleanup, and reattach are evidenced.
- [ ] Target-local usage and coverage guide is complete.

If the game or device is unavailable, finish only what can be proven and state
`LIVE VERIFICATION BLOCKED` with the exact missing process, device, scene,
permission, or user action. Never convert a compile result into a runtime claim.
