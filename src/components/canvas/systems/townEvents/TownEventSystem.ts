import * as PIXI from "pixi.js";
import { loadStrip } from "../../stripAtlas";
import { TILE_SIZE } from "../../../../lib/spriteConfig";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { detailLevel, inView } from "../view";
import {
  DECOR_FOOT_X, DECOR_FOOT_Y, DECOR_FRAME_COUNT, DECOR_FRAMES, DECOR_URL,
  planEventDecor, type DecorPlacement, type EventDecorPlan, type MapPx,
} from "./eventDecor";
import { motionAt, motionExtent, newMotionOut } from "./decorMotion";

/** Seconds for a decoration to fade in when its event starts and out when it ends. */
const FADE_SECONDS = 1;

/**
 * Cells that are pure garnish: at a far zoom a scatter of petal pixels or a 5px sparkle is
 * noise, so they are hidden below the normal detail level (and nothing animates there).
 */
const GARNISH = new Set<number>([
  DECOR_FRAMES.petals, DECOR_FRAMES.sparkle,
  DECOR_FRAMES.petalFall, DECOR_FRAMES.moteFall, DECOR_FRAMES.leafFall, DECOR_FRAMES.confettiFall,
  DECOR_FRAMES.paperFall, DECOR_FRAMES.heatHaze, DECOR_FRAMES.firefly,
]);
function isGarnish(frame: number): boolean {
  return GARNISH.has(frame);
}

interface Group {
  eventId: number;
  ground: PIXI.Container;
  over: PIXI.Container;
  sprites: PIXI.Sprite[];
  placements: DecorPlacement[];
  /** Animation cell currently shown, per placement (-1 = static or not yet set). */
  shown: Int16Array;
  /** Indices of the animated or moving placements, so a frame only walks those. */
  animated: number[];
  /** Seconds clock (performance.now / 1000) when the group was built: `arrive` motions run off it. */
  born: number;
  /** World-space box around every sprite, for a whole-group view cull. */
  x0: number; y0: number; x1: number; y1: number;
  fade: number;
  target: 0 | 1;
  lastAlpha: number;
  lastLevel: number;
  /**
   * Decorations riding on a resident (a wedding's petals over the newlyweds): placed at the
   * agent's sprite every frame, so they are culled one by one rather than by the group box.
   */
  followers: Array<{ agentId: string; sprite: PIXI.Sprite; p: DecorPlacement; shown: number }>;
}

/**
 * Decorates the map while a world event is running: bunting and lanterns on the square for a
 * festival, an arch for a wedding, a wreath and candles for a funeral, flames on a roof for a
 * fire. `eventDecor.ts` decides what goes where; this class only turns placements into sprites.
 *
 * The sprites of an event are built once when it appears in the poll and dropped a second
 * after it disappears (fading out). Between polls the only per-frame work is fading, culling
 * whole groups against the view, and flipping the texture of the few animated cells (bunting,
 * lanterns, candles, flames...) at their own 4-6 fps. Placements with a `motion` (falling
 * petals and confetti, wandering fireflies, a cart pulling up) also get a position each frame,
 * computed from time alone in `decorMotion.ts`.
 */
export class TownEventSystem implements CanvasSystem {
  private textures: PIXI.Texture[] | null = null;
  private destroyed = false;
  private readonly groups: Group[] = [];
  private signature = "";
  private data: DataContext | null = null;
  private warned = false;
  /** Scratch result of `motionAt`, reused for every placement so a frame allocates nothing. */
  private readonly motion = newMotionOut();

  constructor(private readonly layers: CanvasLayers, private readonly services?: CanvasServices) {
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
    // The stranger stands where the road meets the map edge, so the road list is an input too.
    sig += `#${data.world?.road_tiles?.length ?? 0}`;
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
    const plans = planEventDecor(data.events ?? [], data.locations ?? [], map, (data.world as { road_tiles?: { x: number; y: number }[] } | null)?.road_tiles);

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
      if (p.tint !== undefined) sprite.tint = p.tint;
      (p.layer === "over" ? over : ground).addChild(sprite);
      sprites.push(sprite);
      if (p.frames > 1 || p.motion) animated.push(i);
      // A moving placement sweeps a whole area: the group's cull box has to cover all of it.
      const ext = p.motion ? motionExtent(p.motion) : { x0: 0, x1: 0, y0: 0, y1: 0 };
      x0 = Math.min(x0, p.x + ext.x0 - 20); x1 = Math.max(x1, p.x + ext.x1 + 20);
      y0 = Math.min(y0, p.y + ext.y0 - 44); y1 = Math.max(y1, p.y + ext.y1 + 4);
    });
    // Followers live in `over` too (fading with the group) but skip the group's cull box.
    const followers: Group["followers"] = [];
    for (const f of plan.followers ?? []) {
      const sprite = new PIXI.Sprite(textures[f.placement.frame]);
      sprite.anchor.set(DECOR_FOOT_X / 32, DECOR_FOOT_Y / 32);
      sprite.visible = false;
      over.addChild(sprite);
      followers.push({ agentId: String(f.agentId), sprite, p: f.placement, shown: -1 });
    }
    this.layers.ground.addChild(ground);
    this.layers.overAgents.addChild(over);
    return {
      followers,
      eventId: plan.eventId, ground, over, sprites, placements: plan.placements,
      shown: new Int16Array(plan.placements.length).fill(-1),
      animated, born: performance.now() / 1000, x0, y0, x1, y1,
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
      g.ground.visible = onScreen;
      // The couple may walk far from the square: `over` stays on while it carries followers.
      g.over.visible = onScreen || g.followers.length > 0;

      if (g.fade !== g.lastAlpha) {
        g.lastAlpha = g.fade;
        g.ground.alpha = g.over.alpha = g.fade;
      }
      if (g.followers.length > 0) this.stepFollowers(g, frame, level);
      if (!onScreen) {
        // Static placements in `over` must not draw while the group is culled.
        if (g.followers.length > 0) for (let i = 0; i < g.sprites.length; i++) {
          if (g.placements[i].layer === "over") g.sprites[i].visible = false;
        }
        g.lastLevel = -1; // re-apply garnish visibility when it comes back on screen
        continue;
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

      const mo = this.motion;
      const age = t - g.born;
      for (let k = 0; k < g.animated.length; k++) {
        const i = g.animated[k];
        const p = g.placements[i];
        const sprite = g.sprites[i];
        let cell = -1;
        if (p.motion) {
          motionAt(p.motion, t, p.phase, age, mo);
          const x = p.x + mo.dx, y = p.y + mo.dy;
          if (!inView(view, x, y - 16, 24)) { sprite.visible = false; continue; }
          sprite.visible = level > 0 || !isGarnish(p.frame);
          sprite.position.set(x, y);
          sprite.alpha = mo.alpha;
          // A cart that has stopped stops turning its wheels: rest pose is the first cell.
          if (p.frames > 1) cell = mo.moving ? Math.floor(t * p.fps + p.phase * p.frames) % p.frames : 0;
        } else {
          if (!inView(view, p.x, p.y - 16, 24)) continue;
          cell = Math.floor(t * p.fps + p.phase * p.frames) % p.frames;
        }
        if (cell >= 0 && cell !== g.shown[i]) {
          g.shown[i] = cell;
          sprite.texture = textures[p.frame + cell];
        }
      }
    }
  }

  /** Move each follower to its resident; hidden while the resident has no sprite or is off screen. */
  private stepFollowers(g: Group, frame: FrameContext, level: number): void {
    const textures = this.textures!;
    const t = frame.now / 1000;
    const mo = this.motion;
    for (const f of g.followers) {
      const agent = this.services?.sprites.getSprite(f.agentId);
      if (!agent || level === 0) { f.sprite.visible = false; continue; }
      let x = agent.x + f.p.x, y = agent.y + f.p.y;
      let alpha = 1;
      if (f.p.motion) {
        motionAt(f.p.motion, t, f.p.phase, t - g.born, mo);
        x += mo.dx; y += mo.dy; alpha = mo.alpha;
      }
      if (!inView(frame.view, x, y - 16, 24)) { f.sprite.visible = false; continue; }
      f.sprite.visible = true;
      f.sprite.position.set(x, y);
      f.sprite.alpha = alpha;
      if (f.p.frames > 1) {
        const cell = Math.floor(t * f.p.fps + f.p.phase * f.p.frames) % f.p.frames;
        if (cell !== f.shown) { f.shown = cell; f.sprite.texture = textures[f.p.frame + cell]; }
      }
    }
  }
}

export const createTownEventSystem: SystemFactory = (layers, services) => new TownEventSystem(layers, services);
