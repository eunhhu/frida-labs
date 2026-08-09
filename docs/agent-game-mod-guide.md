# AI harness guide: build a game-specific Instrument

This is the shared execution contract for GJC, Codex, Claude Code, and
OpenCode. Every harness must produce the same files, runtime evidence, and user
experience.

Use it only against a game, process, and device you own or are authorized to
test. Work in owned-offline mode or a fully owned, consenting, isolated private
lab where anti-cheat is absent or officially disabled. Do not bypass anti-cheat,
enter public play, or affect another user's process, account, or data.

## If you are the game owner, start here

You do **not** need to execute the phases in this document yourself. Give your
harness these five facts and invoke its `build-game-mod` skill:

```text
Game: <title>
Process: <name, bundle id, or positive PID>
Device: <local, usb, remote, exact id, or host:port>
Start mode: <attach or spawn>
Wanted features: <objectives/win-loss, completion/progression, economy/rewards,
combat, cooldowns, inventory, content, aim assist, ESP/awareness, movement
assistance, accessibility, training, QoL, ...>
```

Also provide the authorization profile from `docs/agent-control-api.md` and ask
the agent to finish live verification, cleanup, and packaging. The commands are
listed below. Everything after them is the completion contract the agent
follows; it is reference material, not required reading for basic use.

## What a completed run produces

A completed run is not just a Frida script. It produces:

1. `agent/targets/<slug>/index.ts`, registered in `frida-labs.json`.
2. A descriptor-driven game-specific Instrument in `flab tui <slug>` with
   input fields, checkboxes, sliders, selects, and a linked live-state pane.
3. An advanced game-specific console in `flab run <slug>` with generated help
   and tab completion over the same actions.
4. The complete authoring surface through ACP/MCP or `flab agent --json`, plus
   the same selected live surface through `flab run <slug> --session --json`.
5. `agent/targets/<slug>/README.md` with exact launch commands, feature catalog,
   coverage matrix, cleanup, and limitations.
6. `artifacts/<slug>/semantic-model.json` mapping objectives, win/loss,
   rewards, local economy, persistence, entities, and assist/training surfaces.
7. Local recon, controlled-experiment, and verification receipts under
   `artifacts/<slug>/`.
8. A checksummed `dist/instruments/<slug>.flab.json` package.
9. When Record was used, bounded metadata and JSONL events under
   `artifacts/records/`, referenced by the semantic model or verification receipt.

The control panel, advanced console, and AI protocol are three views of one
`rpc.exports` surface.
Do not implement separate feature sets for each frontend.

## Human TUI versus ACP/MCP agent control

The TUI is for humans; an AI agent must not scrape terminal pixels or send arrow
keys. An ACP client starts `flab acp`; flab auto-detects a compatible upstream
agent or accepts `--upstream`, then injects the flab MCP server into the ACP
session. An MCP-native harness starts `flab mcp`. A minimal harness may keep
`flab agent --json` open directly. All three paths send a concrete authorization
profile and use the same `flab.control.v1` operations for discovery, Record,
authoring, module linking, build, live actions, cleanup, and packaging. A
selected live session retains the Frida attachment, descriptors, receipts, and
managed Instrument ids.

Record bridges the human/agent observation gap. The human starts one bounded
capture, performs one named gameplay scenario, then stops it. The agent consumes
the persisted timing, argument, return, duration, thread, and transition summary
without scraping the screen or requiring a multimodal model. Record does not
replace screenshots or human notes for visual-only meaning.

Use one-shot CLI evaluation only when the coding harness cannot retain a PTY or
child stdin. It is suitable for bounded recon, not for instrument lifecycle or
cleanup verification.

## Give the harness one complete request

Replace every value in braces:

```text
Build a verified game-specific mod for GAME={game title}, PROCESS={process name,
bundle id, or positive PID}, DEVICE={local|usb|remote|device id|host:port},
MODE={attach|spawn}. Desired priorities: {objectives/win-loss/completion/progression/
economy/rewards/combat/cooldowns/inventory/entities/content/aim assist/ESP/
movement assistance/accessibility/training/QoL features}. Use only my authorized
owned-offline instance or fully owned, consenting, isolated private lab.
Follow docs/agent-game-mod-guide.md and the build-game-mod skill. Do not stop at
recon or scaffolding: implement the descriptor-driven Instrument and Agent API;
exercise every shipped action against the live target; restore state on cleanup;
package it; write the per-target usage and coverage report. If a subsystem
cannot be reached safely, report the evidence and limitation instead of guessing.
For continuous assists, require a discovered local engagement gate and explicit
offline confirmation; keep them off by default and do not implement auto-fire.
```

Prefer an interactive harness for first-time live attach work. The game may
need to be brought to a particular scene, permissions may need approval, and
crashes or process restarts need human visibility.

## Harness commands

Run every command from the repository root.

If `flab` is not installed or the compiled binary is not on `PATH`, replace
`flab ...` with `bun run flab -- ...`.

### GJC

This repository enables its project skill in `.gjc/config.yml` and ships the
same flab tools in `.mcp.json`. GJC currently requires the MCP file explicitly
and requires its path to be absolute. Start an interactive run with:

```sh
gjc --mcp-config "$PWD/.mcp.json" '/skill:build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"'
```

In PowerShell, set `$mcp = (Resolve-Path .mcp.json).Path` and pass
`--mcp-config $mcp`.

Inside an existing GJC session, type:

```text
/skill:build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"
```

For a one-shot/headless run:

```sh
gjc -p --mcp-config "$PWD/.mcp.json" '/skill:build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"'
```

Use `gjc --tmux '...'` when the outer coding-agent session must survive a
terminal disconnect. `flab --session --json` remains the persistent game
instrumentation session inside it.

### Codex CLI or Codex app

Codex discovers `.agents/skills/build-game-mod/SKILL.md`. Start interactively:

```sh
codex '$build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"'
```

Inside an existing task, mention `$build-game-mod` and the same parameters.
In the Codex desktop app, select **Build Game Mod** from the Skills surface and
paste the complete request above.

For non-interactive automation that may edit the workspace:

```sh
codex exec --sandbox workspace-write '$build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"'
```

`codex exec` defaults to a read-only sandbox. Live process attach may also be
blocked by the sandbox or operating-system policy. Prefer interactive approval.
Use broader permissions only in a controlled environment after reviewing the
exact process and device.

### Claude Code

Claude Code discovers `.claude/skills/build-game-mod/SKILL.md` and the root
`CLAUDE.md`:

```sh
claude '/build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"'
```

Inside an existing session, type the same `/build-game-mod ...` command. A
headless run is:

```sh
claude -p '/build-game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"'
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
/game-mod GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content"
```

For non-interactive use:

```sh
opencode run 'Use the build-game-mod project skill. GAME=Terraria PROCESS=Terraria.exe DEVICE=local MODE=attach FEATURES="objectives, economy, combat, aim assist, ESP, movement assistance, content". Complete live verification, packaging, and the target-local guide.'
```

Use the Build agent, not the read-only Plan agent, when implementation is
expected.

## Device and process selection

Never assume the target is local. Discover first:

```sh
flab capabilities --json
flab acp detect --json
flab agent --json
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

1. Read `CLAUDE.md`, this guide, `docs/agent-control-api.md`, and runtime
   capabilities through ACP/MCP or `flab agent --json`.
2. Run `bun install` only when dependencies are missing.
3. Run `flab doctor` with the intended device selector.
4. Run `flab devices --json`, then `flab processes ... --json` on the same
   selector.
5. Resolve ambiguity by exact device id plus positive PID. Ask the user only if
   multiple plausible processes remain or authorization is unclear.
6. Prefer `flab acp` for an ACP harness, `flab mcp` for an MCP harness, or start
   one direct `flab.control.v1` process. Send the concrete owned-offline or
   private-lab authorization profile before device or mutation operations.
7. Save the selected identity and authorization class, without secrets, under
   `artifacts/<slug>/preflight.json`.

### Phase 2: persistent recon before implementation

Prefer the global control process: use `device.list`, `process.list`, then
`session.open` with a generic probe launch. The single-target compatibility
transport below remains available. Prefer a positive PID for a running game:

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
{"id":"5","op":"action","mode":"analysis","action":"memorySnapshot","args":["0xADDRESS","256"],"offset":0}
{"id":"6","op":"action","mode":"analysis","action":"memoryDiff","args":["snap-1"],"offset":0}
{"id":"7","op":"action","mode":"instrument","action":"memorySnapshotDelete","args":["snap-1"],"offset":0}
```

Use the actual id returned by `memorySnapshot`; never assume `snap-1`.

Keep this process alive while mapping addresses and managed objects. Stable
instrument ids exist only inside that session. Close it explicitly:

```json
{"id":"close","op":"close"}
```

If the coding harness cannot keep stdin open, use bounded one-shot probe calls
for initial facts, then move to a harness terminal/PTY for lifecycle testing.
Do not substitute the human TUI for a machine protocol parser.

When a human can play one representative scenario, prefer Record over blind
guessing. Through `flab.control.v1`:

1. Call `record.plan` with a narrow symbol/function query and optional exact
   module. Inspect the bounded candidates; do not hook every function.
2. Call `record.start` with selected addresses, argument counts, a scenario
   label, duration/event caps, and backtraces only when needed.
3. Tell the human the single action to perform: one hit, pickup, shot, jump,
   purchase, win, loss, or other isolated event.
4. Poll `record.status`, then call `record.stop` before changing scenes.
5. Read `record.summary` first. Use bounded `record.read` pages only for the
   functions and transitions that need deeper inspection.
6. Reference the returned Record id and artifact paths in the experiment or
   semantic-model evidence. Report dropped or truncated events explicitly.

Capture ends automatically at its duration/event/byte bounds, on detach, or
during cleanup. Raw pointer-shaped arguments are evidence, not inferred types;
correlate them with reflection, memory, symbols, and controlled counterexamples.

The generic probe establishes identity, runtime, modules, strings, symbols,
hooks, and state-diff candidates; it is not full semantic coverage. After the
engine is confirmed, continue discovery through one game target importing the
appropriate IL2CPP, Mono, UE, Java, ObjC, Cocos, or native library. Expose
bounded read-only discovery actions while mapping, then keep only useful,
truthful actions in the finished menu.

### Phase 3: build an evidence-based subsystem map

Inventory every discoverable subsystem before choosing mod actions. At minimum
consider:

- engine/runtime, modules, assemblies/images, classes, methods, fields, exports;
- objectives, rules, win condition, defeat condition, completion gates, retries,
  checkpoints, stage transitions, reward grants, and post-match/save commits;
- every local economy/currency type, wallet, cap, source, sink, exchange,
  purchase-free unlock path, reward multiplier, serialization, and authority;
- player state, movement, combat, health/resources, progression, and skills;
- inventory, equipment, items, loot, crafting, and recipes;
- world, levels/scenes, time, weather, environment, and physics;
- actors/entities, NPCs, enemies, spawners, AI, and quests/events;
- input, camera, aim/control rotation, team/hostility, visibility/occlusion,
  UI/HUD, ESP/awareness rendering, audio, localization, and save/config state;
- movement modes, speed/acceleration/jump/gravity/air control, traversal,
  accessibility controls, training feedback, and practice/dummy systems;
- repeatable QoL opportunities and safe content-extension points.

For each row record `discovered`, `read`, `modify`, `create/content`, `restore`,
and `live-verified` evidence. “All game elements” means a complete catalog of
what the live build exposes plus explicit unsupported rows. It does not mean
inventing offsets, claiming hidden coverage, or shipping unsafe writes.

Write `artifacts/<slug>/semantic-model.json` with schema
`flab.game-model.v1`. Keep it bounded and include:

- `objectives`: state, prerequisites, win/loss transitions, trigger path,
  reward path, persistence path, reset/retry path, evidence, and confidence;
- `economies`: currency/resource id, local/server authority, getter/setter or
  save path, cap, sources, sinks, reward links, restore strategy, and evidence;
- `entities`: player/team/hostility/life/visibility/target-point evidence and
  factories/spawners when present;
- `assists`: aim, ESP/awareness, movement, accessibility, and training paths,
  activation gate, bounds, cleanup, unsupported rows, and live evidence;
- `experiments`: scene/build, controlled action, before/after observation,
  address/member/call path, outcome, counterexample, confidence, and receipt id.

Minimal shape:

```json
{
  "schema": "flab.game-model.v1",
  "target": { "game": "...", "build": "...", "deviceId": "..." },
  "objectives": [],
  "economies": [],
  "entities": [],
  "assists": [],
  "experiments": [],
  "unsupported": []
}
```

### Required semantic discovery loop

Do not infer a mechanic from a promising name alone. For each high-value
hypothesis, run a controlled loop on the same device and scene:

1. Capture a read-only baseline: game state, relevant managed fields/save keys,
   and bounded memory snapshots.
2. Trigger exactly one natural event, such as one kill, spend, pickup, wave end,
   victory, defeat, jump, aim movement, or visibility transition.
3. Diff state, then narrow candidates with managed reflection, strings/symbols,
   memory write watch plus backtrace, and a bounded Record of function timing,
   arguments, return values, and transitions.
4. Trace both directions: cause → state transition → reward/save, and direct
   state/API change → HUD/gameplay/persistence effect.
5. Repeat a positive case, negative/counterexample case, cleanup, and reattach.
   Record confidence as `confirmed`, `partial`, or `unsupported`.

For an objective, finding only a `won` boolean is insufficient: map the
prerequisite, authoritative transition, reward grant, progression update, and
save/reload behavior. For an economy, finding only a displayed number is
insufficient: distinguish wallet, presentation proxy, source/sink, cap,
serialization, and local versus server authority.

Prioritize controls that change the game's core loop: level/progression caps,
stage or wave advancement, local score/resources, health/damage, skill or item
cooldowns, inventory/equipment, spawns, game-specific content systems, and
bounded accessibility/training assists that materially reduce execution burden.
Frame-rate meters, keep-awake, and generic discovery are supporting tools, not
a completed Instrument when callable gameplay functions or state were found.
Do not force the same feature list onto every title: map each requested outcome
to that game's actual functions, fields, proxies, factories, or save schema.

When the live game exposes the required paths, synthesize a small coherent set
instead of isolated debug toggles: `objectiveCompleteCurrent`, `waveSkip`,
`rewardSetMultiplier`, `economyRead/economySet`, `aimAssistSet`,
`espSet/espSnapshot`, and named movement-training profiles. Preserve the game's
state invariants: a completion action must not silently skip required reward or
save transitions, and irreversible one-shot progress must be labeled as such.

Use existing engine libraries instead of rebuilding them in the target:

- Unreal: `agent/lib/ue/`
- Engine-neutral aim selection/smoothing: `agent/lib/assist.ts`
- Configurable UE aim, ESP, and reversible movement Instrument modules:
  `agent/lib/ue/aim.ts`, `agent/lib/ue/esp.ts`, `agent/lib/ue/movement.ts`
- Unity IL2CPP: `agent/lib/il2cpp.ts`
- Unity Mono or FNA/Mono: `agent/lib/mono/`
- Android Java: `agent/lib/java.ts`
- Apple Objective-C: `agent/lib/objc.ts`
- Native/Cocos/unknown: detection, search, memory, strings, hook, watch, and
  managed instruments under `agent/lib/`

Run `flab lib --json` for the current reusable API catalog.

### Phase 4: scaffold and implement the game Instrument

Create only after recon establishes the process and engine:

```sh
flab new <slug> "<process-or-bundle>" --device <selector> --json
flab target set <slug> --proc "<corrected-process>" --json
```

Agents normally use `instrument.create`, `instrument.source.read`,
`module.list`, `module.link`, and compare-and-swap `instrument.source.write`
through ACP/MCP-backed `flab.control.v1`. CLI commands remain human adapters
over the same project and source services.

Use `--host` instead of `--device` for an explicit endpoint. Keep game-specific
glue in `agent/targets/<slug>/index.ts`; reusable runtime logic belongs in
`agent/lib/`. Targets may import only from `agent/lib/`, enforced by
`flab depcheck`.

Expose these discovery actions unless the runtime makes one inapplicable:

- `modInfo()` — game/build/device/runtime facts and safety/coverage summary.
- `modState()` — enabled toggles, owned handles, and restoration state.
- domain reads and controls such as `playerRead`, `playerSet`, `worldRead`,
  `objectiveRead`, `objectiveCompleteCurrent`, `economyRead`, `economySet`,
  `rewardSetMultiplier`, `inventoryGive`, `entitySpawn`, `qolSet`, and
  `contentStart`.
- when discovered and applicable, bounded training actions such as
  `aimAssistPreview`, `aimAssistSet`, `aimAssistStatus`, `espSnapshot`,
  `espSet`, `espStatus`, `movementRead`, `movementProfileSet`, and
  `movementReset`.
- `resetAll()` or `dispose()` — stop timers/hooks, release handles, and restore
  every value that can be restored safely.

Every callable must appear in the live `__describe()` inventory. Include:

```ts
{
  name: "playerSetSpeed",
  label: "Set movement speed",
  category: "Player",
  args: [{
    name: "multiplier",
    type: "number",
    ui: { control: "slider", label: "Movement speed", min: 0.5, max: 3, step: 0.25, default: 1 },
  }],
  doc: "Set the local player's movement multiplier; resetAll restores the captured value.",
  capabilities: ["instrument"],
  effect: "write",
  returns: "json",
}
```

Continuous assistance uses an explicit lifecycle rather than a hidden toggle:

```ts
{
  name: "aimAssistSet",
  label: "Toggle bounded aim assistance",
  category: "Assist",
  args: [
    { name: "enabled", type: "boolean", ui: { control: "checkbox", label: "Aim assistance" } },
    { name: "offlineConfirmed", type: "boolean", ui: { control: "checkbox", label: "Owned offline session" } },
  ],
  doc: "Requires a verified hostile/visibility/input path; disable and resetAll stop its owned timer.",
  capabilities: ["instrument"],
  effect: "control",
  returns: "json",
  statusAction: "aimAssistStatus",
}
```

Argument `ui.control` supports `input`, `checkbox`, `slider`, and `select`.
Use `min`/`max`/`step` for sliders, and bounded `{label,value}` `options` for
selects. Omitted UI metadata is inferred safely (`boolean` becomes a checkbox;
other types become an input). Defaults must be valid action arguments. The TUI
renders at most three fields at once and uses `statusAction`, or the target's
zero-argument `modState`, for the live-state pane. `.help`, `/help`, and `:help`
are generated by flab from the same descriptors. Do not implement a per-target
`modHelp()` export.

Use short labels and stable categories such as `Start here`, `Objectives`,
`Economy`, `Player`, `Combat`, `World`, `Inventory`, `Entities`, `Assist`,
`Visual`, `Movement`, `Training`, `Content`, `QoL`, and `Debug`. The TUI shows
the category and label; the advanced console and machine protocol retain the
stable `name`.

Implementation invariants:

- Return JSON-serializable values only; stringify pointers and large integers.
- Bound every table, string, and dump. Add paging when a result can grow.
- Grant `analysis` only to genuinely read-only actions.
- Mark writes, hooks, and controls truthfully. Use `statusAction` for a
  verification-returning action when a read-only status action exists.
- Default mutations off. Validate ranges and reject ambiguous or destructive
  inputs.
- Require `offlineConfirmed=true` for irreversible progress and continuous
  assistance. Never infer authorization from airplane mode alone.
- Aim assist must positively classify hostility, reject dead/friendly/unknown
  entities, bound angular FOV and distance, expose smoothing, and act only while
  a discovered local engagement gate is active. Visibility-required mode must
  fail closed when occlusion evidence is unavailable. Do not add auto-fire.
- ESP/awareness must bound entity count and refresh rate, exclude self, label
  team/hostility and alive state truthfully, and report visibility as `unknown`
  unless a line-of-sight path was verified. Overlay removal must detach its
  render hook and timer.
- Movement assistance must capture the live original component values before the
  first write, survive respawn by re-resolving components, bound every profile,
  and restore captured values rather than assumed engine defaults.
- Economy controls must identify local versus remote authority and preserve
  dependent counters/checksums/save invariants. Premium purchase, leaderboard,
  remote-wallet, or server-state paths remain out of scope.
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

### Phase 5: verify the human, Agent, and artifact interfaces

Static gates:

```sh
bun run typecheck
flab build <slug> --json
flab depcheck --json
bun test
```

Live advanced console:

```sh
flab run <slug> --device <selector>
flab run <slug> --host <host:port>
```

Run `.help` (also `/help` and `:help`), `.exports`, `await modInfo()`, and
`await modState()`. Confirm the generated help lists every descriptor and its
human control without any target-local help export.
Exercise every shipped action with a safe value and confirm its reset/disable
path.

Verify domain semantics, not only RPC success:

- objectives: natural positive and negative outcomes, mod-triggered transition,
  reward/progression update, save/reload result, and irreversible labeling;
- economy: read, bounded write or multiplier, HUD/gameplay readback, one natural
  source and sink when safely reachable, reset, and persistence behavior;
- aim assist: friendly/dead/hidden/out-of-FOV rejection, one eligible target,
  smoothing, engagement-gate release, disable, and clean reattach;
- ESP/awareness: self exclusion, entity cap, team/hostility labels, honest
  visibility state, overlay removal, and no duplicate render hook;
- movement assistance: apply/readback, respawn or component change when reachable,
  enforcement disable, exact original restoration, and clean reattach.

Live TUI menu:

```sh
flab tui <slug> --device <selector>
flab tui <slug> --host <host:port>
```

Confirm:

1. The selected device and process are visible and correct.
2. Instrument shows every descriptor with a useful category, label, signature,
   effect, return type, docs, and truthful argument controls.
3. Analysis contains read-only actions only.
4. Advanced-console tab completion includes every action.
5. Mode switches do not detach the session.
6. Record exposes only Plan, Record, and Stop + summarize; one bounded scenario
   persists truthful event counts, dropped counts, summary, and artifact paths.
7. At least one applicable input, checkbox, slider, and select is exercised;
   applying a mutation refreshes its linked state pane and reset updates it.

Live ACP/MCP and Agent Control API:

```sh
flab acp detect --json
flab mcp
flab agent --json
```

When an ACP upstream is installed, verify its `initialize` and session setup
preserve upstream fields while adding exactly one flab MCP server. Verify the
MCP server lists only the generic `flab_control` and `flab_events` tools plus
its capabilities resource and build prompt. Authorize first, then exercise
`instrument.source.read`, `module.list`, Record, build, `verify.static`,
`session.open`, `session.describe`, every shipped `session.action`,
`session.close`, and `instrument.package`. Verify the resolved device and PID
from responses rather than assuming the request succeeded.

Selected-session compatibility protocol:

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

Windows Steam compatibility sweep (owned offline installs only):

```powershell
$env:FLAB_STEAM_E2E_AUTHORIZATION = "owned-offline"
bun run test:steam-e2e
```

Run it in the logged-in interactive Windows desktop session; an SSH service
session cannot inject into desktop games. The harness discovers installed Steam
manifests, launches one game at a time, protects pre-existing processes, skips
public/anti-cheat titles, checks the generic probe and registered target
contracts, cleans up, reattaches, and writes
`artifacts/windows-steam-qa/report.json`. Use
`FLAB_STEAM_E2E_INCLUDE=appid,appid` for a bounded retry. This is a main-menu
compatibility sweep, not proof of gameplay semantics; feature completion still
requires the scenario matrix above.

### Phase 6: cleanup, reattach, and report

1. Call the target's reset/dispose action and `instrumentStopAll` when exposed.
2. Close the session and confirm the game remains responsive.
3. Reattach once and verify `modState()` starts clean with no duplicate hooks.
4. Test process restart or respawn when the target supports spawn.
5. Finalize `artifacts/<slug>/semantic-model.json`; every `confirmed` row must
   cite a bounded experiment or verification receipt.
6. Store bounded runtime receipts under `artifacts/<slug>/verification.json`.
7. Write `agent/targets/<slug>/README.md` with copy-paste commands for local,
   USB/exact-device, and remote endpoint use; feature examples; the coverage
   and semantic matrices; assist activation and safety behavior; cleanup;
   tested build/device; and limitations.
8. Run `flab package <slug> --json` and record the package path, SHA-256, and
   internal integrity digest.

## Definition of done

- [ ] Exact device and process identity recorded.
- [ ] Recon covers every subsystem category or marks it unsupported.
- [ ] Objective/win-loss, reward, economy, persistence, entity, and assist
      semantics are recorded in `semantic-model.json` with evidence/confidence.
- [ ] Target registered and imports only from `agent/lib/`.
- [ ] `modInfo`, `modState`, and cleanup are real, not stubs; help is generated
      from descriptors and no target-local `modHelp()` boilerplate exists.
- [ ] Core gameplay/progression actions dominate the menu; generic FPS/QoL is secondary.
- [ ] Applicable aim assist, ESP/awareness, movement, accessibility, and training
      candidates are shipped and live-verified or explicitly marked unsupported.
- [ ] Every callable has truthful descriptor metadata.
- [ ] TUI presents Connect → Analyze → Instrument, with no more than three
      visible selectable options, actions, or form fields at a time; applicable
      input, checkbox, slider, select, and linked state controls work.
- [ ] Analyze → Record exposes Plan, Record, and Stop + summarize; any captured
      scenario is bounded, persisted, summarized, and cited as evidence.
- [ ] Advanced-console help, discovery, tab completion, and calls work.
- [ ] Persistent NDJSON control works on the same device.
- [ ] ACP discovery/gateway and direct MCP expose the same generic control and
      cursor-event boundary without TUI scraping or vendor-specific operations.
- [ ] Global Agent API can read/write source with optimistic hashes, link a
      reusable module, build, verify, clean up, and package the Instrument.
- [ ] Every mutation has a tested reset/disable path.
- [ ] Continuous assists are default-off, engagement-gated, bounded, explicitly
      offline-confirmed, cleanly removable, and contain no auto-fire.
- [ ] Build, typecheck, depcheck, and tests pass.
- [ ] Live attach/spawn, actions, cleanup, and reattach are evidenced.
- [ ] Target-local usage and coverage guide is complete.

If the game or device is unavailable, finish only what can be proven and state
`LIVE VERIFICATION BLOCKED` with the exact missing process, device, scene,
permission, or user action. Never convert a compile result into a runtime claim.
