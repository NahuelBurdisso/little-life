/**
 * Town event decorations: which sprites to put where for each active world event.
 *
 * Pure — no PixiJS — so the layout is unit tested. The renderer (TownEventSystem) turns the
 * placements into sprites. Everything is deterministic (seeded by the event id and the anchor
 * rect), so a reload or a second client sees the same bunting on the same lampposts and a fire
 * never hops between roofs.
 *
 * Atlas: `/sprites/fx/decor.png`, built by scripts/aseprite/event-decor.lua. Keep
 * `DECOR_FRAMES` in sync with the cell list in that script's header comment.
 */

import { INTERIOR_ZONES } from '../../../../../server/data/interiors';
import { openAreaPropBoxes, type PropBox } from '../../zoneProps';

export const DECOR_URL = '/sprites/fx/decor.png';
export const DECOR_FRAME_COUNT = 69;

/**
 * First cell of each sprite; animated ones name their first frame and run for `DECOR_ANIM.frames`
 * cells. Cells are 32x32 and every object stands on the row `DECOR_FOOT_Y` (a placement's x/y is
 * where the object touches the ground, so anchoring at the foot depth-sorts objects by y).
 */
export const DECOR_FRAMES = {
  bunting: 0,        // 0-1  colourful string, two flutter frames
  buntingWhite: 2,   // 2-3
  buntingDark: 4,    // 4-5
  lantern: 6,        // 6-7  lantern post, flicker
  post: 8,           //      plain post for strings without lanterns
  stallRed: 9,
  stallBlue: 10,
  crate: 11,
  arch: 12,          //      flower arch
  petals: 13,        //      petals on the ground
  wreath: 14,        //      wreath on a stand
  candle: 15,        // 15-17
  pumpkin: 18,
  hay: 19,
  basket: 20,
  flag: 21,          // 21-22
  podium: 23,
  bench: 24,
  lectern: 25,
  fire: 26,          // 26-29
  smoke: 30,         // 30-32
  board: 33,         //      notice board
  sparkle: 34,       // 34-36
  herbs: 37,         //      herb bundle
  closedSign: 38,
  stranger: 39,      // 39-40 hooded figure with a lantern, flicker
  fishCrate: 41,
  netRack: 42,
  fishJump: 43,      // 43-48 ripple, fin, rise, apex, fall, splash (two rest cells, then a leap)
  cart: 49,          // 49-50 hand cart heaped with belongings, wheels turn
  luggage: 51,
  welcome: 52,       // 52-53 welcome banner between two posts, flutter
  parasol: 54,
  waterBarrel: 55,
  petalFall: 56,     // 56-60 particle clusters: the renderer drifts them (see DecorMotion)
  moteFall: 57,
  leafFall: 58,
  confettiFall: 59,
  paperFall: 60,
  heatHaze: 61,      //       wavy warm streaks that rise
  firefly: 62,       // 62-64 blink
  owl: 65,           // 65-68 owl on a post: look centre, left, right, blink
} as const;

/** Row of a cell (0-31) where objects touch the ground; the sprite anchor is (16, 30). */
export const DECOR_FOOT_X = 16;
export const DECOR_FOOT_Y = 30;

export type DecorLayer = 'ground' | 'over';

/**
 * Motion on top of the cell animation, evaluated per frame by the renderer from time alone (no
 * state, so a placement is still plain data). `phase` staggers neighbours.
 *
 * - `fall`: drifts by (dx, dy) over `period` seconds, fading in and out, then starts again.
 *   Petals, gold motes, leaves, confetti and blown papers are clusters that do this.
 * - `wander`: loops a small Lissajous figure of radius (rx, ry): fireflies.
 * - `arrive`: starts (dx, dy) away and eases to its rest position over `period` seconds from
 *   when the decoration appeared, wheels turning only while it moves. A cart pulling up.
 */
export type DecorMotion =
  | { kind: 'fall'; dx: number; dy: number; period: number }
  | { kind: 'wander'; rx: number; ry: number; period: number }
  | { kind: 'arrive'; dx: number; dy: number; period: number };

export interface DecorPlacement {
  /** First atlas cell. */
  frame: number;
  /** World position of the object's foot (bottom centre), in pixels. */
  x: number;
  y: number;
  /** `ground` sits under the agents, `over` above them (flames, smoke, sparkles, south bunting). */
  layer: DecorLayer;
  /** Cells in the animation, starting at `frame`; 1 = static. */
  frames: number;
  fps: number;
  /** 0..1 offset into the animation so neighbours don't flutter in lockstep. */
  phase: number;
  motion?: DecorMotion;
  /** Multiplied into the cell's colours (0xRRGGBB): one haze cell serves as heat and as sickly air. */
  tint?: number;
}

export interface EventDecorPlan {
  eventId: number;
  type: string;
  placements: DecorPlacement[];
  /**
   * Decorations that travel with a resident instead of standing on the map: `x`/`y` are an
   * offset from that agent's sprite (its feet), resolved by the renderer every frame. A
   * wedding's newlyweds walk under their own shower of petals.
   */
  followers?: Array<{ agentId: number; placement: DecorPlacement }>;
}

/**
 * The couple of a wedding: `world_events.triggered_by` is `wedding:<a>-<b>` for a real
 * couple's ceremony (server/lib/marriage.ts `weddingTriggeredBy`, mirrored here because the
 * client can't import a DB module). Null for any other event, including a wedding from an old
 * save that was a random roll with nobody at the altar.
 */
export function weddingCouple(event: any): [number, number] | null {
  if (!event || event.type !== 'wedding' || typeof event.triggered_by !== 'string') return null;
  const m = /^wedding:(\d+)-(\d+)$/.exec(event.triggered_by);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Petals drifting down over each newlywed's head and a slow twinkle beside them, for as long
 * as their wedding runs. Offsets are from the sprite's feet (the head is ~40 px up).
 */
export function weddingFollowers(event: any): NonNullable<EventDecorPlan['followers']> {
  const couple = weddingCouple(event);
  if (!couple) return [];
  const id = Number.isFinite(event.id) ? (event.id as number) : 0;
  return couple.flatMap((agentId, i) => [
    {
      agentId,
      placement: {
        frame: DECOR_FRAMES.petalFall, x: 0, y: -44, layer: 'over' as const, frames: 1, fps: 0,
        phase: unit(id, 70 + i), motion: { kind: 'fall' as const, dx: 6, dy: 30, period: 3.5 },
      },
    },
    {
      agentId,
      placement: {
        frame: DECOR_FRAMES.sparkle, x: i === 0 ? -12 : 12, y: -52, layer: 'over' as const, frames: 3, fps: 4,
        phase: unit(id, 80 + i),
      },
    },
  ]);
}

export interface MapPx { w: number; h: number }

/** A road tile from `world.road_tiles` (tile coordinates). */
export interface RoadTile { x: number; y: number }

export interface Rect { x: number; y: number; width: number; height: number }

const TILE = 32;

// ── Deterministic noise ───────────────────────────────────────────────────────────────────────

function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
/** 0..1 */
function unit(a: number, b: number): number { return hash(a, b) / 4294967296; }

// ── Anchors ───────────────────────────────────────────────────────────────────────────────────

const OPEN_ANCHORS = new Set(['town_square', 'market_square', 'park']);

interface Anchor { rect: Rect; type: string }

function findAnchor(prefer: readonly string[], locations: any[], map: MapPx | null, locationId: unknown): Anchor | null {
  // An event tied to an open area decorates that area; a building id (fire, sickness) is handled
  // by the events that care about buildings.
  if (typeof locationId === 'number') {
    const at = locations.find(l => l?.id === locationId);
    if (at && OPEN_ANCHORS.has(at.type) && at.position) return { rect: at.position, type: at.type };
  }
  for (const type of prefer) {
    // Lowest id, so a reordered list still picks the same square.
    let best: any = null;
    for (const l of locations) {
      if (l?.type === type && l.position && (best === null || l.id < best.id)) best = l;
    }
    if (best) return { rect: best.position, type };
  }
  if (!map) return null;
  const width = 12 * TILE, height = 8 * TILE;
  return {
    rect: { x: Math.round((map.w - width) / 2), y: Math.round((map.h - height) / 2), width, height },
    type: 'centre',
  };
}

const SQUARE_FIRST = ['town_square', 'market_square'] as const;
const MARKET_FIRST = ['market_square', 'town_square'] as const;

/**
 * The stone well, its apron and its four benches, as BuildingRenderer.addOpenArea draws them
 * (well centre = the tile at the middle of the square). Solid props keep out of it; null when
 * the anchor is not a town square, where nothing is drawn.
 */
export function wellBox(r: Rect, type: string): { x0: number; y0: number; x1: number; y1: number } | null {
  if (type !== 'town_square') return null;
  const cx = r.x + Math.floor(r.width / 2 / TILE) * TILE;
  const cy = r.y + Math.floor(r.height / 2 / TILE) * TILE;
  return { x0: cx - 44, y0: cy - 44, x1: cx + 78, y1: cy + 78 };
}

// ── Layout context ────────────────────────────────────────────────────────────────────────────

const BUNTING_FPS = 4;

/** Offsets tried, nearest first, when a solid decoration's slot is taken by a static prop. */
const NUDGES: ReadonlyArray<readonly [number, number]> = [
  [0, -20], [0, 20], [24, 0], [-24, 0], [24, -20], [-24, -20], [24, 20], [-24, 20],
  [0, -40], [0, 40], [48, 0], [-48, 0],
];

/** Cluster anchors as fractions of the rect: where props go in the bands around the well. */
type Slot = 'nw' | 'ne' | 'w' | 'e' | 'sw' | 'se';
const SQUARE_SLOTS: Record<Slot, readonly [number, number]> = {
  nw: [0.17, 0.34], ne: [0.83, 0.34], w: [0.13, 0.58], e: [0.87, 0.58], sw: [0.17, 0.82], se: [0.83, 0.82],
};
const OPEN_SLOTS: Record<Slot, readonly [number, number]> = {
  nw: [0.2, 0.42], ne: [0.8, 0.42], w: [0.1, 0.6], e: [0.9, 0.6], sw: [0.25, 0.78], se: [0.75, 0.78],
};

class Layout {
  readonly out: DecorPlacement[] = [];
  readonly box: ReturnType<typeof wellBox>;
  /** x of the square's visual axis (the well), y where the north-band focal props stand. */
  readonly ax: number;
  readonly nFoot: number;
  private readonly slots: Record<Slot, readonly [number, number]>;
  /** The area's own props (stalls, podium, benches...), absolute px. Solid decor keeps off them. */
  private readonly props: PropBox[];

  constructor(readonly r: Rect, readonly type: string, readonly seed: number) {
    this.box = wellBox(r, type);
    this.props = openAreaPropBoxes(type, r.width, r.height).map(b => ({ ...b, x: b.x + r.x, y: b.y + r.y }));
    const isSquare = type === 'town_square';
    this.slots = isSquare ? SQUARE_SLOTS : OPEN_SLOTS;
    this.ax = isSquare ? r.x + Math.floor(r.width / 2 / TILE) * TILE + 16 : r.x + Math.round(r.width / 2);
    this.nFoot = isSquare && this.box ? this.box.y0 - 4 : r.y + Math.round(r.height * 0.36);
  }

  slot(s: Slot): [number, number] {
    const [fx, fy] = this.slots[s];
    return [Math.round(this.r.x + this.r.width * fx), Math.round(this.r.y + this.r.height * fy)];
  }

  /** Foot inside the anchor and the object's base clear of the well. */
  free(x: number, y: number, halfW = 12, depth = 8): boolean {
    const { r, box } = this;
    if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) return false;
    if (box && x + halfW > box.x0 && x - halfW < box.x1 && y > box.y0 && y - depth < box.y1) return false;
    return !this.onProp(x, y, halfW, depth);
  }

  /** Whether an object's base (foot at x,y) overlaps one of the area's static props. */
  private onProp(x: number, y: number, halfW: number, depth: number): boolean {
    for (const p of this.props) {
      if (x + halfW > p.x && x - halfW < p.x + p.w && y > p.y && y - depth < p.y + p.h) return true;
    }
    return false;
  }

  /** Round to whole pixels: the atlas is pixel art and half-pixel sprites shimmer. */
  add(frame: number, x: number, y: number, o: { layer?: DecorLayer; frames?: number; fps?: number; solid?: boolean; salt?: number; motion?: DecorMotion; tint?: number } = {}): boolean {
    x = Math.round(x); y = Math.round(y);
    const solid = o.solid ?? true;
    if (solid && !this.free(x, y)) {
      // Slots were laid out for a bare square; now that it has stalls, a podium and benches,
      // a slot can land on one. Step to the nearest clear spot rather than drop the piece.
      const alt = NUDGES.find(([dx, dy]) => this.free(x + dx, y + dy));
      if (!alt) return false;
      x += alt[0]; y += alt[1];
    } else if (!solid && !(x >= this.r.x && x <= this.r.x + this.r.width && y >= this.r.y && y <= this.r.y + this.r.height)) {
      return false;
    }
    const frames = o.frames ?? 1;
    this.out.push({
      frame, x, y,
      layer: o.layer ?? 'ground',
      frames,
      fps: frames > 1 ? (o.fps ?? 4) : 0,
      // Moving placements need a phase too, or every petal of a shower would fall in step.
      phase: frames > 1 || o.motion ? unit(this.seed + (o.salt ?? 0) * 31 + x * 7, y * 13 + frame) : 0,
      ...(o.motion ? { motion: o.motion } : {}),
      ...(o.tint !== undefined ? { tint: o.tint } : {}),
    });
    return true;
  }

  /**
   * `count` particle clusters spread across x0..x1, each starting at `y` and drifting (dx, dy)
   * over about `period` seconds. Above the agents: they are in the air.
   */
  falling(frame: number, count: number, x0: number, x1: number, y: number, o: { dx?: number; dy: number; period: number; salt?: number }): void {
    for (let i = 0; i < count; i++) {
      const k = (o.salt ?? 0) + i;
      const x = x0 + ((x1 - x0) * (i + 0.5)) / count + this.jit(600 + k, 10);
      const period = o.period * (0.8 + 0.4 * unit(this.seed, 700 + k));
      this.add(frame, x, y + this.jit(650 + k, 6), {
        layer: 'over', solid: false, salt: k,
        motion: { kind: 'fall', dx: o.dx ?? 0, dy: o.dy, period },
      });
    }
  }

  /** Jitter in [-amp, amp], stable per (slot key). */
  jit(key: number, amp: number): number {
    return Math.round((unit(this.seed, key) * 2 - 1) * amp);
  }

  /**
   * A string of bunting between posts along a horizontal edge. Cells are 32 px wide and sag in
   * the middle, posts every third cell (and at the end), so the string reads as scallops between
   * posts. `foot` is where the posts stand; the string hangs 24 px above.
   */
  bunting(foot: number, string: number, post: number, layer: DecorLayer, postFrames: number): void {
    const { r } = this;
    const n = Math.floor(r.width / TILE);
    if (n < 1) return;
    const left = r.x + Math.round((r.width - n * TILE) / 2);
    for (let i = 0; i < n; i++) {
      this.add(string, left + i * TILE + TILE / 2, foot, { layer, frames: 2, fps: BUNTING_FPS, solid: false, salt: i });
    }
    for (let b = 0; b <= n; b += 3) this.addPost(left + b * TILE, foot, post, layer, postFrames, b);
    if (n % 3 !== 0) this.addPost(left + n * TILE, foot, post, layer, postFrames, n);
  }

  private addPost(x: number, foot: number, frame: number, layer: DecorLayer, frames: number, salt: number): void {
    this.add(frame, x, foot, { layer, frames, fps: 4, solid: false, salt: 100 + salt });
  }
}

// ── Recipes ───────────────────────────────────────────────────────────────────────────────────

type Recipe = (l: Layout) => void;

const festival: Recipe = l => {
  l.bunting(l.r.y + 30, DECOR_FRAMES.bunting, DECOR_FRAMES.lantern, 'ground', 2);
  if (l.r.height >= 2 * TILE + 32) l.bunting(l.r.y + l.r.height - 4, DECOR_FRAMES.bunting, DECOR_FRAMES.lantern, 'over', 2);
  // Four stalls in the corners of the band around the well, lanterns and crates between.
  (['nw', 'ne', 'sw', 'se'] as const).forEach((s, i) => {
    const [x, y] = l.slot(s);
    const inward = s.endsWith('w') ? 1 : -1;
    l.add(i % 2 === 0 ? DECOR_FRAMES.stallRed : DECOR_FRAMES.stallBlue, x, y);
    l.add(DECOR_FRAMES.crate, x + inward * 30, y + 2);
  });
  for (const s of ['w', 'e'] as const) {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.lantern, x, y, { frames: 2, fps: BUNTING_FPS, salt: 7 });
  }
  // Confetti drifting down over the crowd, so a festival is never a still picture.
  l.falling(DECOR_FRAMES.confettiFall, 4, l.r.x + 40, l.r.x + l.r.width - 40, l.r.y + 70, { dy: 96, dx: 14, period: 8 });
};

const stalls = (points: Slot[], crates: Slot[], extra?: Recipe): Recipe => l => {
  extra?.(l);
  points.forEach((s, i) => {
    const [x, y] = l.slot(s);
    l.add(i % 2 === 0 ? DECOR_FRAMES.stallRed : DECOR_FRAMES.stallBlue, x, y + l.jit(i, 3));
  });
  crates.forEach((s, i) => {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.crate, x + l.jit(20 + i, 4), y + 4 + l.jit(30 + i, 3), { salt: i });
    if (i % 2 === 0) l.add(DECOR_FRAMES.crate, x + 12, y + 10, { salt: i + 9 });
  });
};

/** Colourful string along the north edge: the market's flutter (its stalls are otherwise still). */
const marketBunting: Recipe = l => {
  l.bunting(l.r.y + 34, DECOR_FRAMES.bunting, DECOR_FRAMES.post, 'ground', 1);
};

/** The merchant's cart pulls up to the stall from the east and parks beside it. */
const merchantCart: Recipe = l => {
  const [x, y] = l.slot('w');
  l.add(DECOR_FRAMES.cart, x + 8, y + 10, {
    frames: 2, fps: 6, solid: false, salt: 3,
    motion: { kind: 'arrive', dx: 150, dy: 0, period: 6 },
  });
  l.add(DECOR_FRAMES.luggage, x - 36, y + 6, { solid: false });
};

const wedding: Recipe = l => {
  l.bunting(l.r.y + 46, DECOR_FRAMES.buntingWhite, DECOR_FRAMES.post, 'ground', 1);
  l.add(DECOR_FRAMES.arch, l.ax, l.nFoot);
  for (const dx of [-32, 0, 32]) l.add(DECOR_FRAMES.petals, l.ax + dx, l.nFoot + 2, { solid: false });
  for (const dx of [-72, 72]) l.add(DECOR_FRAMES.bench, l.ax + dx, l.nFoot);
  // Guests' benches and lanterns out in the side bands, all facing the arch.
  for (const s of ['nw', 'ne'] as const) {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.bench, x, y);
  }
  for (const s of ['w', 'e'] as const) {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.lantern, x, y, { frames: 2, fps: BUNTING_FPS, salt: 7 });
  }
  // Petals drifting down from the arch.
  l.falling(DECOR_FRAMES.petalFall, 4, l.ax - 70, l.ax + 70, l.nFoot - 34, { dy: 64, dx: 8, period: 7 });
};

const funeral: Recipe = l => {
  l.bunting(l.r.y + 38, DECOR_FRAMES.buntingDark, DECOR_FRAMES.post, 'ground', 1);
  l.add(DECOR_FRAMES.wreath, l.ax, l.nFoot);
  const flame = { frames: 3, fps: 5, solid: false } as const;
  // Candle dishes are 16 px wide: keep them a dish apart so they read as separate vigil lights.
  [-58, -28, 28, 58].forEach((dx, i) => l.add(DECOR_FRAMES.candle, l.ax + dx, l.nFoot + 2 + (i % 3 === 0 ? 3 : 0), { ...flame, salt: i + 1 }));
  // Mourners' benches in the side bands.
  for (const s of ['nw', 'ne'] as const) {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.bench, x, y);
  }
};

const harvest: Recipe = l => {
  const put = (s: Slot, frame: number, offs: readonly (readonly [number, number])[]) => {
    const [x, y] = l.slot(s);
    offs.forEach(([dx, dy], i) => l.add(frame, x + dx + l.jit(i + 1, 3), y + dy + l.jit(i + 40, 2), { salt: i }));
  };
  put('w', DECOR_FRAMES.hay, [[0, 0], [36, 6]]);
  put('e', DECOR_FRAMES.hay, [[0, 0], [-36, 6]]);
  put('nw', DECOR_FRAMES.pumpkin, [[-10, 0], [28, 8]]);
  put('ne', DECOR_FRAMES.pumpkin, [[10, 0], [-28, 8]]);
  put('sw', DECOR_FRAMES.basket, [[-6, 0], [28, 4]]);
  put('se', DECOR_FRAMES.basket, [[6, 0], [-28, 4]]);
  // A few more along the north band, either side of the well's axis.
  for (const dx of [-84, 84]) l.add(DECOR_FRAMES.pumpkin, l.ax + dx, l.nFoot + 2, { salt: dx });
  for (const dx of [-124, 124]) l.add(DECOR_FRAMES.hay, l.ax + dx, l.nFoot + 6, { salt: dx });
  // Leaves of the season, blowing across.
  l.falling(DECOR_FRAMES.leafFall, 4, l.r.x + 30, l.r.x + l.r.width - 30, l.r.y + 50, { dy: 90, dx: 40, period: 9 });
};

const competition: Recipe = l => {
  l.add(DECOR_FRAMES.podium, l.ax, l.nFoot);
  const flag = { frames: 2, fps: 4 } as const;
  l.add(DECOR_FRAMES.flag, l.ax - 44, l.nFoot, { ...flag, salt: 1 });
  l.add(DECOR_FRAMES.flag, l.ax + 44, l.nFoot, { ...flag, salt: 2 });
  const [wx, wy] = l.slot('w');
  const [ex, ey] = l.slot('e');
  l.add(DECOR_FRAMES.flag, wx, wy, { ...flag, salt: 3 });
  l.add(DECOR_FRAMES.flag, ex, ey, { ...flag, salt: 4 });
};

const townMeeting: Recipe = l => {
  l.add(DECOR_FRAMES.lectern, l.ax, l.nFoot);
  for (const dx of [-56, 56]) l.add(DECOR_FRAMES.bench, l.ax + dx, l.nFoot);
  for (const s of ['nw', 'ne', 'w', 'e'] as const) {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.bench, x, y);
  }
  // It is held in the evening: lamps lit either side of the hall.
  for (const s of ['sw', 'se'] as const) {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.lantern, x, y, { frames: 2, fps: BUNTING_FPS, salt: 11 });
  }
};

const scandal: Recipe = l => {
  const [wx, wy] = l.slot('w');
  const [nx, ny] = l.slot('ne');
  l.add(DECOR_FRAMES.board, wx, wy);
  l.add(DECOR_FRAMES.board, nx, ny);
  // Torn-off notices blowing across the square: the news is out.
  l.falling(DECOR_FRAMES.paperFall, 3, l.r.x + 24, l.r.x + l.r.width * 0.6, l.r.y + 60, { dy: 26, dx: 150, period: 10 });
};

const sparkles = (count: number): Recipe => l => {
  const { r } = l;
  for (let i = 0; i < count; i++) {
    const x = r.x + 16 + Math.floor(unit(l.seed, 500 + i) * (r.width - 32));
    const y = r.y + 24 + Math.floor(unit(l.seed, 900 + i) * (r.height - 28));
    l.add(DECOR_FRAMES.sparkle, x, y, { layer: 'over', frames: 3, fps: 5, solid: false, salt: i });
  }
};

/** Gold motes sinking through a shaft of light, over a few slow twinkles. */
const blessing: Recipe = l => {
  sparkles(4)(l);
  l.falling(DECOR_FRAMES.moteFall, 5, l.r.x + 30, l.r.x + l.r.width - 30, l.r.y + 40, { dy: 84, dx: -10, period: 9 });
};

/**
 * Fireflies wandering over the grass and an owl on a post at the edge. The moon itself is a halo
 * drawn by the sky system; this is what lives under it.
 */
const fullMoon: Recipe = l => {
  const [ox, oy] = l.slot('ne');
  l.add(DECOR_FRAMES.owl, ox, oy, { frames: 4, fps: 1.3, salt: 5 });
  const spots: Slot[] = ['nw', 'w', 'e', 'sw', 'se'];
  spots.forEach((sl, i) => {
    const [x, y] = l.slot(sl);
    l.add(DECOR_FRAMES.firefly, x + l.jit(800 + i, 24), y - 10 + l.jit(830 + i, 10), {
      layer: 'over', solid: false, frames: 3, fps: 1.6 + (i % 3) * 0.5, salt: 20 + i,
      motion: { kind: 'wander', rx: 12 + (i % 2) * 6, ry: 7, period: 6 + i * 1.7 },
    });
  });
};

/** Shade and water: parasols over the benches, a barrel of water to cool off at. */
const heatwave: Recipe = l => {
  for (const s of ['nw', 'ne', 'w', 'e'] as const) {
    const [x, y] = l.slot(s);
    l.add(DECOR_FRAMES.parasol, x, y + 4);
  }
  l.add(DECOR_FRAMES.waterBarrel, l.ax + 64, l.nFoot + 4);
  // The air itself shimmering upward over the stones.
  const haze = 5;
  for (let i = 0; i < haze; i++) {
    const x = l.r.x + 24 + ((l.r.width - 48) * (i + 0.5)) / haze + l.jit(900 + i, 12);
    const y = l.r.y + l.r.height * (0.55 + 0.3 * unit(l.seed, 940 + i));
    l.add(DECOR_FRAMES.heatHaze, x, y, {
      layer: 'over', solid: false, salt: 60 + i,
      motion: { kind: 'fall', dx: l.jit(960 + i, 6), dy: -34, period: 4 + (i % 3) },
    });
  }
};

const RECIPES: Record<string, { prefer: readonly string[]; recipe: Recipe }> = {
  festival: { prefer: SQUARE_FIRST, recipe: festival },
  market_day: { prefer: MARKET_FIRST, recipe: stalls(['nw', 'ne', 'sw', 'se'], ['w', 'e'], marketBunting) },
  traveling_merchant: { prefer: MARKET_FIRST, recipe: stalls(['e'], ['e'], merchantCart) },
  wedding: { prefer: SQUARE_FIRST, recipe: wedding },
  funeral: { prefer: SQUARE_FIRST, recipe: funeral },
  harvest: { prefer: SQUARE_FIRST, recipe: harvest },
  competition: { prefer: SQUARE_FIRST, recipe: competition },
  town_meeting: { prefer: SQUARE_FIRST, recipe: townMeeting },
  scandal: { prefer: SQUARE_FIRST, recipe: scandal },
  blessing: { prefer: SQUARE_FIRST, recipe: blessing },
  // The stars are the sky system's shooting stars; a few twinkles on the ground echo them.
  starry_night: { prefer: SQUARE_FIRST, recipe: sparkles(3) },
  full_moon: { prefer: SQUARE_FIRST, recipe: fullMoon },
  heatwave: { prefer: SQUARE_FIRST, recipe: heatwave },
};

// ── Building events ───────────────────────────────────────────────────────────────────────────

const BURNABLE = new Set(['home', 'shop', 'tavern', 'clinic', 'town_hall', 'bakery', 'workshop', 'pawnshop', 'divebar']);

function fire(event: any, locations: any[], out: DecorPlacement[]): void {
  const hosts = locations
    .filter(l => l?.position && BURNABLE.has(l.type))
    .sort((a, b) => a.id - b.id);
  if (hosts.length === 0) return;
  const named = typeof event.location_id === 'number' ? hosts.find(h => h.id === event.location_id) : undefined;
  const host = named ?? hosts[hash(event.id, 0xf1e) % hosts.length];
  const { x, y, width, height } = host.position as Rect;
  const l = new Layout(host.position, host.type, event.id);
  // The roof is the top of the footprint (the south wall strip under the eave stays clear);
  // flames sit on the lower slope so they lick up over the ridge.
  const foot = y + Math.max(22, Math.round(height * 0.55));
  const n = Math.max(1, Math.min(3, Math.round(width / 40)));
  for (let i = 0; i < n; i++) {
    const fx = x + (width * (i + 1)) / (n + 1) + l.jit(i, 4);
    const fy = foot + l.jit(10 + i, 3);
    l.add(DECOR_FRAMES.fire, fx, fy, { layer: 'over', frames: 4, fps: 6, solid: false, salt: i });
    // Two puffs half a cycle apart read as a continuous plume.
    l.add(DECOR_FRAMES.smoke, fx + 2, fy - 26, { layer: 'over', frames: 3, fps: 4, solid: false, salt: 20 + i });
    l.add(DECOR_FRAMES.smoke, fx - 3, fy - 36, { layer: 'over', frames: 3, fps: 4, solid: false, salt: 40 + i });
  }
  out.push(...l.out);
}

function sickness(event: any, locations: any[], map: MapPx | null, out: DecorPlacement[]): void {
  // The clinic first; a town without one still quarantines somewhere, so the sign goes up at the
  // town hall (a building with a door), and failing that on the square itself.
  const lowest = (type: string) => {
    let best: any = null;
    for (const l of locations) if (l?.type === type && l.position && (best === null || l.id < best.id)) best = l;
    return best;
  };
  const host = lowest('clinic') ?? lowest('town_hall');
  if (!host) {
    const anchor = findAnchor(SQUARE_FIRST, locations, map, null);
    if (!anchor) return;
    const l = new Layout(anchor.rect, anchor.type, hash(event.id, 0x51c));
    const [wx, wy] = l.slot('w');
    l.add(DECOR_FRAMES.closedSign, wx, wy, { solid: false });
    l.add(DECOR_FRAMES.herbs, wx + 34, wy + 2, { solid: false });
    l.add(DECOR_FRAMES.herbs, wx - 34, wy + 2, { solid: false });
    sicklyAir(l, wx, wy - 8);
    out.push(...l.out);
    return;
  }
  const p = host.position as Rect;
  const l = new Layout(p, host.type, event.id);
  const doorX = host.entry_point && Number.isFinite(host.entry_point.x) ? host.entry_point.x : p.x + p.width / 2;
  const foot = p.y + p.height - 1;
  // Sign beside the door, herbs hung either side of it.
  l.add(DECOR_FRAMES.closedSign, doorX - 22, foot, { solid: false });
  l.add(DECOR_FRAMES.herbs, doorX + 30, foot, { solid: false });
  l.add(DECOR_FRAMES.herbs, doorX - 48, foot, { solid: false });
  sicklyAir(l, doorX, foot - 8);
  out.push(...l.out);
}

/** Greenish haze drifting up in front of the door: the sign says closed, the air says why. */
function sicklyAir(l: Layout, x: number, y: number): void {
  for (let i = 0; i < 3; i++) {
    l.add(DECOR_FRAMES.heatHaze, x - 30 + i * 30 + l.jit(970 + i, 6), y, {
      layer: 'over', solid: false, salt: 80 + i, tint: 0xa8d890,
      motion: { kind: 'fall', dx: l.jit(980 + i, 8), dy: -30, period: 5 + i },
    });
  }
}

/**
 * Where the stranger stands: the road tile closest to the map's border, i.e. where the main road
 * enters town, so they appear to have just walked in. Without roads (or a map) the west edge of
 * the square stands in. Lowest (y, x) breaks ties so every client picks the same tile.
 */
export function strangerSpot(locations: any[], map: MapPx | null, roads: readonly RoadTile[] | null | undefined): { x: number; y: number } | null {
  if (map && roads && roads.length > 0) {
    const wT = Math.floor(map.w / TILE), hT = Math.floor(map.h / TILE);
    let best: RoadTile | null = null, bestD = Infinity;
    for (const t of roads) {
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
      const d = Math.min(t.x, t.y, wT - 1 - t.x, hT - 1 - t.y);
      if (d < bestD || (d === bestD && best && (t.y < best.y || (t.y === best.y && t.x < best.x)))) { best = t; bestD = d; }
    }
    if (best) return { x: best.x * TILE + TILE / 2, y: best.y * TILE + TILE - 3 };
  }
  const anchor = findAnchor(SQUARE_FIRST, locations, map, null);
  if (!anchor) return null;
  return { x: Math.round(anchor.rect.x - 12), y: Math.round(anchor.rect.y + anchor.rect.height * 0.62) };
}

function stranger(event: any, locations: any[], map: MapPx | null, roads: readonly RoadTile[] | null | undefined, out: DecorPlacement[]): void {
  const spot = strangerSpot(locations, map, roads);
  if (!spot) return;
  const area: Rect = { x: spot.x - 64, y: spot.y - 64, width: 128, height: 96 };
  const l = new Layout(area, 'open', event.id);
  l.add(DECOR_FRAMES.stranger, spot.x, spot.y, { frames: 2, fps: 3, solid: false, salt: 1 });
  out.push(...l.out);
}

/** The river's edge as a pixel rect: the park's `riverside` zone, so it follows the zone table. */
export function riverRect(park: any): Rect | null {
  const zone = INTERIOR_ZONES.park?.find(z => z.id === 'riverside');
  if (!zone || zone.tiles.length === 0 || !park?.position) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [tx, ty] of zone.tiles) { x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty); }
  return {
    x: park.position.x + x0 * TILE, y: park.position.y + y0 * TILE,
    width: (x1 - x0 + 1) * TILE, height: (y1 - y0 + 1) * TILE,
  };
}

function bountifulCatch(event: any, locations: any[], map: MapPx | null, out: DecorPlacement[]): void {
  let park: any = null;
  for (const l of locations) if (l?.type === 'park' && l.position && (park === null || l.id < park.id)) park = l;
  const river = riverRect(park);
  if (park && river) {
    const l = new Layout(park.position, 'park', event.id);
    // Fish break the surface in three places, each on its own beat so the water never leaps in unison.
    // The jump cell has its water line 8 px above the foot row and the fish's launch point 6 px left of centre.
    [[0.3, 0.32, 2.0], [0.62, 0.7, 2.5], [0.78, 0.3, 1.7]].forEach(([fx, fy, fps], i) => {
      l.add(DECOR_FRAMES.fishJump, river.x + river.width * fx + 4, river.y + river.height * fy + 8, {
        layer: 'over', solid: false, frames: 6, fps, salt: 30 + i,
      });
    });
    // Landed catch on the bank below the water: crates to the left, a net drying to the right.
    const bank = river.y + river.height + 16;
    l.add(DECOR_FRAMES.fishCrate, river.x + 22, bank, { solid: false });
    l.add(DECOR_FRAMES.fishCrate, river.x + 46, bank + 3, { solid: false });
    l.add(DECOR_FRAMES.netRack, river.x + river.width + 26, bank - 2, { solid: false });
    out.push(...l.out);
    return;
  }
  // No park (or no river in it): the catch is sold from the square, no leaping fish.
  const anchor = findAnchor(SQUARE_FIRST, locations, map, null);
  if (!anchor) return;
  const l = new Layout(anchor.rect, anchor.type, hash(event.id, 0xf15));
  const [cx, cy] = l.slot('sw');
  l.add(DECOR_FRAMES.fishCrate, cx, cy);
  l.add(DECOR_FRAMES.fishCrate, cx + 26, cy + 4, { salt: 2 });
  const [nx, ny] = l.slot('se');
  l.add(DECOR_FRAMES.netRack, nx, ny);
  out.push(...l.out);
}

/**
 * A newcomer's belongings pull up at their new home's door: a cart rolls in from the east and
 * parks, luggage waits by the door, a welcome banner is strung up beside it.
 */
function newArrival(event: any, locations: any[], out: DecorPlacement[]): void {
  if (typeof event.location_id !== 'number') return;
  const home = locations.find(l => l?.id === event.location_id);
  if (!home?.position) return;
  const p = home.position as Rect;
  const ex = home.entry_point && Number.isFinite(home.entry_point.x) ? home.entry_point.x : p.x + p.width / 2;
  const ey = home.entry_point && Number.isFinite(home.entry_point.y) ? home.entry_point.y : p.y + p.height;
  const l = new Layout({ x: p.x - 128, y: p.y - 32, width: p.width + 256, height: p.height + 128 }, 'open', event.id);
  l.add(DECOR_FRAMES.welcome, ex - 56, ey + 2, { frames: 2, fps: 3, solid: false, salt: 1 });
  l.add(DECOR_FRAMES.luggage, ex - 24, ey + 3, { solid: false });
  l.add(DECOR_FRAMES.cart, ex + 40, ey + 9, {
    frames: 2, fps: 6, solid: false, salt: 2,
    motion: { kind: 'arrive', dx: 170, dy: 0, period: 6 },
  });
  // A little confetti over the door for the welcome.
  l.falling(DECOR_FRAMES.confettiFall, 2, ex - 40, ex + 16, ey - 60, { dy: 50, dx: 6, period: 6, salt: 40 });
  out.push(...l.out);
}

/**
 * The open area an anchored event (festival, blessing, full moon...) decorates, for effects that
 * live outside the decor atlas (light shafts, a moon halo) yet must sit on the same square.
 */
export function eventAnchorRect(event: any, locations: any[], map: MapPx | null): Rect | null {
  const spec = event && typeof event.type === 'string' ? RECIPES[event.type] : undefined;
  if (!spec || !Array.isArray(locations)) return null;
  return findAnchor(spec.prefer, locations, map, event.location_id)?.rect ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────

/** Placements for one event, sorted back to front (by foot y). Empty for undecorated types. */
export function planEvent(event: any, locations: any[], map: MapPx | null, roads?: readonly RoadTile[] | null): DecorPlacement[] {
  if (!event || typeof event.type !== 'string' || !Array.isArray(locations)) return [];
  const id = Number.isFinite(event.id) ? (event.id as number) : 0;
  const out: DecorPlacement[] = [];
  if (event.type === 'fire_outbreak') fire({ ...event, id }, locations, out);
  else if (event.type === 'sickness') sickness({ ...event, id }, locations, map, out);
  else if (event.type === 'mysterious_stranger') stranger({ ...event, id }, locations, map, roads, out);
  else if (event.type === 'bountiful_catch') bountifulCatch({ ...event, id }, locations, map, out);
  else if (event.type === 'new_arrival') newArrival({ ...event, id }, locations, out);
  else {
    const spec = RECIPES[event.type];
    if (!spec) return [];
    const anchor = findAnchor(spec.prefer, locations, map, event.location_id);
    if (!anchor) return [];
    const l = new Layout(anchor.rect, anchor.type, hash(id, anchor.rect.x ^ anchor.rect.y));
    spec.recipe(l);
    out.push(...l.out);
  }
  // Stable sort: equal y keeps recipe order (string before the posts it hangs from).
  return out
    .map((p, i) => [p, i] as const)
    .sort((a, b) => a[0].y - b[0].y || a[1] - b[1])
    .map(e => e[0]);
}

const PER_PLACE = new Set(['fire_outbreak', 'new_arrival']);

/**
 * Plans for every active event that has decorations. A type is decorated once — two festivals
 * would stack identical bunting — except events tied to a building, which happen in different
 * places: fires burn different roofs, and two newcomers arrive at two doors.
 */
export function planEventDecor(events: any[], locations: any[], map: MapPx | null, roads?: readonly RoadTile[] | null): EventDecorPlan[] {
  const plans: EventDecorPlan[] = [];
  const seen = new Set<string>();
  for (const e of events ?? []) {
    if (!e || typeof e.type !== 'string') continue;
    if (!PER_PLACE.has(e.type) && seen.has(e.type)) continue;
    const placements = planEvent(e, locations, map, roads);
    if (placements.length === 0) continue;
    seen.add(e.type);
    const followers = weddingFollowers(e);
    plans.push(followers.length > 0 ? { eventId: e.id, type: e.type, placements, followers } : { eventId: e.id, type: e.type, placements });
  }
  return plans;
}
