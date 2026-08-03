// MECCHA CHAMELEON (PenguinHotel) — ESP overlay built on the generic UE
// toolkit. Lives in lib so targets depend only on agent/lib; the target's
// index.ts drives it via rpc (espInstall/espSnapshot/…). Game-specific bits
// (class names, roles, colors) are config constants below.

import * as mem from "../mem.js";
import { oa, objAt, classOf, classNameOf, childOfType } from "./reflection.js";
import { CTRL_PAWN, C2W_T, ROOT_COMP, viewFromCamera, worldToScreen } from "./actor.js";
import { UeCanvas } from "./render.js";

const { rP, rD } = mem;

const ENEMY_RE = /Hunter|Survivor|BigPen|AI_Base/;
const PC_CLASS = "BP_PlayerController_cLeon_C";
type Role = "HUNTER" | "SURVIVOR";
const roleOf = (cn: string): Role => (/Hunter|BigPen/.test(cn) ? "HUNTER" : "SURVIVOR");

const COLORS: Record<Role, [number, number, number]> = { HUNTER: [1, 0.1, 0.1], SURVIVOR: [0.1, 1, 0.1] };

interface Enemy { obj: string; root: NativePointer; role: Role; }
interface ClassMap { clsRole: Record<string, Role>; pcCls: string | null; }

// One-time: class pointer -> role, so the per-scan hot loop uses a pointer
// compare instead of FName resolution (keeps the game-thread render fast).
function buildClassMap(): ClassMap {
  const clsRole: Record<string, Role> = {};
  let pcCls: string | null = null;
  for (let i = 0; i < oa().num; i++) {
    const o = objAt(i); if (!o) continue;
    const cn = classNameOf(o); if (!cn) continue;
    if (!pcCls && cn === PC_CLASS) { const cp = classOf(o); if (cp) pcCls = cp.toString(); }
    if (ENEMY_RE.test(cn)) { const cp = classOf(o); if (cp) clsRole[cp.toString()] = roleOf(cn); }
  }
  return { clsRole, pcCls };
}

function scan(map: ClassMap): { enemies: Enemy[]; cam: NativePointer | null } {
  const EPC = 65536, num = oa().num, OBJ = oa().objects;
  let pc: NativePointer | null = null;
  const enemies: Enemy[] = [];
  for (let ci = 0; ci < Math.ceil(num / EPC); ci++) {
    const base = rP(OBJ.add(ci * 8)); if (!base) continue;
    const cnt = Math.min(EPC, num - ci * EPC);
    for (let j = 0; j < cnt; j++) {
      const obj = rP(base.add(j * 24)); if (!obj) continue;
      const fl = obj.add(0x08).readU32(); if (fl & 0x30) continue; // skip CDO/archetype
      const cp = rP(obj.add(0x10)); if (!cp) continue;
      const k = cp.toString();
      if (k === map.pcCls) pc = obj;
      else { const role = map.clsRole[k]; if (role) { const r = rP(obj.add(ROOT_COMP)); if (r) enemies.push({ obj: obj.toString(), root: r, role }); } }
    }
  }
  let self: string | null = null, cam: NativePointer | null = null;
  if (pc) { const pawn = rP(pc.add(CTRL_PAWN)); if (pawn) { self = pawn.toString(); cam = childOfType(pawn, "CameraComponent"); } }
  return { enemies: enemies.filter((e) => e.obj !== self), cam };
}

export class Esp {
  private canvas = new UeCanvas();
  private timer: ReturnType<typeof setInterval> | null = null;
  private map: ClassMap | null = null;
  private cam: NativePointer | null = null;
  private enemies: Enemy[] = [];
  frames = 0;
  test = false;

  private refresh(): void {
    if (!this.map) this.map = buildClassMap();
    const s = scan(this.map);
    this.enemies = s.enemies;
    this.cam = s.cam;
  }

  /** One-shot data snapshot (no drawing) — handy from the host REPL. */
  snapshot(W = 1920, H = 1080): { role: Role; screen: string; dist: number }[] {
    this.refresh();
    const cam = this.cam; if (!cam) return [];
    const view = viewFromCamera(cam, W, H);
    return this.enemies.map((e) => {
      const wp = [rD(e.root.add(C2W_T)), rD(e.root.add(C2W_T + 8)), rD(e.root.add(C2W_T + 16))] as number[];
      const s = worldToScreen(view, wp);
      const dist = Math.round(Math.hypot(wp[0] - view.t[0], wp[1] - view.t[1], wp[2] - view.t[2]) / 100);
      return { role: e.role, screen: s ? `(${s.x},${s.y})` : "off", dist };
    }).sort((a, b) => a.dist - b.dist);
  }

  async install(): Promise<string> {
    this.refresh();
    const self = this;
    this.timer = setInterval(() => self.refresh(), 2000); // heavy scan off the render path
    return this.canvas.hookRender((cv, W, H) => {
      self.frames++;
      if (self.test) self.canvas.drawBox(cv, W / 2 - 120, H / 2 - 120, 240, 240, 4, 1, 1, 0, 1);
      const cam = self.cam; if (!cam) return;
      const view = viewFromCamera(cam, W, H);
      for (const e of self.enemies) {
        const wp = [rD(e.root.add(C2W_T)), rD(e.root.add(C2W_T + 8)), rD(e.root.add(C2W_T + 16))] as number[];
        if (wp[0] == null) continue;
        const s = worldToScreen(view, wp);
        if (!s || s.x < -60 || s.x > W + 60 || s.y < -60 || s.y > H + 60) continue;
        const bh = Math.max(10, Math.min(500, (220 * view.focal) / s.depth)), bw = bh * 0.5;
        const c = COLORS[e.role];
        self.canvas.drawBox(cv, s.x - bw / 2, s.y - bh / 2, bw, bh, 2.5, c[0], c[1], c[2], 1);
      }
    });
  }

  remove(): string {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return this.canvas.unhook();
  }

  status(): { frames: number; enemies: number; cam: boolean; test: boolean } {
    return { frames: this.frames, enemies: this.enemies.length, cam: !!this.cam, test: this.test };
  }
}
