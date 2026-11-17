import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../../../lib/spriteConfig";
import { OUTDOOR_TYPES } from "../../../../../server/lib/worldgen/buildingTemplates";
import { INTERIOR_ZONES } from "../../../../../server/data/interiors";
import { loadStrip } from "../../stripAtlas";
import { southWindowXs, WINDOW_CENTER_ABOVE_SOUTH_EDGE } from "../../BuildingRenderer";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { detailLevel, inView, type ViewRect } from "../view";
import { AMBIENT_FRAME_COUNT, AMBIENT_FRAME_SIZE, AMBIENT_URL } from "./ambientFrames";
import { POOL_CAPS, ambientPlan, wellCenter, type AmbientPlan } from "./ambientPlan";
import {
  type BirdState, type ButterflyState, type CatState, type DuckState, type MothState, type Rng,
  birdFrame, butterflyFrame, catFrame, duckFrame, makeRng, mothFrame, newBird, newButterfly, newCat, newDuck,
  newMoth, resetBird, resetButterfly, resetCat, resetDuck, resetMoth, splashFrame, stepBird, stepButterfly,
  stepCat, stepDuck, stepMoth,
} from "./critters";

/**
 * Ambient life: sparrows, butterflies, moths, cats, ducks and the town-square fountain.
 *
 * What to keep alive comes from `ambientPlan` and how each critter behaves from
 * `critters.ts`; this class only owns the sprite pools and the plumbing between them:
 *
 * - Fixed pools sized by POOL_CAPS (32 sprites, hard cap 40), built once. Nothing is
 *   allocated per frame: critter state objects are preallocated and mutated in place.
 * - Critters spawn only inside (or just beside) the view, and are recycled when they
 *   drift out of it, so the headcount is spent where someone is looking.
 * - Walkers live in `layers.ground` (under the agents); flyers in `layers.overAgents`.
 *   A sparrow that takes flight is re-parented up once.
 * - Far zoom (detail 0) hides everything but the fountain.
 */

// How often the system tries to fill one missing critter, and how far off screen one may
// wander before it is recycled.
const SPAWN_INTERVAL = 0.25;
const RECYCLE_MARGIN = 96;
const FADE_IN = 2;            // alpha per second
const FADE_OUT = 1.2;
const BIRD_SPAWN_CLEARANCE = 90;   // px from any resident: a sparrow never lands at their feet
const WELL_RADIUS = 24;            // the basin: critters walk round it, not through it
const MAX_AGENTS = 64;
const MOTHS_PER_WINDOW = 2;
const WATER_KINDS: ReadonlySet<string> = new Set(['water', 'pond', 'river', 'lake']);
const OBSTACLE_KINDS: ReadonlySet<string> = new Set(['tree', 'bush', 'rock']);
const GROUND_KINDS: ReadonlySet<string> = new Set(['grass_tuft', 'flowers', 'dirt_patch']);

/** Whichever critter a pool holds: the shared slot code only moves and fades it. */
type AnyState = BirdState | ButterflyState | MothState | CatState | DuckState;

interface Slot<S> {
  st: S;
  sprite: PIXI.Sprite;
  active: boolean;
  /** Being phased out (plan shrank): fades away instead of counting toward the plan. */
  retiring: boolean;
  fade: number;
  frame: number;
  /** Cat: index into `homes`; moth: window key. */
  key: number;
}

type Kind = 'birds' | 'butterflies' | 'moths' | 'cats' | 'ducks';
const KINDS: readonly Kind[] = ['birds', 'butterflies', 'moths', 'cats', 'ducks'];

interface Home { x: number; y: number }

class AmbientLifeSystem implements CanvasSystem {
  private destroyed = false;
  private tex: PIXI.Texture[] | null = null;
  private readonly rnd: Rng = makeRng((Math.random() * 4294967296) >>> 0);

  private readonly birds: Slot<BirdState>[] = [];
  private readonly butterflies: Slot<ButterflyState>[] = [];
  private readonly moths: Slot<MothState>[] = [];
  private readonly cats: Slot<CatState>[] = [];
  private readonly ducks: Slot<DuckState>[] = [];
  private readonly splash: PIXI.Sprite;
  private splashFrameIdx = -1;

  private data: DataContext | null = null;
  private plan: AmbientPlan = { birds: 0, butterflies: 0, moths: 0, cats: 0, ducks: 0, fountain: true };
  private detail: 0 | 1 | 2 = 1;
  private clock = 0;
  private spawnTimer = 0;
  private spawnTurn = 0;

  // Static world caches, rebuilt only when the world's shape changes (see `worldSig`).
  private worldSig = '';
  private mapW = 0;
  private mapH = 0;
  private groundSpots: number[] = [];      // x,y pairs (px) of grass tufts, flowers, dirt
  private flowerSpots: number[] = [];
  private waterSpots: number[] = [];
  private readonly waterTiles = new Set<number>();
  private readonly obstacleTiles = new Set<number>();
  private solid = new Float32Array(0);      // x,y,w,h of enclosed buildings
  private homes: Home[] = [];
  private well: { x: number; y: number } | null = null;

  // Lit windows at night (x,y pairs) and their keys, refreshed on every poll.
  private lit: number[] = [];
  private litKeys = new Set<number>();

  // Resident positions, refreshed every frame the system is active.
  private readonly agentX = new Float32Array(MAX_AGENTS);
  private readonly agentY = new Float32Array(MAX_AGENTS);
  private agentCount = 0;
  // Result of the last `nearest()` query.
  private nAx = 0;
  private nAy = 0;
  private nD2 = Infinity;

  constructor(private readonly layers: CanvasLayers, private readonly services: CanvasServices) {
    const make = <S,>(layer: PIXI.Container, st: S, ax: number, ay: number): Slot<S> => {
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(ax, ay);
      sprite.visible = false;
      sprite.eventMode = 'none';
      layer.addChild(sprite);
      return { st, sprite, active: false, retiring: false, fade: 0, frame: -1, key: -1 };
    };
    const { ground, overAgents } = layers;
    for (let i = 0; i < POOL_CAPS.birds; i++) this.birds.push(make(ground, newBird(), 0.5, 0.9));
    for (let i = 0; i < POOL_CAPS.butterflies; i++) this.butterflies.push(make(overAgents, newButterfly(), 0.5, 0.5));
    for (let i = 0; i < POOL_CAPS.moths; i++) this.moths.push(make(overAgents, newMoth(), 0.5, 0.5));
    for (let i = 0; i < POOL_CAPS.cats; i++) this.cats.push(make(ground, newCat(), 0.5, 0.94));
    for (let i = 0; i < POOL_CAPS.ducks; i++) this.ducks.push(make(ground, newDuck(), 0.5, 0.8));

    this.splash = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.splash.anchor.set(0.5, 0.5);
    this.splash.visible = false;
    this.splash.alpha = 0.9;
    this.splash.eventMode = 'none';
    ground.addChild(this.splash);

    loadStrip(AMBIENT_URL, AMBIENT_FRAME_COUNT, AMBIENT_FRAME_SIZE).then(tex => {
      if (this.destroyed) return;
      this.tex = tex;
      this.replan();
    }).catch(err => {
      console.warn('[ambient life] critter atlas failed to load:', err);
    });
  }

  // ── Data ──────────────────────────────────────────────────────────────────────────────

  onData(data: DataContext): void {
    this.data = data;
    const world = data.world;
    if (!world) return;
    this.rebuildWorld(data);
    this.rebuildLitWindows(data);
    // A moth whose window went dark leaves with the light.
    for (const m of this.moths) if (m.active && !m.retiring && !this.litKeys.has(m.key)) m.retiring = true;
    this.replan();
  }

  /** Terrain, roads-independent obstacles, buildings, homes and the well: only on change. */
  private rebuildWorld(data: DataContext): void {
    const world = data.world;
    if (!world) return;
    const terrain = world.terrain_tiles ?? [];
    const locs = data.locations;
    const mapW = world.map_width ?? 0, mapH = world.map_height ?? 0;
    const first = terrain[0], last = terrain[terrain.length - 1];
    const sig = [
      mapW, mapH, terrain.length, first ? first.x + ',' + first.y + first.kind : '',
      last ? last.x + ',' + last.y + last.kind : '', locs.length,
    ].join('|') + locs.map((l) => l.id + l.type + l.position.x + ',' + l.position.y).join(';');
    if (sig === this.worldSig) return;
    this.worldSig = sig;

    this.mapW = mapW; this.mapH = mapH;
    this.groundSpots = []; this.flowerSpots = []; this.waterSpots = [];
    this.waterTiles.clear(); this.obstacleTiles.clear();
    for (const t of terrain) {
      const cx = t.x * TILE_SIZE + TILE_SIZE / 2, cy = t.y * TILE_SIZE + TILE_SIZE / 2;
      const key = t.y * mapW + t.x;
      if (GROUND_KINDS.has(t.kind)) {
        this.groundSpots.push(cx, cy);
        if (t.kind === 'flowers') this.flowerSpots.push(cx, cy);
      } else if (WATER_KINDS.has(t.kind)) {
        this.waterTiles.add(key);
        this.waterSpots.push(cx, cy);
      } else if (OBSTACLE_KINDS.has(t.kind)) {
        this.obstacleTiles.add(key);
      }
    }

    const solid: number[] = [];
    const homes: (Home & { id: number })[] = [];
    let well: { x: number; y: number } | null = null;
    for (const l of locs) {
      const p = l.position;
      if (!OUTDOOR_TYPES.has(l.type)) solid.push(p.x, p.y, p.width, p.height);
      if (l.type === 'home' && l.entry_point) homes.push({ id: l.id, x: l.entry_point.x, y: l.entry_point.y + 12 });
      if (l.type === 'town_square') well = wellCenter(p);
      // Worldgen lays no water terrain; the park's riverside zone is the only water on the
      // map (drawn as river tiles), so it is where the ducks swim.
      if (l.type === 'park') {
        const river = INTERIOR_ZONES.park?.find(z => z.id === 'riverside');
        const tx0 = Math.floor(p.x / TILE_SIZE), ty0 = Math.floor(p.y / TILE_SIZE);
        for (const [tx, ty] of river?.tiles ?? []) {
          const key = (ty0 + ty) * mapW + (tx0 + tx);
          if (this.waterTiles.has(key)) continue;
          this.waterTiles.add(key);
          this.waterSpots.push((tx0 + tx) * TILE_SIZE + TILE_SIZE / 2, (ty0 + ty) * TILE_SIZE + TILE_SIZE / 2);
        }
      }
    }
    homes.sort((a, b) => a.id - b.id);
    this.solid = Float32Array.from(solid);
    this.homes = homes;
    this.well = well;
    // The old critters belong to the old world.
    this.hideAll();
  }

  private rebuildLitWindows(data: DataContext): void {
    this.lit.length = 0;
    this.litKeys.clear();
    if (data.world?.day_phase !== 'night') return;
    const occupied = new Set<number>();
    for (const a of data.agents) if (a.current_location != null) occupied.add(a.current_location);
    for (const l of data.locations) {
      if (l.type !== 'home' || !occupied.has(l.id) || !l.entry_point) continue;
      const wy = l.position.y + l.position.height - WINDOW_CENTER_ABOVE_SOUTH_EDGE;
      const xs = southWindowXs(l);
      for (let i = 0; i < xs.length; i++) {
        this.lit.push(xs[i], wy);
        this.litKeys.add(l.id * 4 + i);
      }
    }
  }

  private replan(): void {
    const w = this.data?.world;
    this.plan = ambientPlan({
      dayPhase: w?.day_phase,
      weather: w?.weather,
      season: w?.time?.season,
      mapW: this.mapW,
      mapH: this.mapH,
      detail: this.detail,
      homes: this.homes.length,
      litWindows: this.lit.length / 2,
      waterTiles: this.waterTiles.size,
    });
    if (this.detail === 0) { this.hideAll(); return; }
    for (const kind of KINDS) this.retireSurplus(kind);
  }

  /** The plan shrank: send the surplus away (birds fly off, the rest fade). */
  private retireSurplus(kind: Kind): void {
    const pool = this.pool(kind);
    let live = 0;
    for (const s of pool) if (s.active && !s.retiring) live++;
    for (let i = pool.length - 1; i >= 0 && live > this.plan[kind]; i--) {
      const s = pool[i];
      if (!s.active || s.retiring) continue;
      s.retiring = true;
      live--;
      if (kind === 'birds') {
        const b = s.st as BirdState;
        if (b.mode !== 'flee') stepBird(b, 0, b.facing * 10, 5, 125, this.rnd, this.blocked);
      }
    }
  }

  private pool(kind: Kind): Slot<AnyState>[] {
    return this[kind];
  }

  // ── Frame ─────────────────────────────────────────────────────────────────────────────

  update(f: FrameContext): void {
    if (!this.tex || this.destroyed) return;
    const dt = Math.min(f.seconds, 0.1);
    const view = f.view;
    const detail = detailLevel(view.scale);
    if (detail !== this.detail) { this.detail = detail; this.replan(); }
    this.clock += dt;
    this.updateFountain(view);
    if (this.detail === 0 || !this.data) return;

    this.gatherAgents();
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      this.spawnOne(view);
    }
    this.updateBirds(dt, view);
    this.updateButterflies(dt, view);
    this.updateMoths(dt, view);
    this.updateCats(dt, view);
    this.updateDucks(dt, view);
  }

  private updateFountain(view: ViewRect): void {
    const s = this.splash;
    if (!this.well || !this.plan.fountain || !this.tex || !inView(view, this.well.x, this.well.y, 24)) {
      s.visible = false;
      return;
    }
    const idx = splashFrame(this.clock);
    if (idx !== this.splashFrameIdx) { this.splashFrameIdx = idx; s.texture = this.tex[idx]; }
    s.position.set(this.well.x, this.well.y);
    s.visible = true;
  }

  private gatherAgents(): void {
    const agents = this.data!.agents;
    let n = 0;
    for (let i = 0; i < agents.length && n < MAX_AGENTS; i++) {
      const sp = this.services.sprites.getSprite(String(agents[i].id));
      if (!sp) continue;
      this.agentX[n] = sp.container.x;
      this.agentY[n] = sp.container.y;
      n++;
    }
    this.agentCount = n;
  }

  /** Nearest resident to (x, y): fills nAx/nAy/nD2 (Infinity when the town is empty). */
  private nearest(x: number, y: number): void {
    let best = Infinity, bx = 0, by = 0;
    for (let i = 0; i < this.agentCount; i++) {
      const dx = this.agentX[i] - x, dy = this.agentY[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; bx = this.agentX[i]; by = this.agentY[i]; }
    }
    this.nAx = bx; this.nAy = by; this.nD2 = best;
  }

  // ── Ground rules shared by the walkers ────────────────────────────────────────────────

  /** Point in a building, a tree/bush/rock tile, or off the map: not walkable. */
  private readonly blocked = (x: number, y: number): boolean => {
    if (this.mapW > 0 && (x < 0 || y < 0 || x >= this.mapW * TILE_SIZE || y >= this.mapH * TILE_SIZE)) return true;
    const r = this.solid;
    for (let i = 0; i < r.length; i += 4) {
      if (x >= r[i] - 2 && x <= r[i] + r[i + 2] + 2 && y >= r[i + 1] - 2 && y <= r[i + 1] + r[i + 3] + 2) return true;
    }
    const well = this.well;
    if (well) {
      const dx = x - well.x, dy = y - well.y;
      if (dx * dx + dy * dy < WELL_RADIUS * WELL_RADIUS) return true;
    }
    return this.obstacleTiles.size > 0 && this.obstacleTiles.has(this.tileKey(x, y));
  };

  private readonly isWater = (x: number, y: number): boolean => this.waterTiles.has(this.tileKey(x, y));

  private tileKey(x: number, y: number): number {
    return Math.floor(y / TILE_SIZE) * this.mapW + Math.floor(x / TILE_SIZE);
  }

  // ── Spawning ──────────────────────────────────────────────────────────────────────────

  /** Fill at most one missing critter per call, rotating through the kinds so none starves. */
  private spawnOne(view: ViewRect): void {
    for (let i = 0; i < KINDS.length; i++) {
      const kind = KINDS[(this.spawnTurn + i) % KINDS.length];
      const pool = this.pool(kind);
      let live = 0, free: Slot<AnyState> | null = null;
      for (const s of pool) {
        if (s.active) { if (!s.retiring) live++; } else if (!free) free = s;
      }
      if (!free || live >= this.plan[kind]) continue;
      if (this.trySpawn(kind, free, view)) { this.spawnTurn = (this.spawnTurn + i + 1) % KINDS.length; return; }
    }
  }

  private trySpawn(kind: Kind, slot: Slot<AnyState>, view: ViewRect): boolean {
    switch (kind) {
      case 'birds': return this.spawnBird(slot as Slot<BirdState>, view);
      case 'butterflies': return this.spawnButterfly(slot as Slot<ButterflyState>, view);
      case 'moths': return this.spawnMoth(slot as Slot<MothState>, view);
      case 'cats': return this.spawnCat(slot as Slot<CatState>, view);
      case 'ducks': return this.spawnDuck(slot as Slot<DuckState>, view);
    }
  }

  private activate(slot: Slot<AnyState>, layer: PIXI.Container): void {
    slot.active = true;
    slot.retiring = false;
    slot.fade = 0;
    slot.frame = -1;
    slot.sprite.alpha = 0;
    slot.sprite.visible = true;
    if (slot.sprite.parent !== layer) layer.addChild(slot.sprite);
  }

  private deactivate(slot: Slot<AnyState>): void {
    slot.active = false;
    slot.retiring = false;
    slot.sprite.visible = false;
  }

  private hideAll(): void {
    for (const kind of KINDS) for (const s of this.pool(kind)) if (s.active) this.deactivate(s);
  }

  private setFrame(slot: Slot<AnyState>, frame: number): void {
    if (slot.frame === frame || !this.tex) return;
    slot.frame = frame;
    slot.sprite.texture = this.tex[frame];
  }

  /** Fade toward 1 (or toward 0 while retiring) and recycle once invisible. Returns alpha. */
  private fadeOf(slot: Slot<AnyState>, dt: number): number {
    if (slot.retiring) {
      slot.fade -= dt * FADE_OUT;
      if (slot.fade <= 0) { this.deactivate(slot); return 0; }
    } else if (slot.fade < 1) {
      slot.fade = Math.min(1, slot.fade + dt * FADE_IN);
    }
    return slot.fade;
  }

  private tooClose(pool: Slot<AnyState>[], x: number, y: number, r: number): boolean {
    for (const s of pool) {
      if (!s.active) continue;
      const dx = s.st.x - x, dy = s.st.y - y;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  private spawnBird(slot: Slot<BirdState>, view: ViewRect): boolean {
    const spots = this.groundSpots, n = spots.length / 2;
    for (let tries = 0; tries < 14; tries++) {
      let x: number, y: number;
      if (n > 0) {
        const i = Math.floor(this.rnd() * n);
        x = spots[2 * i] + (this.rnd() - 0.5) * 12;
        y = spots[2 * i + 1] + (this.rnd() - 0.5) * 8;
      } else {
        x = view.x + this.rnd() * view.w;
        y = view.y + this.rnd() * view.h;
      }
      if (!inView(view, x, y, 0) || this.blocked(x, y)) continue;
      this.nearest(x, y);
      if (this.nD2 < BIRD_SPAWN_CLEARANCE * BIRD_SPAWN_CLEARANCE) continue;
      if (this.tooClose(this.birds, x, y, 24)) continue;
      resetBird(slot.st, x, y, this.rnd);
      this.activate(slot, this.layers.ground);
      return true;
    }
    return false;
  }

  private spawnButterfly(slot: Slot<ButterflyState>, view: ViewRect): boolean {
    const spots = this.flowerSpots.length > 0 ? this.flowerSpots : this.groundSpots;
    const n = spots.length / 2;
    if (n === 0) return false;
    for (let tries = 0; tries < 14; tries++) {
      const i = Math.floor(this.rnd() * n);
      const x = spots[2 * i], y = spots[2 * i + 1] - 8;
      if (!inView(view, x, y, 24)) continue;
      if (this.tooClose(this.butterflies, x, y, 30)) continue;
      resetButterfly(slot.st, x, y, this.rnd);
      this.activate(slot, this.layers.overAgents);
      return true;
    }
    return false;
  }

  private spawnMoth(slot: Slot<MothState>, view: ViewRect): boolean {
    const w = this.lit;
    for (let i = 0; i < w.length; i += 2) {
      const key = this.keyOfWindow(i / 2);
      if (!inView(view, w[i], w[i + 1], 24)) continue;
      let used = 0;
      for (const m of this.moths) if (m.active && !m.retiring && m.key === key) used++;
      if (used >= MOTHS_PER_WINDOW) continue;
      resetMoth(slot.st, w[i], w[i + 1], this.rnd);
      slot.key = key;
      this.activate(slot, this.layers.overAgents);
      return true;
    }
    return false;
  }

  /** Stable key of the n-th lit window, matching `litKeys` (home id * 4 + window index). */
  private keyOfWindow(n: number): number {
    let i = 0;
    for (const k of this.litKeys) { if (i++ === n) return k; }
    return -1;
  }

  private spawnCat(slot: Slot<CatState>, view: ViewRect): boolean {
    const homes = this.homes, n = homes.length;
    if (n < 2) return false;
    for (let k = 0; k < this.plan.cats; k++) {
      const h = homes[(k * 4 + 1) % n];
      let taken = false;
      for (const c of this.cats) if (c.active && !c.retiring && c.key === k) { taken = true; break; }
      if (taken || !inView(view, h.x, h.y, 64)) continue;
      resetCat(slot.st, h.x, h.y, this.rnd);
      slot.key = k;
      this.activate(slot, this.layers.ground);
      return true;
    }
    return false;
  }

  private spawnDuck(slot: Slot<DuckState>, view: ViewRect): boolean {
    const spots = this.waterSpots, n = spots.length / 2;
    if (n === 0) return false;
    for (let tries = 0; tries < 14; tries++) {
      const i = Math.floor(this.rnd() * n);
      const x = spots[2 * i], y = spots[2 * i + 1];
      if (!inView(view, x, y, 16) || this.tooClose(this.ducks, x, y, 24)) continue;
      resetDuck(slot.st, x, y, this.rnd);
      this.activate(slot, this.layers.ground);
      return true;
    }
    return false;
  }

  // ── Per-critter updates ───────────────────────────────────────────────────────────────

  private updateBirds(dt: number, view: ViewRect): void {
    const pool = this.birds;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.active) continue;
      const b = s.st;
      if (!inView(view, b.x, b.y, RECYCLE_MARGIN)) { this.deactivate(s); continue; }
      this.nearest(b.x, b.y);
      stepBird(b, dt, b.x - this.nAx, b.y - this.nAy, this.nD2, this.rnd, this.blocked);
      if (b.gone) { this.deactivate(s); continue; }
      const flying = b.mode === 'flee';
      // Airborne birds pass over the residents; on the ground they stay underfoot.
      const layer = flying ? this.layers.overAgents : this.layers.ground;
      if (s.sprite.parent !== layer) layer.addChild(s.sprite);
      // A retiring sparrow keeps its alpha and simply flies away.
      let alpha = s.retiring ? s.fade : this.fadeOf(s, dt);
      if (!s.active) continue;
      // Melt out over the last moments of the flight instead of vanishing mid-screen.
      if (flying) alpha *= Math.max(0, Math.min(1, (b.dur - b.t) / 0.6));
      this.setFrame(s, birdFrame(b));
      const sp = s.sprite;
      sp.position.set(Math.round(b.x), Math.round(b.y - b.lift));
      sp.scale.x = b.facing;
      sp.alpha = alpha;
    }
  }

  private updateButterflies(dt: number, view: ViewRect): void {
    const pool = this.butterflies;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.active) continue;
      const b = s.st;
      if (!inView(view, b.x, b.y, RECYCLE_MARGIN)) { this.deactivate(s); continue; }
      stepButterfly(b, dt, this.rnd);
      const alpha = this.fadeOf(s, dt);
      if (!s.active) continue;
      this.setFrame(s, butterflyFrame(b));
      const sp = s.sprite;
      sp.position.set(Math.round(b.x), Math.round(b.y + b.bob));
      sp.scale.x = b.facing;
      sp.alpha = alpha;
    }
  }

  private updateMoths(dt: number, view: ViewRect): void {
    const pool = this.moths;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.active) continue;
      const m = s.st;
      if (!inView(view, m.x, m.y, RECYCLE_MARGIN)) { this.deactivate(s); continue; }
      stepMoth(m, dt, this.rnd);
      const alpha = this.fadeOf(s, dt);
      if (!s.active) continue;
      this.setFrame(s, mothFrame(m));
      const sp = s.sprite;
      sp.position.set(Math.round(m.x), Math.round(m.y));
      sp.scale.x = m.facing;
      sp.alpha = alpha;
    }
  }

  private updateCats(dt: number, view: ViewRect): void {
    const pool = this.cats;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.active) continue;
      const c = s.st;
      if (!inView(view, c.x, c.y, RECYCLE_MARGIN)) { this.deactivate(s); continue; }
      this.nearest(c.x, c.y);
      stepCat(c, dt, this.rnd, this.blocked, this.nD2, this.nAx, this.nAy);
      const alpha = this.fadeOf(s, dt);
      if (!s.active) continue;
      this.setFrame(s, catFrame(c));
      const sp = s.sprite;
      sp.position.set(Math.round(c.x), Math.round(c.y));
      sp.scale.x = c.facing;
      sp.alpha = alpha;
    }
  }

  private updateDucks(dt: number, view: ViewRect): void {
    const pool = this.ducks;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.active) continue;
      const d = s.st;
      if (!inView(view, d.x, d.y, RECYCLE_MARGIN)) { this.deactivate(s); continue; }
      stepDuck(d, dt, this.rnd, this.isWater);
      const alpha = this.fadeOf(s, dt);
      if (!s.active) continue;
      this.setFrame(s, duckFrame(d));
      const sp = s.sprite;
      sp.position.set(Math.round(d.x), Math.round(d.y));
      sp.scale.x = d.facing;
      sp.alpha = alpha;
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const kind of KINDS) {
      for (const s of this.pool(kind)) s.sprite.destroy();
      this.pool(kind).length = 0;
    }
    this.splash.destroy();
  }
}

export const createAmbientLifeSystem: SystemFactory = (layers, services) =>
  new AmbientLifeSystem(layers, services);
