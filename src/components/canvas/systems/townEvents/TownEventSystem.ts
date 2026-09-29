import * as PIXI from "pixi.js";
import { loadStrip } from "../../stripAtlas";
import { TILE_SIZE } from "../../../../lib/spriteConfig";
import type { CanvasLayers, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { detailLevel, inView } from "../view";
import {
  DECOR_FOOT_X, DECOR_FOOT_Y, DECOR_FRAME_COUNT, DECOR_FRAMES, DECOR_URL,
  planEventDecor, type DecorPlacement, type EventDecorPlan, type MapPx,
} from "./eventDecor";

/** Seconds for a decoration to fade in when its event starts and out when it ends. */
const FADE_SECONDS = 1;

/**
 * Cells that are pure garnish: at a far zoom a scatter of petal pixels or a 5px sparkle is
 * noise, so they are hidden below the normal detail level (and nothing animates there).
 */
function isGarnish(frame: number): boolean {
  return frame === DECOR_FRAMES.petals || frame === DECOR_FRAMES.sparkle;
}

interface Group {
  eventId: number;
  ground: PIXI.Container;
  over: PIXI.Container;
  sprites: PIXI.Sprite[];
  placements: DecorPlacement[];
  /** Animation cell currently shown, per placement (-1 = static or not yet set). */
  shown: Int16Array;
  /** Indices of the animated placements, so a frame only walks those. */
  animated: number[];
  /** World-space box around every sprite, for a whole-group view cull. */
  x0: number; y0: number; x1: number; y1: number;
  fade: number;
  target: 0 | 1;
  lastAlpha: number;
  lastLevel: number;
}

/**
 * Decorates the map while a world event is running: bunting and lanterns on the square for a
 * festival, an arch for a wedding, a wreath and candles for a funeral, flames on a roof for a
 * fire. `eventDecor.ts` decides what goes where; this class only turns placements into sprites.
 *
 * The sprites of an event are built once when it appears in the poll and dropped a second
 * after it disappears (fading out). Between polls the only per-frame work is fading, culling
 * whole groups against the view, and flipping the texture of the few animated cells (bunting,
 * lanterns, candles, flames...) at their own 4-6 fps.
 */
export class TownEventSystem implements CanvasSystem {
  private textures: PIXI.Texture[] | null = null;
  private destroyed = false;
  private readonly groups: Group[] = [];
  private signature = "";
  private data: DataContext | null = null;
  private warned = false;

  constructor(private readonly layers: CanvasLayers) {
    loadStrip(DECOR_URL, DECOR_FRAME_COUNT)
      .then(tex => {
        if (this.destroyed) return;
        this.textures = tex;
        this.sync();
      })
      // No atlas means no decorations, not a broken canvas.
      .catch(err => console.warn("[townEvents] decor atlas failed to load:", err));
  }

  onData(data: DataContext): void {
    this.data = data;
    const events = data.events ?? [];
    // Rebuild only when the set of events (or the number of places to anchor them) changes.
    let sig = String(data.locations?.length ?? 0);
    for (const e of events) sig += `|${e?.id}:${e?.type}`;
    if (sig === this.signature) return;
    this.signature = sig;
    this.sync();
  }

  update(frame: FrameContext): void {
    if (this.groups.length === 0) return;
    try {
      this.step(frame);
    } catch (err) {
      if (!this.warned) { this.warned = true; console.warn("[townEvents] update failed:", err); }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const g of this.groups) this.dispose(g);
    this.groups.length = 0;
  }

  // ── Data → groups ───────────────────────────────────────────────────────────────────────────

  private sync(): void {
    const data = this.data;
    if (!this.textures || !data) return;   // the atlas load calls this again once it lands
    const worldRow = data.world as { map_width?: number; map_height?: number } | null;
    const map: MapPx | null = worldRow?.map_width && worldRow?.map_height
      ? { w: worldRow.map_width * TILE_SIZE, h: worldRow.map_height * TILE_SIZE }
      : null;
    const plans = planEventDecor(data.events ?? [], data.locations ?? [], map);

    const live = new Set<number>();
    for (const plan of plans) {
      live.add(plan.eventId);
      const existing = this.groups.find(g => g.eventId === plan.eventId);
      if (existing) existing.target = 1;            // came back while fading out
      else this.groups.push(this.build(plan, this.textures));
    }
    for (const g of this.groups) if (!live.has(g.eventId)) g.target = 0;
  }

  private build(plan: EventDecorPlan, textures: PIXI.Texture[]): Group {
    const ground = new PIXI.Container();
    const over = new PIXI.Container();
    ground.alpha = over.alpha = 0;
    ground.eventMode = over.eventMode = "none";
    const sprites: PIXI.Sprite[] = [];
    const animated: number[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    plan.placements.forEach((p, i) => {
      const sprite = new PIXI.Sprite(textures[p.frame]);
      sprite.anchor.set(DECOR_FOOT_X / 32, DECOR_FOOT_Y / 32);
      sprite.position.set(p.x, p.y);
      (p.layer === "over" ? over : ground).addChild(sprite);
      sprites.push(sprite);
      if (p.frames > 1) animated.push(i);
      x0 = Math.min(x0, p.x - 20); x1 = Math.max(x1, p.x + 20);
      y0 = Math.min(y0, p.y - 44); y1 = Math.max(y1, p.y + 4);
    });
    this.layers.ground.addChild(ground);
    this.layers.overAgents.addChild(over);
    return {
      eventId: plan.eventId, ground, over, sprites, placements: plan.placements,
      shown: new Int16Array(plan.placements.length).fill(-1),
      animated, x0, y0, x1, y1,
      fade: 0, target: 1, lastAlpha: -1, lastLevel: -1,
    };
  }

  private dispose(g: Group): void {
    // Sprites share the atlas texture: destroy the display objects, never the texture.
    g.ground.destroy({ children: true });
    g.over.destroy({ children: true });
  }

  // ── Per frame ───────────────────────────────────────────────────────────────────────────────

  private step(frame: FrameContext): void {
    const { view, now, seconds } = frame;
    const level = detailLevel(view.scale);
    const t = now / 1000;
    const textures = this.textures;
    if (!textures) return;

    for (let gi = this.groups.length - 1; gi >= 0; gi--) {
      const g = this.groups[gi];
      g.fade += (g.target === 1 ? 1 : -1) * seconds / FADE_SECONDS;
      if (g.fade >= 1) g.fade = 1;
      if (g.fade <= 0 && g.target === 0) {
        this.dispose(g);
        this.groups.splice(gi, 1);
        continue;
      }
      if (g.fade < 0) g.fade = 0;

      const onScreen = g.x1 >= view.x && g.x0 <= view.x + view.w && g.y1 >= view.y && g.y0 <= view.y + view.h;
      g.ground.visible = g.over.visible = onScreen;
      if (!onScreen) continue;

      if (g.fade !== g.lastAlpha) {
        g.lastAlpha = g.fade;
        g.ground.alpha = g.over.alpha = g.fade;
      }
      if (level !== g.lastLevel) {
        g.lastLevel = level;
        for (let i = 0; i < g.sprites.length; i++) {
          g.sprites[i].visible = level > 0 || !isGarnish(g.placements[i].frame);
        }
      }
      // Frozen when zoomed far out: the flutter is invisible there and a full map of flags
      // would otherwise swap textures for nothing.
      if (level === 0) continue;

      for (let k = 0; k < g.animated.length; k++) {
        const i = g.animated[k];
        const p = g.placements[i];
        if (!inView(view, p.x, p.y - 16, 24)) continue;
        const cell = Math.floor(t * p.fps + p.phase * p.frames) % p.frames;
        if (cell !== g.shown[i]) {
          g.shown[i] = cell;
          g.sprites[i].texture = textures[p.frame + cell];
        }
      }
    }
  }
}

export const createTownEventSystem: SystemFactory = (layers) => new TownEventSystem(layers);
