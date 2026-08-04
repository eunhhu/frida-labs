// Phase C gate harness (non-UI layer): multi-session attach/switch/reconnect
// through the workbench + store flood behavior. Run:
//   /tmp/flab-sleeper &  →  bun /tmp/tui-multi.ts
import { store } from "/Users/sunwoo/work/frida-labs/src/tui/store.js";
import { workbench } from "/Users/sunwoo/work/frida-labs/src/tui/workbench.js";

const ENTRY = "agent/targets/_probe/index.ts";
const PROC = "flab-sleeper";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function waitStatus(id: number, want: string[], ms = 30000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const s = store.session(id);
    if (s && want.includes(s.status)) return;
    if (s?.status === "error") fail(`session ${id} errored: ${s.detail}`);
    if (Date.now() - t0 > ms) fail(`timeout waiting for ${want.join("/")} (have ${s?.status})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 1. attach two live sessions to the same process (multi-session)
workbench.attach(ENTRY, PROC);
const s1 = store.snapshot.sessions[0] ?? fail("no session registered");
await waitStatus(s1.id, ["live"]);
console.log(`PASS attach #${s1.id} live pid=${s1.pid}`);

workbench.attach(ENTRY, PROC);
const s2 = store.snapshot.sessions.find((s) => s.id !== s1.id) ?? fail("second session missing");
await waitStatus(s2.id, ["live"]);
console.log(`PASS attach #${s2.id} live pid=${s2.pid}`);

// 2. switch active
store.setActive(s1.id);
if (store.snapshot.activeId !== s1.id) fail("setActive did not switch");
console.log(`PASS switch active -> #${s1.id}`);

// 3. rpc through the workbench handle (attach→rpc path)
const engines = (await workbench.handle(s1.id)!.eval("await engines()")) as unknown[];
if (!Array.isArray(engines)) fail("engines() did not return an array");
console.log(`PASS rpc engines() -> ${JSON.stringify(engines)}`);

// 4. describe cache populated (explorer data path)
await waitStatus(s1.id, ["live"]);
const d1 = store.session(s1.id)!.describe;
if (!Array.isArray(d1) || d1.length === 0) fail("describe cache empty");
console.log(`PASS describe cached (${d1.length} exports)`);

// 5. close + reconnect the second session
await workbench.close(s2.id);
if (store.session(s2.id)!.status !== "closed") fail("close did not mark closed");
workbench.reconnect(s2.id);
await waitStatus(s2.id, ["live"]);
console.log(`PASS reconnect #${s2.id} live again`);

// 6. flood: 10k log lines synchronously — ring must cap at 5000, batch flush
const t0 = Date.now();
for (let i = 0; i < 10000; i++) store.pushLog(s1.id, `flood ${i}`);
store.flush();
const s1f = store.session(s1.id)!;
if (s1f.logs.length !== 5000) fail(`ring expected 5000, have ${s1f.logs.length}`);
if (s1f.dropped < 5000) fail(`dropped expected >=5000, have ${s1f.dropped}`);
if (s1f.logs[s1f.logs.length - 1]!.text !== "flood 9999") fail("ring tail is not the newest line");
console.log(`PASS flood 10000 -> ring=5000 dropped>=5000 tail-newest in ${Date.now() - t0}ms (no per-line notify)`);

// 7. structured crash event path
store.pushEvent(s1.id, { type: "crash", report: { type: "access-violation", pc: "0x0" } });
store.flush();
if (store.session(s1.id)!.crashes.length !== 1) fail("crash event not collected");
console.log("PASS crash event -> crashes[1]");

// 8. observe-layer primitives: level classify + freeze toggle
const { classify } = await import("/Users/sunwoo/work/frida-labs/src/tui/store.js");
if (classify("[agent] [+] ok line", false).level !== "ok") fail("classify +");
if (classify("[agent] [!] w", false).level !== "warn") fail("classify !");
if (classify("[agent] [x] e", false).level !== "error") fail("classify x");
if (classify("[agent] plain", true).level !== "error") fail("classify err");
store.toggleFrozen(s1.id);
if (!store.session(s1.id)!.frozen) fail("freeze on");
store.toggleFrozen(s1.id);
if (store.session(s1.id)!.frozen) fail("freeze off");
console.log("PASS classify 4-level + freeze toggle");

// 9. close-during-attach must not resurrect (architect HIGH finding)
workbench.attach(ENTRY, PROC);
const s3 = store.snapshot.sessions[store.snapshot.sessions.length - 1] ?? fail("third session missing");
await workbench.close(s3.id); // joins the in-flight launch
await new Promise((r) => setTimeout(r, 500));
const s3f = store.session(s3.id);
if (!s3f) fail("closed session vanished unexpectedly");
if (s3f.status === "live") fail("closed session resurrected as live");
if (workbench.handle(s3.id)) fail("late handle escaped closure");
console.log("PASS close-during-attach: no resurrection, no handle leak");

// 10. removeSession frees the cap slot
store.removeSession(s3.id);
if (store.session(s3.id)) fail("removeSession did not remove");
console.log("PASS removeSession frees slot");

await workbench.closeAll();
console.log("ALL PASS");
process.exit(0);
