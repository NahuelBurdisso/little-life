import * as PIXI from "pixi.js";
import { WINDOW_GLASS, southWindowXs } from "../../BuildingRenderer";
import { inView } from "../view";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { panelPx, stepCurtain } from "./curtainMath";

/** Warm cloth, and the darker fold at each panel's inner edge that makes it read as a curtain. */
const FABRIC = 0xb0525e;
const FOLD = 0x7c3644;
const ROD = 0x4a3222;
const ALPHA = 0.95;
/** Sprites per window: two panels, two folds, one rod. */
const PER_WINDOW = 5;
/** Culling margin (px) past a house's footprint. */
const VIEW_MARGIN = 24;

interface Curtain {
  locId: number;
  /** World x of each window's centre, and the building's south edge (see `southWindowXs`). */
  xs: number[];
  southY: number;
  /** The house's middle, for culling. */
  cx: number;
  halfW: number;
  /** 0 = open, 1 = drawn. */
  progress: number;
  /** A tryst is under way in the house: draw, and keep drawn. */
  want: boolean;
  sprites: PIXI.Sprite[];
  /** The progress the sprites were last laid out for (-1: never), and whether they are showing. */
  laid: number;
  shown: boolean;
  seen: number;
}

/**
 * Curtains drawn over the south windows of a house that hosts the private evening.
 *
 * The town can see the house has company (the roof is cut away while anyone is inside) but the
 * glass goes to cloth: two small panels close from the sides over about a second when the
 * evening begins, and open again over the same second when it ends. Together with the lamp turned
 * down (LightingSystem) that is all the canvas says about a night in -- the rest is off-stage.
 *
 * Only houses: a tryst in a barn or a boat has no windows to draw. Panels are pooled sprites in
 * the `ground` layer, over exactly the pane BuildingRenderer draws (`WINDOW_GLASS`), and a house
 * off screen only advances its number. The client knows a tryst only from the agents' own
 * `zoneActivity`, so nothing here needs (or reveals) who is with whom.
 */
class CurtainSystem implements CanvasSystem {
  private readonly curtains = new Map<number, Curtain>();
  private list: Curtain[] = [];
  private readonly pool: PIXI.Sprite[] = [];
  private generation = 0;
  private readonly homes = new Map<number, any>();

  constructor(private readonly layers: CanvasLayers, _services: CanvasServices) {}

  onData(data: DataContext): void {
    const gen = ++this.generation;
    this.homes.clear();
    for (const loc of data.locations) if (loc?.type === "home") this.homes.set(loc.id, loc);

    // A world replace (or a save load) reuses location ids for different houses: a curtain kept from
    // the old world would keep drawing cloth over a window that is no longer there, at the old
    // coordinates, until its evening ended (which it never does when the agents are gone too). An
    // entry survives only while its id still names a home in the same place.
    let changed = false;
    for (const [id, c] of this.curtains) {
      const loc = this.homes.get(id);
      if (loc && sameHome(c, loc)) continue;
      this.release(c);
      this.curtains.delete(id);
      changed = true;
    }
    for (const a of data.agents) {
      const act = a.current_action;
      if (typeof act !== "object" || !act || act.zoneActivity !== "tryst" || a.current_location == null) continue;
      const loc = this.homes.get(a.current_location);
      if (!loc) continue;
      let c = this.curtains.get(loc.id);
      if (!c) {
        c = this.acquire(loc, gen);
        this.curtains.set(loc.id, c);
        changed = true;
      }
      c.seen = gen;
      c.want = true;
    }
    for (const c of this.curtains.values()) if (c.seen !== gen) c.want = false;
    if (changed) this.list = Array.from(this.curtains.values());
  }

  update(frame: FrameContext): void {
    const list = this.list;
    if (list.length === 0) return;
    let done = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      try {
        c.progress = stepCurtain(c.progress, c.want, frame.seconds);
        if (!c.want && c.progress <= 0) {
          done = true;
          continue;
        }
        this.draw(c, inView(frame.view, c.cx, c.southY, c.halfW + VIEW_MARGIN));
      } catch (err) {
        console.warn("[curtains] update failed:", err);
      }
    }
    if (done) {
      this.list = list.filter(c => {
        if (c.want || c.progress > 0) return true;
        this.release(c);
        this.curtains.delete(c.locId);
        return false;
      });
    }
  }

  /**
   * Lay the panels for this progress, or hide them all when the house is off screen. Nothing is
   * touched while neither the progress nor the visibility changed, so a drawn curtain is free.
   */
  private draw(c: Curtain, visible: boolean): void {
    const s = c.sprites;
    if (!visible) {
      if (c.shown) for (let i = 0; i < s.length; i++) s[i].visible = false;
      c.shown = false;
      c.laid = -1;
      return;
    }
    if (c.shown && c.laid === c.progress) return;
    c.shown = true;
    c.laid = c.progress;
    const w = panelPx(c.progress);
    const top = c.southY - WINDOW_GLASS.above;
    for (let i = 0; i < c.xs.length; i++) {
      const gx = Math.round(c.xs[i] - WINDOW_GLASS.left);
      const k = i * PER_WINDOW;
      const has = w > 0;
      s[k].visible = s[k + 1].visible = s[k + 4].visible = has;
      // A fold only shows once the panel is wide enough to have one.
      s[k + 2].visible = s[k + 3].visible = w >= 2;
      if (!has) continue;
      place(s[k], gx, top, w, WINDOW_GLASS.h);
      place(s[k + 1], gx + WINDOW_GLASS.w - w, top, w, WINDOW_GLASS.h);
      place(s[k + 2], gx + w - 1, top, 1, WINDOW_GLASS.h);
      place(s[k + 3], gx + WINDOW_GLASS.w - w, top, 1, WINDOW_GLASS.h);
      // The rod sits on the frame's top row, a pixel wider than the pane each side.
      place(s[k + 4], gx - 1, top - 1, WINDOW_GLASS.w + 2, 1);
    }
  }

  private acquire(loc: any, gen: number): Curtain {
    const xs = southWindowXs(loc);
    const sprites: PIXI.Sprite[] = [];
    for (let i = 0; i < xs.length; i++) {
      for (const tint of [FABRIC, FABRIC, FOLD, FOLD, ROD]) {
        const sp = this.pool.pop() ?? this.makeSprite();
        sp.tint = tint;
        sp.visible = false;
        sprites.push(sp);
      }
    }
    const { x, y, width, height } = loc.position;
    return {
      locId: loc.id, xs, southY: y + height, cx: x + width / 2, halfW: width / 2,
      progress: 0, want: true, sprites, laid: -1, shown: false, seen: gen,
    };
  }

  private makeSprite(): PIXI.Sprite {
    const sp = new PIXI.Sprite(PIXI.Texture.WHITE);
    sp.alpha = ALPHA;
    sp.eventMode = "none";
    this.layers.ground.addChild(sp);
    return sp;
  }

  private release(c: Curtain): void {
    for (const sp of c.sprites) {
      sp.visible = false;
      this.pool.push(sp);
    }
    c.sprites = [];
  }

  destroy(): void {
    for (const c of this.curtains.values()) this.release(c);
    for (const sp of this.pool) sp.destroy();
    this.pool.length = 0;
    this.curtains.clear();
    this.list = [];
  }
}

/** Whether a curtain was laid out for this very house (same footprint), not another that reused its id. */
function sameHome(c: Curtain, loc: any): boolean {
  const { x, y, width, height } = loc.position ?? {};
  return c.southY === y + height && c.cx === x + width / 2 && c.halfW === width / 2;
}

function place(sp: PIXI.Sprite, x: number, y: number, w: number, h: number): void {
  sp.position.set(x, y);
  sp.width = w;
  sp.height = h;
}

export const createCurtainSystem: SystemFactory = (layers, services) => new CurtainSystem(layers, services);
