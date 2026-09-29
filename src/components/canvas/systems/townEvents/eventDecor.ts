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

export const DECOR_URL = '/sprites/fx/decor.png';
export const DECOR_FRAME_COUNT = 39;

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
} as const;

/** Row of a cell (0-31) where objects touch the ground; the sprite anchor is (16, 30). */
export const DECOR_FOOT_X = 16;
export const DECOR_FOOT_Y = 30;

export type DecorLayer = 'ground' | 'over';

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
}

export interface EventDecorPlan {
  eventId: number;
  type: string;
  placements: DecorPlacement[];
}

export interface MapPx { w: number; h: number }

interface Rect { x: number; y: number; width: number; height: number }

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

  constructor(readonly r: Rect, readonly type: string, readonly seed: number) {
    this.box = wellBox(r, type);
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
    return true;
  }

  /** Round to whole pixels: the atlas is pixel art and half-pixel sprites shimmer. */
  add(frame: number, x: number, y: number, o: { layer?: DecorLayer; frames?: number; fps?: number; solid?: boolean; salt?: number } = {}): boolean {
    x = Math.round(x); y = Math.round(y);
    const solid = o.solid ?? true;
    if (solid ? !this.free(x, y) : !(x >= this.r.x && x <= this.r.x + this.r.width && y >= this.r.y && y <= this.r.y + this.r.height)) {
      return false;
    }
    const frames = o.frames ?? 1;
    this.out.push({
      frame, x, y,
      layer: o.layer ?? 'ground',
      frames,
      fps: frames > 1 ? (o.fps ?? 4) : 0,
      phase: frames > 1 ? unit(this.seed + (o.salt ?? 0) * 31 + x * 7, y * 13 + frame) : 0,
    });
    return true;
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
  const [wx, wy] = l.slot('w');
  const [ex, ey] = l.slot('e');
  l.add(DECOR_FRAMES.stallRed, wx, wy);
  l.add(DECOR_FRAMES.crate, wx + 30, wy + 2);
  l.add(DECOR_FRAMES.stallBlue, ex, ey);
  l.add(DECOR_FRAMES.crate, ex - 30, ey + 2);
};

const stalls = (points: Slot[], crates: Slot[]): Recipe => l => {
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

const wedding: Recipe = l => {
  l.bunting(l.r.y + 46, DECOR_FRAMES.buntingWhite, DECOR_FRAMES.post, 'ground', 1);
  l.add(DECOR_FRAMES.arch, l.ax, l.nFoot);
  for (const dx of [-32, 0, 32]) l.add(DECOR_FRAMES.petals, l.ax + dx, l.nFoot + 2, { solid: false });
  for (const dx of [-72, 72]) l.add(DECOR_FRAMES.bench, l.ax + dx, l.nFoot);
};

const funeral: Recipe = l => {
  l.bunting(l.r.y + 38, DECOR_FRAMES.buntingDark, DECOR_FRAMES.post, 'ground', 1);
  l.add(DECOR_FRAMES.wreath, l.ax, l.nFoot);
  const flame = { frames: 3, fps: 5, solid: false } as const;
  l.add(DECOR_FRAMES.candle, l.ax - 26, l.nFoot + 2, { ...flame, salt: 1 });
  l.add(DECOR_FRAMES.candle, l.ax + 26, l.nFoot + 2, { ...flame, salt: 2 });
  l.add(DECOR_FRAMES.candle, l.ax - 15, l.nFoot + 4, { ...flame, salt: 3 });
  l.add(DECOR_FRAMES.candle, l.ax + 15, l.nFoot + 4, { ...flame, salt: 4 });
};

const harvest: Recipe = l => {
  const put = (s: Slot, frame: number, offs: readonly (readonly [number, number])[]) => {
    const [x, y] = l.slot(s);
    offs.forEach(([dx, dy], i) => l.add(frame, x + dx + l.jit(i + 1, 3), y + dy + l.jit(i + 40, 2), { salt: i }));
  };
  put('w', DECOR_FRAMES.hay, [[0, 0], [30, 6]]);
  put('e', DECOR_FRAMES.hay, [[0, 0], [-30, 6]]);
  put('nw', DECOR_FRAMES.pumpkin, [[0, 0], [22, 4], [-4, 14]]);
  put('ne', DECOR_FRAMES.pumpkin, [[0, 0], [-22, 4], [4, 14]]);
  put('sw', DECOR_FRAMES.basket, [[0, 0], [24, 2]]);
  put('se', DECOR_FRAMES.basket, [[0, 0], [-24, 2]]);
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
};

const scandal: Recipe = l => {
  const [wx, wy] = l.slot('w');
  const [nx, ny] = l.slot('ne');
  l.add(DECOR_FRAMES.board, wx, wy);
  l.add(DECOR_FRAMES.board, nx, ny);
};

const sparkles = (count: number): Recipe => l => {
  const { r } = l;
  for (let i = 0; i < count; i++) {
    const x = r.x + 16 + Math.floor(unit(l.seed, 500 + i) * (r.width - 32));
    const y = r.y + 24 + Math.floor(unit(l.seed, 900 + i) * (r.height - 28));
    l.add(DECOR_FRAMES.sparkle, x, y, { layer: 'over', frames: 3, fps: 5, solid: false, salt: i });
  }
};

const RECIPES: Record<string, { prefer: readonly string[]; recipe: Recipe }> = {
  festival: { prefer: SQUARE_FIRST, recipe: festival },
  market_day: { prefer: MARKET_FIRST, recipe: stalls(['nw', 'ne', 'sw', 'se'], ['w', 'e']) },
  traveling_merchant: { prefer: MARKET_FIRST, recipe: stalls(['e'], ['e']) },
  wedding: { prefer: SQUARE_FIRST, recipe: wedding },
  funeral: { prefer: SQUARE_FIRST, recipe: funeral },
  harvest: { prefer: SQUARE_FIRST, recipe: harvest },
  competition: { prefer: SQUARE_FIRST, recipe: competition },
  town_meeting: { prefer: SQUARE_FIRST, recipe: townMeeting },
  scandal: { prefer: SQUARE_FIRST, recipe: scandal },
  blessing: { prefer: SQUARE_FIRST, recipe: sparkles(7) },
  starry_night: { prefer: SQUARE_FIRST, recipe: sparkles(6) },
  full_moon: { prefer: SQUARE_FIRST, recipe: sparkles(4) },
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
    l.add(DECOR_FRAMES.smoke, fx + 3, fy - 16, { layer: 'over', frames: 3, fps: 4, solid: false, salt: 20 + i });
    l.add(DECOR_FRAMES.smoke, fx - 4, fy - 20, { layer: 'over', frames: 3, fps: 4, solid: false, salt: 40 + i });
  }
  out.push(...l.out);
}

function sickness(event: any, locations: any[], out: DecorPlacement[]): void {
  let clinic: any = null;
  for (const l of locations) if (l?.type === 'clinic' && l.position && (clinic === null || l.id < clinic.id)) clinic = l;
  if (!clinic) return;
  const p = clinic.position as Rect;
  const l = new Layout(p, 'clinic', event.id);
  const doorX = clinic.entry_point && Number.isFinite(clinic.entry_point.x) ? clinic.entry_point.x : p.x + p.width / 2;
  const foot = p.y + p.height - 1;
  // Sign beside the door, herbs hung either side of it.
  l.add(DECOR_FRAMES.closedSign, doorX - 22, foot, { solid: false });
  l.add(DECOR_FRAMES.herbs, doorX + 20, foot, { solid: false });
  l.add(DECOR_FRAMES.herbs, doorX - 38, foot, { solid: false });
  out.push(...l.out);
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────

/** Placements for one event, sorted back to front (by foot y). Empty for undecorated types. */
export function planEvent(event: any, locations: any[], map: MapPx | null): DecorPlacement[] {
  if (!event || typeof event.type !== 'string' || !Array.isArray(locations)) return [];
  const id = Number.isFinite(event.id) ? (event.id as number) : 0;
  const out: DecorPlacement[] = [];
  if (event.type === 'fire_outbreak') fire({ ...event, id }, locations, out);
  else if (event.type === 'sickness') sickness({ ...event, id }, locations, out);
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

/**
 * Plans for every active event that has decorations. A type is decorated once — two festivals
 * would stack identical bunting — except fires, which burn different roofs.
 */
export function planEventDecor(events: any[], locations: any[], map: MapPx | null): EventDecorPlan[] {
  const plans: EventDecorPlan[] = [];
  const seen = new Set<string>();
  for (const e of events ?? []) {
    if (!e || typeof e.type !== 'string') continue;
    if (e.type !== 'fire_outbreak' && seen.has(e.type)) continue;
    const placements = planEvent(e, locations, map);
    if (placements.length === 0) continue;
    seen.add(e.type);
    plans.push({ eventId: e.id, type: e.type, placements });
  }
  return plans;
}
