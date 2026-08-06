// Configurable UE ESP/awareness overlay for authorized offline accessibility
// and training. Game-specific actor classes, teams, life state, visibility,
// labels, and colors belong in the target config; this module only discovers,
// projects, bounds, draws, and owns cleanup.

import { rP } from "../mem.js";
import type { Vec3 } from "../assist.js";
import { CTRL_PAWN, localPlayerController, viewFromCamera, worldLoc, worldToScreen } from "./actor.js";
import { childOfType, classNameOf, firstInstance, instancesOf } from "./reflection.js";
import { UeCanvas } from "./render.js";

export interface EspStyle {
  label: string;
  color: readonly [number, number, number, number?];
  hostile: boolean;
  alive?: boolean;
}

export interface EspConfig {
  actorClasses: RegExp;
  classify(actor: NativePointer, className: string): EspStyle | null;
  controllerClass?: string;
  location?(actor: NativePointer): Vec3 | null;
  visible?(actor: NativePointer): boolean;
  maxEntities?: number;
  refreshMs?: number;
  drawTracers?: boolean;
}

interface Entity {
  actor: NativePointer;
  id: string;
  className: string;
  style: EspStyle;
}

export interface EspSnapshotRow {
  id: string;
  className: string;
  label: string;
  hostile: boolean;
  alive: boolean | null;
  visible: boolean | null;
  screen: { x: number; y: number } | null;
  distance: number;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer within ${min}..${max}`);
  }
  return resolved;
}

function controller(config: EspConfig): NativePointer | null {
  if (!config.controllerClass) return localPlayerController();
  return firstInstance((object) => classNameOf(object) === config.controllerClass);
}

function playerAndCamera(config: EspConfig): { pawn: NativePointer | null; camera: NativePointer | null } {
  const pc = controller(config);
  const pawn = pc ? rP(pc.add(CTRL_PAWN)) : null;
  return { pawn, camera: pawn ? childOfType(pawn, "CameraComponent") : null };
}

export class Esp {
  private readonly canvas = new UeCanvas();
  private readonly actorPattern: RegExp;
  private readonly maxEntities: number;
  private readonly refreshMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private entities: Entity[] = [];
  private camera: NativePointer | null = null;
  private operations: Promise<void> = Promise.resolve();
  private lastResult = "not installed";
  frames = 0;
  test = false;

  constructor(private readonly config: EspConfig) {
    this.actorPattern = new RegExp(config.actorClasses.source, config.actorClasses.flags.replace(/[gy]/g, ""));
    this.maxEntities = boundedInteger(config.maxEntities, 128, 1, 512, "maxEntities");
    this.refreshMs = boundedInteger(config.refreshMs, 750, 100, 10_000, "refreshMs");
  }

  private refresh(): void {
    const { pawn, camera } = playerAndCamera(this.config);
    this.camera = camera;
    const next: Entity[] = [];
    for (const actor of instancesOf(this.actorPattern)) {
      if (pawn && actor.equals(pawn)) continue;
      const className = classNameOf(actor);
      if (!className) continue;
      let style: EspStyle | null = null;
      try { style = this.config.classify(actor, className); } catch { /* stale actor */ }
      if (!style || style.alive === false) continue;
      next.push({ actor, id: actor.toString(), className, style });
      if (next.length >= this.maxEntities) break;
    }
    this.entities = next;
  }

  private position(entity: Entity): Vec3 | null {
    try { return this.config.location ? this.config.location(entity.actor) : worldLoc(entity.actor); }
    catch { return null; }
  }

  /** One-shot bounded data snapshot. Unknown visibility remains null. */
  snapshot(width = 1920, height = 1080): EspSnapshotRow[] {
    this.refresh();
    const camera = this.camera;
    if (!camera) return [];
    const view = viewFromCamera(camera, width, height);
    const rows: EspSnapshotRow[] = [];
    for (const entity of this.entities) {
      const point = this.position(entity);
      if (!point) continue;
      const screen = worldToScreen(view, point);
      const distance = Math.round(Math.hypot(point[0] - view.t[0], point[1] - view.t[1], point[2] - view.t[2]) / 100);
      let visible: boolean | null = null;
      try { visible = this.config.visible ? this.config.visible(entity.actor) : null; } catch { /* stale actor */ }
      rows.push({
        id: entity.id,
        className: entity.className,
        label: entity.style.label,
        hostile: entity.style.hostile,
        alive: entity.style.alive ?? null,
        visible,
        screen: screen ? { x: screen.x, y: screen.y } : null,
        distance,
      });
    }
    return rows.sort((a, b) => a.distance - b.distance).slice(0, this.maxEntities);
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  install(): Promise<string> { return this.enqueue(() => this.installNow()); }

  private async installNow(): Promise<string> {
    this.removeNow();
    this.refresh();
    const result = await this.canvas.hookRender((canvas, width, height) => {
      this.frames++;
      if (this.test) this.canvas.drawBox(canvas, width / 2 - 120, height / 2 - 120, 240, 240, 4, 1, 1, 0, 1);
      const camera = this.camera;
      if (!camera) return;
      const view = viewFromCamera(camera, width, height);
      for (const entity of this.entities) {
        const point = this.position(entity);
        if (!point) continue;
        const screen = worldToScreen(view, point);
        if (!screen || screen.x < -60 || screen.x > width + 60 || screen.y < -60 || screen.y > height + 60) continue;
        const boxHeight = Math.max(10, Math.min(500, (220 * view.focal) / screen.depth));
        const boxWidth = boxHeight * 0.5;
        const [red, green, blue, alpha = 1] = entity.style.color;
        this.canvas.drawBox(canvas, screen.x - boxWidth / 2, screen.y - boxHeight / 2, boxWidth, boxHeight, 2.5, red, green, blue, alpha);
        if (this.config.drawTracers) this.canvas.drawLine(canvas, width / 2, height, screen.x, screen.y, 1.5, red, green, blue, alpha);
      }
    });
    this.lastResult = result;
    if (this.canvas.hooked) this.timer = setInterval(() => this.refresh(), this.refreshMs);
    return result;
  }

  remove(): Promise<string> { return this.enqueue(() => this.removeNow()); }

  private removeNow(): string {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastResult = this.canvas.unhook();
    return this.lastResult;
  }

  status(): {
    installed: boolean;
    frames: number;
    entities: number;
    camera: boolean;
    test: boolean;
    visibility: "verified-by-target" | "unknown";
    lastResult: string;
  } {
    return {
      installed: this.canvas.hooked,
      frames: this.frames,
      entities: this.entities.length,
      camera: !!this.camera,
      test: this.test,
      visibility: this.config.visible ? "verified-by-target" : "unknown",
      lastResult: this.lastResult,
    };
  }

  dispose(): Promise<string> { return this.remove(); }
}

/** Create a disabled overlay; targets own install/remove/dispose. */
export function createEsp(config: EspConfig): Esp { return new Esp(config); }
