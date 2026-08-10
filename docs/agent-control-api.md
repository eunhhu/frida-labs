# Agent Control API

`flab.control.v1` is the vendor-neutral automation boundary for frida-labs.
ACP and MCP expose that same boundary to general-purpose coding agents. It
covers the complete workspace flow before, during, and after a live session:

```text
authorize → connect → analyze → author/link → build → verify → package
```

The human TUI and every agent transport share `src/core/` services. An agent must not
scrape the TUI, synthesize key presses, edit `frida-labs.json` independently,
or treat compilation as runtime proof.

## Pick one agent transport

| Agent environment | Start | Purpose |
| --- | --- | --- |
| ACP client such as Zed | `flab acp` | Transparent ACP gateway that injects the flab MCP server into every session |
| MCP-capable harness | `flab mcp` | Direct stdio MCP server with flab tools, events, resources, and prompts |
| Any process that can exchange NDJSON | `flab agent --json` | Direct `flab.control.v1` compatibility transport |

ACP is the client-to-agent session protocol; it is not the flab tool protocol.
The gateway leaves upstream ACP messages intact and adds flab as an MCP server
in `session/new`, `session/load`, and `session/resume`. The upstream coding
agent therefore receives the same two MCP tools regardless of vendor:

- `flab_control` sends one typed `flab.control.v1` operation.
- `flab_events` reads bounded asynchronous session events by cursor.

The MCP server also publishes `flab://capabilities` and a `build-instrument`
prompt. Tool results, authorization, device identity, receipts, and cleanup
rules remain identical to direct control.

## ACP discovery and gateway

List compatible local upstream agents without launching them:

```sh
flab acp detect --json
```

flab recognizes installed `codex-acp`, `claude-agent-acp`, `opencode acp`, and
`gemini --acp` entry points. It also accepts `FLAB_ACP_UPSTREAM` or an explicit
JSON command array. If exactly one agent is found, `flab acp` selects it. If
several are found, choose one explicitly:

```sh
flab acp --upstream opencode
flab acp --upstream '["codex-acp"]'
```

The gateway speaks ACP v1 as newline-delimited JSON-RPC on stdin/stdout. Its
stdout stays protocol-only; selection and diagnostics use stderr. Unknown ACP
methods and notifications pass through, so a newer upstream can extend its
surface without a matching flab release. During `initialize`, flab also records
the ACP client's declared name and version for diagnostics.

Local discovery is deliberately executable-based. Registry discovery becomes
appropriate only after a distributable agent entry is published; flab does not
pretend that a private checkout is registered globally.

GJC 0.11.2 exposes `--mode=acp`, but its SDK-backed ACP rejects session-supplied
MCP servers. flab therefore does not advertise it as a compatible ACP upstream.
Use GJC's standalone `--mcp-config` mode with the repository `.mcp.json`
instead; this preserves the same `flab_control` and `flab_events` boundary.

### Zed custom agent

In Zed, open Agent Settings → External Agents → Add Custom Agent, then point one
`agent_servers` entry at a compiled flab binary:

```json
{
  "agent_servers": {
    "flab": {
      "type": "custom",
      "command": "/absolute/path/to/flab",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

For repository development, use `bun` as `command` and
`["/absolute/path/to/frida-labs/src/bin.ts", "acp"]` as `args`. flab then
selects the only installed ACP upstream; set `FLAB_ACP_UPSTREAM` to a JSON
command array in `env` when the machine has several agents. Zed remains the ACP
client, the selected coding harness remains the upstream ACP agent, and flab
provides the injected MCP tools.

See Zed's [External Agents documentation](https://zed.dev/docs/ai/external-agents)
for the current custom-agent settings and ACP log viewer.

## Start the control process

```sh
bun run flab -- agent --json
```

The first stdout line is a `ready` envelope. Afterwards stdin and stdout use
one JSON object per line. Session diagnostics and log text use stderr.
Structured crash, detach, and Agent payload events may appear between responses;
correlate responses by `id` instead of assuming one output line per request.
Discover the exact contract at runtime:

```json
{"id":"cap","op":"capabilities"}
```

The older `flab.ndjson.v1` protocol remains available for a single already
selected live target. New automation should use `flab.control.v1` because it
also owns Instrument authoring, module linking, verification, and packaging.

## Authorization profile

Device discovery, process inspection, mutation, live attach/spawn, build, and
packaging require an authorization profile. The profile is evidence about the
environment, not a prompt slogan. Saying only “educational” is insufficient.

Owned offline example:

```json
{"id":"auth","op":"authorize","profile":{"purpose":"mod-development","objective":"Analyze and build an Instrument for my locally owned test game","environment":"owned-offline","ownership":{"clientOwned":true,"operatorApproved":true},"isolation":{"publicMatchmaking":false,"publicLeaderboard":false,"productionEconomy":false,"thirdPartyAccounts":false},"antiCheat":"absent"}}
```

Private-lab example:

```json
{"id":"auth","op":"authorize","profile":{"purpose":"qa","objective":"Verify an Instrument on our isolated private test server","environment":"private-lab","ownership":{"clientOwned":true,"serverOwned":true,"operatorApproved":true,"participantsConsented":true},"isolation":{"publicMatchmaking":false,"publicLeaderboard":false,"productionEconomy":false,"thirdPartyAccounts":false},"antiCheat":"officially-disabled"}}
```

A private lab means the client and server are owned or explicitly authorized,
every participant consents, public matchmaking and leaderboards are absent,
production economies and third-party accounts are disconnected, and anti-cheat
is absent or disabled through an official test configuration. Anti-cheat bypass
is not a supported mode.

## End-to-end sequence

List devices and processes on one invariant selector:

```json
{"id":"devices","op":"device.list"}
{"id":"processes","op":"process.list","query":"Game","limit":50,"device":{"kind":"local"}}
```

Create and author an Instrument:

```json
{"id":"create","op":"instrument.create","draft":{"name":"my-game","process":"Game.exe","mode":"attach","device":{"kind":"local"}}}
{"id":"source","op":"instrument.source.read","name":"my-game"}
{"id":"modules","op":"module.list"}
{"id":"link","op":"module.link","name":"my-game","module":"assist","expectedSha256":"<source sha256>"}
{"id":"write","op":"instrument.source.write","name":"my-game","expectedSha256":"<new sha256>","text":"<complete TypeScript entry>"}
```

`instrument.source.write` and `module.link` support optimistic concurrency.
Always read first and pass `expectedSha256`; a stale write fails instead of
overwriting another human or agent.

Build and check the shared dependency boundary:

```json
{"id":"build","op":"instrument.build","name":"my-game"}
{"id":"verify","op":"verify.static"}
```

Open one live session and use the same descriptor authorization as the TUI:

```json
{"id":"open","op":"session.open","launch":{"kind":"target","target":"my-game","device":{"kind":"local"}}}
{"id":"describe","op":"session.describe"}
{"id":"analyze","op":"session.action","mode":"analysis","action":"entities","args":[],"offset":0}
{"id":"instrument","op":"session.action","mode":"instrument","action":"movementProfileSet","args":["accessibility"],"offset":0}
{"id":"session-close","op":"session.close"}
```

Analysis remains read-only. Writes, controls, and hooks require an Instrument or
Debug capability declared by the live descriptor. Results are bounded action
receipts; cached or forged descriptors do not grant authority.

Each argument may also carry vendor-neutral human UI metadata. `control` is one
of `input`, `checkbox`, `slider`, or `select`; sliders include finite
`min`/`max`/`step`, and selects include bounded typed `{label,value}` options.
Agents should preserve this metadata when authoring source because the human TUI
uses it for forms and linked `statusAction` state, but agents still call the
stable action name with positional typed arguments. flab generates console help
from this schema. Target source should use `defineInstrument()` and `field.*` so
RPC handlers, descriptors, widgets, and help come from one declaration; targets
do not need parallel descriptor arrays or a `modHelp()` action.

Create a distributable artifact after static and live verification:

```json
{"id":"package","op":"instrument.package","name":"my-game","out":"dist/instruments/my-game.flab.json"}
{"id":"close","op":"close"}
```

The package contains registered metadata, editable entry source, a self-contained
Frida bundle, and SHA-256 integrity data. Package creation is local; publishing
to an external registry remains an explicit deployment step.

## Human-play analysis Record

Visual inspection alone is weak evidence for a non-multimodal agent. Record
turns one short human playthrough into bounded runtime evidence: selected native
function entry/exit timing, thread id, raw arguments, return value, duration,
and optional symbolized backtraces. It records only explicitly selected probes,
not every function in the process.

Use a generic probe session during recon, then follow this sequence:

```json
{"id":"plan","op":"record.plan","query":"damage","module":"GameAssembly.dll","limit":20}
{"id":"start","op":"record.start","label":"take one hit","probes":[{"name":"ApplyDamage","address":"0x1234","args":3}],"options":{"maxDurationMs":60000,"maxEvents":20000}}
{"id":"status","op":"record.status"}
{"id":"stop","op":"record.stop"}
{"id":"summary","op":"record.summary","recordId":"<returned record id>"}
{"id":"page","op":"record.read","recordId":"<returned record id>","cursor":0,"limit":200}
```

After `record.start`, the human performs exactly one named scenario in the
game. `record.stop` persists metadata and JSONL events under
`artifacts/records/`; `record.summary` aggregates hot functions, durations,
threads, sampled values, and common function transitions. Pages and summaries
are bounded so an agent never needs the whole trace in context. Capture stops
automatically at its duration/event/byte limits, on detach, or before session
cleanup. Dropped events are reported rather than hidden. `record.status`
returns the finalized metadata in `completed` after an automatic stop.

The common Record surface is included in the generic probe, current saved
Instruments, and the new-Instrument scaffold, so Analyze → Record does not
depend on a game-specific implementation.

Record supplies causal runtime evidence; it does not infer visual-only state.
Use screenshots or human notes alongside it when color, geometry, animation,
or other screen-only meaning matters.

## Model and harness adapters

ACP/MCP adapters for Codex, Claude Code, GJC, OpenCode, or another coding model
should only translate transport and tool syntax. They must preserve the same operation
names, authorization profile, device identity, receipts, and completion gates.

To reduce false refusals across model vendors:

1. Send the concrete authorization profile and task objective before technical
   requests. Do not rely on “educational use” alone.
2. Start with device identity and read-only analysis. Request mutations only
   after evidence identifies the correct local path and cleanup strategy.
3. Split work into bounded phases with receipts: recon, source change, static
   verification, live verification, cleanup, package.
4. Keep private-lab facts explicit: ownership, consent, isolation, and officially
   disabled or absent anti-cheat.
5. If one model still refuses an allowed step, preserve artifacts and route that
   bounded step to another configured model or a human reviewer. Never use prompt
   injection, policy impersonation, hidden instructions, or guardrail disabling.

This strategy is model-agnostic: models may differ in policy, but the task
envelope and technical API do not.

## Operation groups

| Group | Operations |
| --- | --- |
| Workspace | `ping`, `capabilities`, `authorize`, `workspace.describe` |
| Connect | `device.list`, `process.list`, `session.open`, `session.close` |
| Analyze | `session.describe`, `session.action` in `analysis`, `module.list` |
| Record | `record.plan/start/status/stop/list/read/summary` |
| Author | `instrument.list/create/update/rename/unregister/delete`, `instrument.source.read/write`, `module.link` |
| Deliver | `instrument.build`, `verify.static`, `instrument.package`, `close` |

Project mutations remain transactional. Source writes are bounded and
compare-and-swap protected. Session cleanup calls advertised `dispose()` and
`instrumentStopAll()` before unload, then a clean reattach is required for live
completion claims.
