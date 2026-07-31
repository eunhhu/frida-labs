// =====================================================================
//  MECCHA CHAMELEON (PenguinHotel-Win64-Shipping) — UE5 modding toolkit
//  For a PRIVATE / self-controlled server + modding use only.
//  Frida script: auto-discovers UE reflection globals (addresses change
//  every launch), then exposes an ESP data engine + a movement trainer.
//
//  Load:  frida -n PenguinHotel-Win64-Shipping.exe -l cleon_toolkit.js
//  Then in the REPL:  esp() , trainer.apply({walk:1200}) , trainer.fly(true)
// =====================================================================

const MOD = Process.getModuleByName('PenguinHotel-Win64-Shipping.exe');
const LO = MOD.base, HI = MOD.base.add(MOD.size);

const rP  = p => { try { return p && !p.isNull() ? p.readPointer() : null; } catch (e) { return null; } };
const rU16 = p => { try { return p.readU16(); } catch (e) { return null; } };
const rU32 = p => { try { return p.readU32(); } catch (e) { return null; } };
const rF  = p => { try { return p.readFloat(); } catch (e) { return null; } };
const rD  = p => { try { return p.readDouble(); } catch (e) { return null; } };
const inModule = p => p && p.compare(LO) >= 0 && p.compare(HI) < 0;

// ---- object / field offsets (confirmed for this build) -------------
const O_CLASS = 0x10, O_NAME = 0x18, O_OUTER = 0x20;   // UObjectBase
const O_SUPER = 0x40, O_CHILDREN = 0x48, O_CHILDPROPS = 0x50, O_PROPSIZE = 0x58; // UStruct
const F_NEXT = 0x18, F_NAME = 0x20, F_OFFSET = 0x44;   // FField / FProperty
const C2W = 0x1e0, C2W_T = 0x200;                      // USceneComponent.ComponentToWorld (+translation)
const CTRL_PAWN = 0x2e8;                               // AController.Pawn

// ---- discover GUObjectArray (FChunkedFixedUObjectArray) ------------
function findObjArray() {
  const EPC = 65536;
  for (const rg of Process.enumerateRanges('rw-').filter(r => r.base.compare(LO) >= 0 && r.base.compare(HI) < 0)) {
    let a = rg.base; const end = rg.base.add(rg.size).sub(0x20);
    while (a.compare(end) < 0) {
      const objects = rP(a);
      if (objects && !objects.isNull()) {
        const maxE = rU32(a.add(0x10)), numE = rU32(a.add(0x14)), maxC = rU32(a.add(0x18)), numC = rU32(a.add(0x1c));
        if (maxE && numE && maxC && numC && maxC <= 4096 && maxE === maxC * EPC &&
            numE > 0 && numE <= maxE && numC >= 1 && numC <= maxC && numC === Math.ceil(numE / EPC)) {
          const c0 = rP(objects); const o0 = c0 && rP(c0); const vt = o0 && rP(o0);
          if (vt && inModule(vt)) return { objects, num: numE };
        }
      }
      a = a.add(8);
    }
  }
  throw new Error('GUObjectArray not found');
}

// ---- discover GNames (FNamePool block array) ----------------------
function findNames() {
  const decodeNone = blk => {
    const h = rU16(blk); if (h == null) return false;
    const len = (h >> 6) & 0x3ff;
    if (h & 1) return false;
    let s = null; try { s = blk.add(2).readUtf8String(len); } catch (e) {}
    return s === 'None';
  };
  for (const rg of Process.enumerateRanges('rw-').filter(r => r.base.compare(LO) >= 0 && r.base.compare(HI) < 0)) {
    let a = rg.base.add(8); const end = rg.base.add(rg.size).sub(0x220);
    while (a.compare(end) < 0) {
      const cb = rU32(a.sub(8));
      if (cb !== null && cb >= 1 && cb <= 64) {
        const cursor = rU32(a.sub(4));
        if (cursor !== null && cursor > 0 && cursor <= 131072) {
          const b0 = rP(a);
          if (b0 && !inModule(b0) && decodeNone(b0)) {
            let ok = true; for (let i = 0; i <= cb; i++) if (!rP(a.add(i * 8))) { ok = false; break; }
            if (ok) return a;
          }
        }
      }
      a = a.add(8);
    }
  }
  throw new Error('GNames not found');
}

// ---- reflection core ----------------------------------------------
const OA = findObjArray();
const BLOCKS = findNames();

function resolveId(id) {
  const bp = rP(BLOCKS.add((id >>> 16) * 8)); if (!bp) return null;
  const e = bp.add((id & 0xffff) * 2); const h = rU16(e); if (h == null) return null;
  const len = (h >> 6) & 0x3ff;
  try { return (h & 1) ? e.add(2).readUtf16String(len) : e.add(2).readUtf8String(len); } catch (x) { return null; }
}
function fname(p) { const id = rU32(p), num = rU32(p.add(4)); let s = resolveId(id); if (s && num) s += '_' + (num - 1); return s; }
function objAt(i) { const c = rP(OA.objects.add((i >>> 16) * 8)); return c ? rP(c.add((i & 0xffff) * 24)) : null; }
function nameOf(o)      { return o ? fname(o.add(O_NAME)) : null; }
function classOf(o)     { return o ? rP(o.add(O_CLASS)) : null; }
function classNameOf(o) { const c = classOf(o); return c ? nameOf(c) : null; }
function outerOf(o)     { const p = rP(o.add(O_OUTER)); return (p && !p.isNull()) ? p : null; }
function superOf(c)     { const p = rP(c.add(O_SUPER)); return (p && !p.isNull()) ? p : null; }
function isA(o, target) { let c = classOf(o), g = 0; while (c && g++ < 40) { if (nameOf(c) === target) return true; c = superOf(c); } return false; }
function propOff(o, name) {
  let c = classOf(o);
  for (let g = 0; g < 30 && c; g++) {
    let f = rP(c.add(O_CHILDPROPS));
    for (let k = 0; k < 600 && f && !f.isNull(); k++) { if (fname(f.add(F_NAME)) === name) return rU32(f.add(F_OFFSET)); f = rP(f.add(F_NEXT)); }
    c = superOf(c);
  }
  return null;
}
function rootComp(actor) {
  for (let x = 0x150; x < 0x400; x += 8) { const v = rP(actor.add(x)); if (v) { try { if (isA(v, 'SceneComponent')) return v; } catch (e) {} } }
  return null;
}
function worldLoc(actor) { const c = rootComp(actor); if (!c) return null; return [rD(c.add(C2W_T)), rD(c.add(C2W_T + 8)), rD(c.add(C2W_T + 16))]; }
function childOfType(actor, type, span) {
  span = span || 0x600;
  for (let x = 0; x < span; x += 8) { const v = rP(actor.add(x)); if (v) { try { if (isA(v, type)) return v; } catch (e) {} } }
  return null;
}
function localPC() { for (let i = 0; i < OA.num; i++) { const o = objAt(i); if (o && isA(o, 'PlayerController') && !(nameOf(o) || '').startsWith('Default__')) return o; } return null; }

// ---- entity scan ---------------------------------------------------
const ENEMY_RE = /Hunter|Survivor|BigPen|AI_Base/;
function entities() {
  const out = [];
  for (let i = 0; i < OA.num; i++) {
    const o = objAt(i); if (!o) continue;
    const cn = classNameOf(o) || ''; if (!ENEMY_RE.test(cn)) continue;
    if ((nameOf(o) || '').startsWith('Default__') || !isA(o, 'Pawn')) continue;
    const wp = worldLoc(o); if (!wp || wp[0] == null || (!wp[0] && !wp[1])) continue;
    out.push({ obj: o, cls: cn, role: /Hunter|BigPen/.test(cn) ? 'HUNTER' : 'SURVIVOR', loc: wp });
  }
  return out;
}

// ---- camera + world-to-screen -------------------------------------
function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function viewState(W, H) {
  const pc = localPC(); if (!pc) return null;
  const pawn = rP(pc.add(CTRL_PAWN)); if (!pawn) return null;
  const cam = childOfType(pawn, 'CameraComponent'); if (!cam) return null;
  const q = [rD(cam.add(C2W)), rD(cam.add(C2W + 8)), rD(cam.add(C2W + 16)), rD(cam.add(C2W + 24))];
  const t = [rD(cam.add(C2W_T)), rD(cam.add(C2W_T + 8)), rD(cam.add(C2W_T + 16))];
  const fovOff = propOff(cam, 'FieldOfView'); const fov = fovOff != null ? rF(cam.add(fovOff)) : 90;
  const fwd = qrot(q, [1, 0, 0]), right = qrot(q, [0, 1, 0]), up = qrot(q, [0, 0, 1]);
  const focal = (W / 2) / Math.tan(fov * Math.PI / 360);
  return { t, fwd, right, up, focal, W, H, fov, pawnCls: classNameOf(pawn) };
}
function w2s(view, wp) {
  const d = [wp[0] - view.t[0], wp[1] - view.t[1], wp[2] - view.t[2]];
  const depth = d[0] * view.fwd[0] + d[1] * view.fwd[1] + d[2] * view.fwd[2];
  if (depth <= 1) return null;
  const rx = d[0] * view.right[0] + d[1] * view.right[1] + d[2] * view.right[2];
  const ry = d[0] * view.up[0] + d[1] * view.up[1] + d[2] * view.up[2];
  return { x: Math.round(view.W / 2 + rx / depth * view.focal), y: Math.round(view.H / 2 - ry / depth * view.focal), depth: depth };
}

// ---- ESP: one-shot snapshot of on/off-screen enemies --------------
function esp(W, H) {
  W = W || 1920; H = H || 1080;
  const view = viewState(W, H); if (!view) return '[esp] no local view camera (in menu?)';
  const rows = entities().map(e => {
    const s = w2s(view, e.loc);
    const dist = Math.round(Math.hypot(e.loc[0] - view.t[0], e.loc[1] - view.t[1], e.loc[2] - view.t[2]) / 100);
    const onscr = s && s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H;
    return { role: e.role, cls: e.cls.replace('BP_FirstPersonCharacter_cLeon_Character_', '').slice(0, 28),
             screen: s ? (onscr ? `(${s.x},${s.y})` : 'off-screen') : 'behind', dist_m: dist };
  }).sort((a, b) => a.dist_m - b.dist_m);
  console.log(`\n[ESP] view=${view.pawnCls} fov=${view.fov}  enemies=${rows.length}`);
  rows.forEach(r => console.log(`  ${r.role.padEnd(8)} ${String(r.dist_m + 'm').padEnd(6)} ${r.screen.padEnd(12)} ${r.cls}`));
  return rows;
}

// live ESP loop (prints every intervalMs); espStop() to cancel
let _espTimer = null;
function espLoop(intervalMs, W, H) { espStop(); _espTimer = setInterval(() => esp(W, H), intervalMs || 500); return '[esp] loop started'; }
function espStop() { if (_espTimer) { clearInterval(_espTimer); _espTimer = null; } return '[esp] loop stopped'; }

// ---- movement trainer ---------------------------------------------
// Resolves the LOCAL character's movement component each call, so it
// survives respawns/round changes. Writes are re-applied by enforce().
const MOVE_KEYS = {
  walk: 'MaxWalkSpeed', crouch: 'MaxWalkSpeedCrouched', accel: 'MaxAcceleration',
  jump: 'JumpZVelocity', gravity: 'GravityScale', air: 'AirControl',
  fly: 'MaxFlySpeed', custom: 'MaxCustomMovementSpeed', friction: 'GroundFriction',
  brake: 'BrakingDecelerationWalking',
};
function localMoveComp() {
  const pc = localPC(); if (!pc) return null;
  const pawn = rP(pc.add(CTRL_PAWN)); if (!pawn) return null;
  return childOfType(pawn, 'CharacterMovementComponent') || childOfType(pawn, 'PawnMovementComponent');
}
function setF(obj, name, v) { const off = propOff(obj, name); if (off == null) return false; try { obj.add(off).writeFloat(v); return true; } catch (e) { return false; } }
function getF(obj, name) { const off = propOff(obj, name); return off == null ? null : rF(obj.add(off)); }

let _wanted = {};       // {MoveKey: value}
let _enforce = null;
const trainer = {
  read() {
    const mc = localMoveComp(); if (!mc) return '[trainer] no local movement component (spawn a character first)';
    const r = {}; for (const k in MOVE_KEYS) r[k] = getF(mc, MOVE_KEYS[k]); r._comp = classNameOf(mc); return r;
  },
  apply(opts) {                       // e.g. trainer.apply({walk:1200, jump:900, gravity:0.5, air:1})
    const mc = localMoveComp(); if (!mc) return '[trainer] no local movement component';
    const done = {};
    for (const k in opts) { const p = MOVE_KEYS[k]; if (p) { _wanted[p] = opts[k]; done[k] = setF(mc, p, opts[k]); } }
    return done;
  },
  fly(on) {                           // toggle flying MovementMode (5 = MOVE_Flying, 1 = MOVE_Walking)
    const mc = localMoveComp(); if (!mc) return '[trainer] no local movement component';
    const off = propOff(mc, 'MovementMode'); if (off == null) return '[trainer] MovementMode not found';
    try { mc.add(off).writeU8(on ? 5 : 1); return `[trainer] fly=${!!on}`; } catch (e) { return '[trainer] write failed'; }
  },
  enforce(on, intervalMs) {           // continuously re-apply _wanted (defeats server/anim resets, respawns)
    if (_enforce) { clearInterval(_enforce); _enforce = null; }
    if (on) _enforce = setInterval(() => { const mc = localMoveComp(); if (mc) for (const p in _wanted) setF(mc, p, _wanted[p]); }, intervalMs || 250);
    return `[trainer] enforce=${!!on}`;
  },
  reset() {                           // restore stock UE defaults
    _wanted = {}; this.enforce(false);
    return this.apply({ walk: 600, crouch: 300, accel: 2048, jump: 420, gravity: 1, air: 0.05, fly: 600, custom: 600, friction: 8, brake: 2048 });
  },
};

// =====================================================================
//  IN-GAME ESP OVERLAY (option A) — AHUD::PostRender hook + K2_DrawBox
//  Draws colored boxes over Hunters/Survivors on the real game screen.
//  Requires calling UFunctions => needs UObject::ProcessEvent, found at
//  runtime. Heavy discovery runs once; per-frame work is minimal.
// =====================================================================
const HUD_CANVAS = 0x2f8;   // AHUD.Canvas (UCanvas*), valid during PostRender

function findClass(name) { for (let i = 0; i < OA.num; i++) { const o = objAt(i); if (o && classNameOf(o) === 'Class' && nameOf(o) === name) return o; } return null; }
function findFunc(cls, name) { let f = rP(cls.add(O_CHILDREN)); for (let k = 0; k < 5000 && f && !f.isNull(); k++) { if (classNameOf(f) === 'Function' && nameOf(f) === name) return f; f = rP(f.add(0x28)); } return null; }
function firstInstance(pred) { for (let i = 0; i < OA.num; i++) { const o = objAt(i); if (o && !(nameOf(o) || '').startsWith('Default__')) { try { if (pred(o)) return o; } catch (e) {} } } return null; }

// Runtime-probe UObject::ProcessEvent: the shared vtable slot invoked with a UFunction as arg2.
function findProcessEvent(ms) {
  return new Promise(res => {
    const vts = [], seen = new Set();
    for (let i = 0; i < OA.num && vts.length < 250; i += Math.max(1, (OA.num / 2500) | 0)) { const o = objAt(i); if (!o) continue; const vt = rP(o); if (vt && inModule(vt) && !seen.has(vt.toString())) { seen.add(vt.toString()); vts.push(vt); } }
    const cand = [];
    for (let s = 50; s < 90; s++) { const freq = {}; for (const vt of vts) { const p = rP(vt.add(s * 8)); if (p && inModule(p)) freq[p.toString()] = (freq[p.toString()] || 0) + 1; } let best = null, bc = 0; for (const k in freq) if (freq[k] > bc) { bc = freq[k]; best = k; } if (best && bc >= vts.length * 0.7) cand.push([s, best]); }
    let hit = null; const hooks = [];
    for (const [slot, hx] of cand) { try { hooks.push(Interceptor.attach(ptr(hx), { onEnter(a) { if (hit) return; const fn = a[1]; if (!fn || fn.isNull()) return; let cn = null; try { cn = classNameOf(fn); } catch (e) { return; } if (cn === 'Function') hit = { slot, addr: hx }; } })); } catch (e) {} }
    setTimeout(() => { hooks.forEach(h => { try { h.detach(); } catch (e) {} }); res(hit); }, ms || 700);
  });
}

// Runtime-probe the HUD PostRender slot: an AHUD vtable override entered with Canvas set.
function findHudRenderSlot(hud, ms) {
  return new Promise(res => {
    const hudVt = rP(hud), actorVt = rP(firstInstance(o => nameOf(o) === 'Default__Actor') || hud);
    const diff = [];
    for (let s = 0; s < 300; s++) { const a = rP(hudVt.add(s * 8)); const b = actorVt && rP(actorVt.add(s * 8)); if (a && inModule(a) && (!b || !a.equals(b))) diff.push(s); }
    const counts = {}, hooks = [];
    for (const s of diff) { const addr = rP(hudVt.add(s * 8)); try { hooks.push(Interceptor.attach(addr, { onEnter(a) { const t = a[0]; if (!t) return; let cv = null; try { cv = rP(t.add(HUD_CANVAS)); } catch (e) { return; } if (cv && !cv.isNull()) counts[s] = (counts[s] || 0) + 1; } })); } catch (e) {} }
    setTimeout(() => { hooks.forEach(h => { try { h.detach(); } catch (e) {} }); let best = null, bc = 0; for (const s in counts) if (counts[s] > bc) { bc = counts[s]; best = +s; } res({ slot: best, vt: hudVt, counts }); }, ms || 800);
  });
}

const overlay = {
  _hook: null, _timer: null, _pe: null, _drawBox: null, _buf: null,
  cache: { cam: null, fovOff: null, clipX: null, clipY: null, enemies: [], hud: null, frames: 0, err: null },
  colors: { HUNTER: [1, 0.1, 0.1], SURVIVOR: [0.1, 1, 0.1] },
  test: false,

  async init() {                         // discover ProcessEvent + K2_DrawBox (once per launch)
    const pe = await findProcessEvent(); if (!pe) return '[overlay] ProcessEvent not found';
    this._pe = new NativeFunction(ptr(pe.addr), 'void', ['pointer', 'pointer', 'pointer']);
    const cc = findClass('Canvas'); this._drawBox = cc && findFunc(cc, 'K2_DrawBox');
    this._buf = Memory.alloc(0x40);
    return `[overlay] ready (ProcessEvent slot ${pe.slot} @${pe.addr}, K2_DrawBox ${this._drawBox ? 'ok' : 'MISSING'})`;
  },
  box(canvas, x, y, w, h, th, r, g, b, a) { const B = this._buf; B.writeDouble(x); B.add(8).writeDouble(y); B.add(0x10).writeDouble(w); B.add(0x18).writeDouble(h); B.add(0x20).writeFloat(th); B.add(0x24).writeFloat(r); B.add(0x28).writeFloat(g); B.add(0x2c).writeFloat(b); B.add(0x30).writeFloat(a); this._pe(canvas, this._drawBox, B); },
  _enemyRe: /Hunter|Survivor|BigPen|AI_Base/, _clsRole: null, _pcCls: null, _rootOff: 0x1b8,
  // One-time: map each enemy/PC CLASS pointer to a role. Lets the per-scan hot loop
  // use a cheap pointer compare instead of FName resolution (critical for fps: Frida's
  // single JS lock means a slow scan stalls the game's render thread).
  _buildMaps() {
    this._clsRole = {}; this._pcCls = null;
    const anyPawn = firstInstance(o => isA(o, 'Pawn')); if (anyPawn) this._rootOff = propOff(anyPawn, 'RootComponent') || 0x1b8;
    for (let i = 0; i < OA.num; i++) { const o = objAt(i); if (!o) continue; const cn = classNameOf(o); if (!cn) continue;
      if (!this._pcCls && cn === 'BP_PlayerController_cLeon_C') { const cp = rP(o.add(O_CLASS)); if (cp) this._pcCls = cp.toString(); }
      if (this._enemyRe.test(cn)) { const cp = rP(o.add(O_CLASS)); if (cp) this._clsRole[cp.toString()] = /Hunter|BigPen/.test(cn) ? 'HUNTER' : 'SURVIVOR'; }
    }
  },
  _refresh() { const c = this.cache; try {
    if (!this._clsRole) this._buildMaps();
    const EPC = 65536, num = OA.num, OBJ = OA.objects, ROOT = this._rootOff, roleMap = this._clsRole, pcCls = this._pcCls;
    let pc = null; const en = [];
    for (let ci = 0; ci < Math.ceil(num / EPC); ci++) { const base = rP(OBJ.add(ci * 8)); if (!base) continue; const cnt = Math.min(EPC, num - ci * EPC);
      for (let j = 0; j < cnt; j++) { const obj = rP(base.add(j * 24)); if (!obj) continue;
        const fl = rU32(obj.add(0x08)); if (fl == null || (fl & 0x30)) continue;        // skip CDO / archetype
        const cp = rP(obj.add(O_CLASS)); if (!cp) continue; const k = cp.toString();
        if (k === pcCls) pc = obj; else { const role = roleMap[k]; if (role) { const r = rP(obj.add(ROOT)); if (r) en.push({ obj: obj.toString(), root: r, role }); } } } }
    let self = null;
    if (pc) { const pawn = rP(pc.add(CTRL_PAWN)); if (pawn) { self = pawn.toString(); c.cam = childOfType(pawn, 'CameraComponent'); if (c.cam && c.fovOff == null) c.fovOff = propOff(c.cam, 'FieldOfView'); } }
    if (c.hud) { const cv = rP(c.hud.add(HUD_CANVAS)); if (cv && c.clipX == null) { c.clipX = propOff(cv, 'ClipX'); c.clipY = propOff(cv, 'ClipY'); } }
    c.enemies = en.filter(e => e.obj !== self);
  } catch (e) { c.err = 'refresh:' + e.message; } },

  async install() {
    if (!this._pe) { const r = await this.init(); if (!this._drawBox) return r; }
    let hud = firstInstance(o => isA(o, 'HUD')); if (!hud) return '[overlay] no HUD instance (enter a match first)';
    this.cache.hud = hud;
    const rs = await findHudRenderSlot(hud); if (rs.slot == null) return '[overlay] PostRender slot not found (HUD not rendering?)';
    const hookAddr = rP(rs.vt.add(rs.slot * 8)); const self = this;
    this._refresh(); this._timer = setInterval(() => self._refresh(), 2000);  // heavy scan off the render path
    this._hook = Interceptor.attach(hookAddr, { onEnter(a) { this.hud = a[0]; }, onLeave() { try {
      const c = self.cache, hud = this.hud, canvas = rP(hud.add(HUD_CANVAS)); if (!canvas) return;
      const W = c.clipX != null ? rF(canvas.add(c.clipX)) : 1920, H = c.clipY != null ? rF(canvas.add(c.clipY)) : 1080;
      c.frames++;
      if (self.test) self.box(canvas, W / 2 - 120, H / 2 - 120, 240, 240, 4, 1, 1, 0, 1);
      const cam = c.cam; if (!cam) return;
      const q = [rD(cam.add(C2W)), rD(cam.add(C2W + 8)), rD(cam.add(C2W + 16)), rD(cam.add(C2W + 24))];
      const t = [rD(cam.add(C2W_T)), rD(cam.add(C2W_T + 8)), rD(cam.add(C2W_T + 16))];
      const fov = c.fovOff != null ? rF(cam.add(c.fovOff)) : 90, focal = (W / 2) / Math.tan(fov * Math.PI / 360);
      const fwd = qrot(q, [1, 0, 0]), right = qrot(q, [0, 1, 0]), up = qrot(q, [0, 0, 1]);
      for (const e of c.enemies) {
        const wp = [rD(e.root.add(C2W_T)), rD(e.root.add(C2W_T + 8)), rD(e.root.add(C2W_T + 16))]; if (wp[0] == null) continue;
        const d = [wp[0] - t[0], wp[1] - t[1], wp[2] - t[2]], depth = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]; if (depth <= 1) continue;
        const sx = W / 2 + (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / depth * focal;
        const sy = H / 2 - (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / depth * focal;
        if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
        const bh = Math.max(8, Math.min(400, 220 * focal / depth)), bw = bh * 0.5, col = self.colors[e.role];
        self.box(canvas, sx - bw / 2, sy - bh / 2, bw, bh, 2, col[0], col[1], col[2], 1);
      }
    } catch (e) { self.cache.err = 'draw:' + e.message; } } });
    return `[overlay] installed @${hookAddr} (PostRender slot ${rs.slot})`;
  },
  remove() { if (this._hook) { this._hook.detach(); this._hook = null; } if (this._timer) { clearInterval(this._timer); this._timer = null; } return '[overlay] removed'; },
  status() { const c = this.cache; return { frames: c.frames, enemies: c.enemies.length, cam: !!c.cam, err: c.err, test: this.test }; },
};

// ---- expose --------------------------------------------------------
globalThis.UE = { OA, BLOCKS, objAt, nameOf, classOf, classNameOf, isA, superOf, outerOf,
                  propOff, worldLoc, rootComp, childOfType, localPC, entities, viewState, w2s, findClass, findFunc };
globalThis.esp = esp; globalThis.espLoop = espLoop; globalThis.espStop = espStop;
globalThis.trainer = trainer; globalThis.overlay = overlay;

console.log(`[cleon] ready. GObjects@${OA.objects} (${OA.num} objects)  GNames@${BLOCKS}`);
console.log('[cleon] ESP:     esp()  |  espLoop(500)  |  espStop()');
console.log('[cleon] Trainer: trainer.read()  |  trainer.apply({walk:1200,jump:900,gravity:0.4,air:1})');
console.log('[cleon]          trainer.fly(true)  |  trainer.enforce(true)  |  trainer.reset()');
console.log('[cleon] Overlay: await overlay.install()  (in a live match)  |  overlay.test=true for a test box');
console.log('[cleon]          overlay.status()  |  overlay.remove()');
