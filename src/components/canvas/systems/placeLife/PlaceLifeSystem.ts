import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../../../lib/spriteConfig";
import { loadStrip } from "../../stripAtlas";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { detailLevel, inView, type ViewRect } from "../view";
import { makeRng, type Rng } from "../ambientLife/critters";
import {
  GLOW_FRAME_COUNT, GLOW_FRAME_SIZE, GLOW_FRAMES, GLOW_URL, PLACE_FRAMES, PLACE_FRAME_COUNT, PLACE_FRAME_SIZE, PLACE_URL,
} from "./placeFrames";
import {
  chickFrame, crowdLaunch, dustFrame, newChick, particleAlpha, pulseFactor, resetChick,
  sparkFrame, sparkLaunch, stepChick, type ChickState, type Launch, type ParticleKind,
} from "./placeMotion";
import { buildPlacePlan, type PlaceItem } from "./placePlan";
import { computePlaceStates, readClimate } from "./placeState";
import type { Rect } from "./zoneGeometry";

/**
 * Place life: buildings and fields that react to what happens in them.
 *
 * What is going on where comes from `placeState`/`placePlan` (pure, tested); this class turns
 * the resulting plan into sprites and keeps them animated:
 *
 * - The plan is rebuilt on every data poll and diffed by key against what is on screen, so a
 *   forge that goes quiet fades out instead of blinking off. Nothing is computed per frame
 *   beyond animating what is already there.
 * - Static pieces (glows, signs, flags...) use sprites from a capped free list; flying bits
 *   (sparks, notes, chatter, dust) use a fixed pool of 56 whose state objects are mutated in
 *   place. Nothing is allocated in `update`.
 * - Everything off screen is skipped (emitters included); far zoom keeps only the glows and
 *   the flag, the cues that still read from a distance.
 * - Glows are drawn additively on the ground layer (under the agents, above the roofs); the
 *   crowd's music, sparks and dust fly above/below the agents as appropriate.
 */

const MAX_STATIC = 96;
const MAX_PARTICLES = 56;
const FADE_SPEED = 2.2;            // alpha per second, in and out
const VIEW_MARGIN = 48;
const DUST_LIFE = 0.75;
const BELL_AFTERGLOW = 5;          // seconds the bell keeps swinging once the crowd thins
const CELL_FOOT = 15 / 16;         // sprite anchors: feet of the drawn object inside its 16px cell

type ObstacleKind = 'tree' | 'bush' | 'rock' | 'water' | 'pond' | 'river' | 'lake';
const OBSTACLES: ReadonlySet<string> = new Set<ObstacleKind>(['tree', 'bush', 'rock', 'water', 'pond', 'river', 'lake']);

interface Live {
  key: string;
  item: PlaceItem;
  fade: number;
  leaving: boolean;
  phase: number;
  sprite: PIXI.Sprite | null;
  frame: number;
  /** Emitter countdown (seconds). */
  timer: number;
  /** Bell: game-clock second until which it keeps swinging. */
  ringUntil: number;
  chicks: { st: ChickState; sprite: PIXI.Sprite }[] | null;
}

interface Particle {
  active: boolean;
  kind: ParticleKind;
  x: number; y: number; vx: number; vy: number; g: number;
  age: number; life: number;
  frame0: number;
  sway: number;
  frame: number;
  sprite: PIXI.Sprite;
}

/** Stable pseudo-random phase from a key, so a glow keeps its rhythm across polls. */
function hashPhase(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 6283) / 1000;
}

class PlaceLifeSystem implements CanvasSystem {
  private destroyed = false;
  private tex: PIXI.Texture[] | null = null;
  private glowTex: PIXI.Texture[] | null = null;
  private readonly rnd: Rng = makeRng((Math.random() * 4294967296) >>> 0);

  private readonly live = new Map<string, Live>();
  private readonly liveList: Live[] = [];
  private readonly freeSprites: PIXI.Sprite[] = [];
  private staticCount = 0;
  private readonly particles: Particle[] = [];
  private readonly launch: Launch = { vx: 0, vy: 0, g: 0, life: 0 };

  private data: DataContext | null = null;
  private clock = 0;
  private detail: 0 | 1 | 2 = 1;

  // Obstacles for the laundry line, rebuilt only when the world's shape changes.
  private worldSig = '';
  private mapW = 0;
  private readonly blockedTiles = new Set<number>();
  private rects: Rect[] = [];
  private rectIds: number[] = [];

  // Resident positions, refreshed lazily when a chicken yard is on screen.
  private readonly agentX = new Float32Array(64);
  private readonly agentY = new Float32Array(64);
  private agentCount = 0;
  private agentsFresh = false;

  constructor(private readonly layers: CanvasLayers, private readonly services: CanvasServices) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      sprite.eventMode = 'none';
      layers.overAgents.addChild(sprite);
      this.particles.push({
        active: false, kind: 'spark', x: 0, y: 0, vx: 0, vy: 0, g: 0, age: 0, life: 1, frame0: 0, sway: 0, frame: -1, sprite,
      });
    }
    Promise.all([
      loadStrip(PLACE_URL, PLACE_FRAME_COUNT, PLACE_FRAME_SIZE),
      loadStrip(GLOW_URL, GLOW_FRAME_COUNT, GLOW_FRAME_SIZE),
    ]).then(([tex, glow]) => {
      if (this.destroyed) return;
      this.tex = tex;
      this.glowTex = glow;
      if (this.data) this.onData(this.data);
    }).catch(err => {
      console.warn('[place life] atlas failed to load:', err);
    });
  }

  // ── Data ──────────────────────────────────────────────────────────────────────────────

  onData(data: DataContext): void {
    this.data = data;
    if (!this.tex || !this.glowTex || !data.world) return;
    this.rebuildWorld(data);
    const climate = readClimate(data.world, data.events);
    const states = computePlaceStates(data.locations, data.agents, climate);
    const plan = buildPlacePlan({
      locations: data.locations, states, agents: data.agents, climate, isFree: this.isFree,
    });
    this.reconcile(plan);
  }

  /** Roads, trees, rocks, water and building footprints: where a laundry line must not stand. */
  private rebuildWorld(data: DataContext): void {
    const world = data.world;
    const roads: any[] = world.road_tiles ?? [];
    const terrain: any[] = world.terrain_tiles ?? [];
    const locs = data.locations;
    const sig = [world.map_width, roads.length, terrain.length, locs.length].join('|')
      + locs.map((l: any) => l.id + ',' + l.position?.x + ',' + l.position?.y).join(';');
    if (sig === this.worldSig) return;
    this.worldSig = sig;
    this.mapW = world.map_width ?? 0;
    this.blockedTiles.clear();
    for (const r of roads) this.blockedTiles.add(r.y * this.mapW + r.x);
    for (const t of terrain) if (OBSTACLES.has(t.kind)) this.blockedTiles.add(t.y * this.mapW + t.x);
    this.rects = [];
    this.rectIds = [];
    for (const l of locs) {
      if (!l.position?.width) continue;
      this.rects.push(l.position);
      this.rectIds.push(l.id);
    }
  }

  private readonly isFree = (box: Rect, selfId: number): boolean => {
    if (this.mapW <= 0) return false;
    for (let i = 0; i < this.rects.length; i++) {
      if (this.rectIds[i] === selfId) continue;
      const r = this.rects[i];
      if (box.x < r.x + r.width + 4 && box.x + box.width > r.x - 4 && box.y < r.y + r.height + 4 && box.y + box.height > r.y - 4) return false;
    }
    const x0 = Math.floor(box.x / TILE_SIZE), x1 = Math.floor((box.x + box.width) / TILE_SIZE);
    const y0 = Math.floor(box.y / TILE_SIZE), y1 = Math.floor((box.y + box.height) / TILE_SIZE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) if (this.blockedTiles.has(ty * this.mapW + tx)) return false;
    }
    return true;
  };

  /** Diff the new plan against what is on screen: keep, add (fade in) or retire (fade out). */
  private reconcile(plan: PlaceItem[]): void {
    for (const l of this.liveList) l.leaving = true;
    for (const item of plan) {
      const l = this.live.get(item.key) ?? this.create(item);
      if (!l) continue;
      l.item = item;
      l.leaving = false;
      if (item.kind === 'bell' && item.ringing) l.ringUntil = this.clock + BELL_AFTERGLOW;
    }
  }

  private create(item: PlaceItem): Live | null {
    const l: Live = {
      key: item.key, item, fade: 0, leaving: false, phase: hashPhase(item.key), sprite: null, frame: -1,
      timer: this.rnd() * 1.2, ringUntil: 0, chicks: null,
    };
    if (item.kind === 'chickens') {
      const chicks: NonNullable<Live['chicks']> = [];
      for (let i = 0; i < item.count; i++) {
        const sprite = this.acquire();
        if (!sprite) break;
        sprite.anchor.set(0.5, 0.94);
        sprite.scale.set(1);
        chicks.push({ st: resetChick(newChick(), item.rect, this.rnd), sprite });
        // A brown hen now and then: the strip is white and multiplies with the tint.
        sprite.tint = i % 3 === 1 ? 0xd8b088 : 0xffffff;
      }
      l.chicks = chicks;
    } else if (item.kind !== 'sparks' && item.kind !== 'crowd' && item.kind !== 'dust') {
      const sprite = this.acquire();
      if (!sprite) return null;
      this.dress(sprite, item);
      l.sprite = sprite;
    }
    this.live.set(item.key, l);
    this.liveList.push(l);
    return l;
  }

  /** Anchor, blend and position of a static piece: fixed for its whole life. */
  private dress(sprite: PIXI.Sprite, item: PlaceItem): void {
    sprite.tint = 0xffffff;
    sprite.blendMode = 'normal';
    sprite.scale.set(1);
    switch (item.kind) {
      case 'glow':
        sprite.texture = this.glowTex![GLOW_FRAMES[item.shape]];
        sprite.anchor.set(0.5, 0.5);
        sprite.blendMode = 'add';
        sprite.tint = item.tint;
        sprite.scale.set(item.scale);
        break;
      case 'sign': sprite.anchor.set(0.5, 1); break;
      case 'flag': sprite.anchor.set(3.5 / PLACE_FRAME_SIZE, CELL_FOOT); break;
      case 'bell': sprite.anchor.set(1.5 / PLACE_FRAME_SIZE, CELL_FOOT); break;
      case 'hands': sprite.anchor.set(0.5, 0.5); break;
      case 'laundry': sprite.anchor.set(0.5, 1); break;
    }
    sprite.position.set(Math.round(item.x), Math.round(item.y));
  }

  private acquire(): PIXI.Sprite | null {
    let sprite = this.freeSprites.pop();
    if (!sprite) {
      if (this.staticCount >= MAX_STATIC) return null;
      sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.eventMode = 'none';
      this.layers.ground.addChild(sprite);
      this.staticCount++;
    }
    sprite.visible = false;
    sprite.alpha = 0;
    return sprite;
  }

  private release(sprite: PIXI.Sprite): void {
    sprite.visible = false;
    sprite.blendMode = 'normal';
    sprite.tint = 0xffffff;
    this.freeSprites.push(sprite);
  }

  private retire(index: number): void {
    const l = this.liveList[index];
    if (l.sprite) this.release(l.sprite);
    if (l.chicks) for (const c of l.chicks) this.release(c.sprite);
    this.live.delete(l.key);
    const last = this.liveList.pop()!;
    if (last !== l) this.liveList[index] = last;
  }

  // ── Frame ─────────────────────────────────────────────────────────────────────────────

  update(f: FrameContext): void {
    if (!this.tex || !this.glowTex || this.destroyed) return;
    const dt = Math.min(f.seconds, 0.1);
    const view = f.view;
    this.detail = detailLevel(view.scale);
    this.clock += dt;
    this.agentsFresh = false;

    const list = this.liveList;
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      if (l.leaving) {
        l.fade -= dt * FADE_SPEED;
        if (l.fade <= 0) { this.retire(i); continue; }
      } else if (l.fade < 1) {
        l.fade = Math.min(1, l.fade + dt * FADE_SPEED);
      }
      this.animate(l, dt, view);
    }
    this.updateParticles(dt, view);
  }

  private animate(l: Live, dt: number, view: ViewRect): void {
    const item = l.item;
    const near = inView(view, item.x, item.y, item.kind === 'chickens' ? 96 : VIEW_MARGIN);
    const far = this.detail === 0;
    const sprite = l.sprite;
    if (!near) {
      if (sprite) sprite.visible = false;
      if (l.chicks) for (const c of l.chicks) c.sprite.visible = false;
      return;
    }
    // Far zoom: only what still reads as a smudge or a banner from a distance.
    if (far && item.kind !== 'glow' && item.kind !== 'flag') {
      if (sprite) sprite.visible = false;
      if (l.chicks) for (const c of l.chicks) c.sprite.visible = false;
      return;
    }
    const tex = this.tex!;
    const P = PLACE_FRAMES;

    switch (item.kind) {
      case 'glow': {
        const pf = pulseFactor(item.pulse, item.swing, this.clock, l.phase);
        sprite!.alpha = item.alpha * pf * l.fade;
        sprite!.scale.set(item.scale * (0.92 + 0.08 * pf));
        sprite!.visible = true;
        break;
      }
      case 'sign': {
        const rate = this.weatherIsWindy() ? 1.7 : 0.7;
        const idx = Math.floor(this.clock * rate + l.phase) & 1;
        this.show(l, tex[(item.open ? P.signOpen : P.signClosed)[idx]], l.fade);
        break;
      }
      case 'flag': {
        const idx = item.gust
          ? P.flag.gust[Math.floor(this.clock * 9) % 2]
          : P.flag.wave[Math.floor(this.clock * 3.2 + l.phase) % 3];
        this.show(l, tex[idx], l.fade);
        break;
      }
      case 'bell': {
        const idx = this.clock < l.ringUntil
          ? [P.bell.left, P.bell.rest, P.bell.right, P.bell.rest][Math.floor(this.clock * 7) & 3]
          : P.bell.rest;
        this.show(l, tex[idx], l.fade);
        break;
      }
      case 'hands':
        this.show(l, tex[P.hands[Math.floor(this.clock * 0.9 + l.phase) & 1]], l.fade);
        break;
      case 'laundry': {
        const rate = item.windy ? 2.4 : 0.9;
        this.show(l, tex[P.laundry[Math.floor(this.clock * rate + l.phase) & 1]], l.fade);
        break;
      }
      case 'chickens':
        this.animateChickens(l, dt, item.rect);
        break;
      case 'sparks': {
        if (l.fade < 0.5 || l.leaving) break;
        l.timer -= dt;
        if (l.timer > 0) break;
        if (item.mode === 'hammer') {
          l.timer = 0.7 + this.rnd() * 1.0;
          const n = 2 + Math.floor(this.rnd() * 3);
          for (let i = 0; i < n; i++) this.emitSpark(item.x + (this.rnd() - 0.5) * 12, item.y - 6, 'hammer');
        } else {
          l.timer = 1.1 + this.rnd() * 1.3;
          const n = 1 + Math.floor(this.rnd() * 3);
          for (let i = 0; i < n; i++) this.emitSpark(item.x + (this.rnd() - 0.5) * 3, item.y - 1, 'vent');
        }
        break;
      }
      case 'crowd': {
        if (l.fade < 0.5 || l.leaving) break;
        l.timer -= dt;
        if (l.timer > 0) break;
        l.timer = item.interval * (0.7 + this.rnd() * 0.6);
        const x = item.x + (this.rnd() - 0.5) * 14;
        crowdLaunch(this.rnd, this.launch);
        if (this.rnd() < item.notes) this.emit('note', x, item.y, P.note[this.rnd() < 0.5 ? 0 : 1]);
        else this.emit('puff', x, item.y, P.puff[0]);
        break;
      }
      case 'dust': {
        if (l.fade < 0.5 || l.leaving) break;
        l.timer -= dt;
        if (l.timer > 0) break;
        l.timer = 0.55 + this.rnd() * 0.4;
        const sp = this.services.sprites.getSprite(String(item.agentId));
        if (!sp) break;
        this.launch.vx = (this.rnd() - 0.5) * 8;
        this.launch.vy = -5;
        this.launch.g = 0;
        this.launch.life = DUST_LIFE;
        this.emit('dust', sp.container.x + (this.rnd() - 0.5) * 8, sp.container.y - 1, P.dust[0]);
        break;
      }
    }
  }

  private weatherIsWindy(): boolean {
    const w = this.data?.world?.weather;
    return w === 'windy' || w === 'stormy';
  }

  private show(l: Live, texture: PIXI.Texture, alpha: number): void {
    const sprite = l.sprite!;
    sprite.texture = texture;
    sprite.alpha = alpha;
    sprite.visible = true;
  }

  // ── Chickens ──────────────────────────────────────────────────────────────────────────

  private gatherAgents(): void {
    if (this.agentsFresh) return;
    this.agentsFresh = true;
    const agents = this.data?.agents ?? [];
    let n = 0;
    for (let i = 0; i < agents.length && n < this.agentX.length; i++) {
      const sp = this.services.sprites.getSprite(String(agents[i].id));
      if (!sp) continue;
      this.agentX[n] = sp.container.x;
      this.agentY[n] = sp.container.y;
      n++;
    }
    this.agentCount = n;
  }

  private animateChickens(l: Live, dt: number, yard: Rect): void {
    if (!l.chicks) return;
    this.gatherAgents();
    const tex = this.tex!;
    for (const c of l.chicks) {
      const st = c.st;
      let dx = 0, dy = 0, d2 = Infinity;
      for (let i = 0; i < this.agentCount; i++) {
        const ax = st.x - this.agentX[i], ay = st.y - this.agentY[i];
        const dd = ax * ax + ay * ay;
        if (dd < d2) { d2 = dd; dx = ax; dy = ay; }
      }
      stepChick(st, dt, yard, this.rnd, dx, dy, d2);
      const sp = c.sprite;
      sp.texture = tex[chickFrame(st, this.clock)];
      sp.position.set(Math.round(st.x), Math.round(st.y));
      sp.scale.x = st.facing;
      sp.alpha = l.fade;
      sp.visible = true;
    }
  }

  // ── Particles ─────────────────────────────────────────────────────────────────────────

  private emitSpark(x: number, y: number, mode: 'hammer' | 'vent'): void {
    sparkLaunch(mode, this.rnd, this.launch);
    this.emit('spark', x, y, PLACE_FRAMES.spark[0]);
  }

  /** Start one particle from `this.launch`. Silently dropped when the pool is spent. */
  private emit(kind: ParticleKind, x: number, y: number, frame0: number): void {
    let p: Particle | null = null;
    for (let i = 0; i < this.particles.length; i++) {
      if (!this.particles[i].active) { p = this.particles[i]; break; }
    }
    if (!p) return;
    const L = this.launch;
    p.active = true;
    p.kind = kind;
    p.x = x; p.y = y; p.vx = L.vx; p.vy = L.vy; p.g = L.g;
    p.age = 0; p.life = L.life;
    p.frame0 = frame0;
    p.sway = this.rnd() * 6.28;
    p.frame = -1;
    const layer = kind === 'dust' ? this.layers.ground : this.layers.overAgents;
    if (p.sprite.parent !== layer) layer.addChild(p.sprite);
    p.sprite.alpha = 0;
    p.sprite.visible = true;
  }

  private updateParticles(dt: number, view: ViewRect): void {
    const P = PLACE_FRAMES;
    const tex = this.tex!;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life || this.detail === 0 || !inView(view, p.x, p.y, 24)) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      const a = p.age / p.life;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.g * dt;
      let frame = p.frame0;
      let sx = p.x;
      let scale = 1;
      switch (p.kind) {
        case 'spark': frame = sparkFrame(a); break;
        case 'dust': frame = dustFrame(a); break;
        case 'puff':
          frame = P.puff[Math.floor(p.age * 3 + p.sway) & 1];
          sx += Math.sin(p.age * 3 + p.sway) * 3;
          scale = Math.min(1, 0.55 + p.age * 1.5);
          break;
        case 'note':
          sx += Math.sin(p.age * 4 + p.sway) * 4;
          scale = Math.min(1, 0.55 + p.age * 1.5);
          break;
      }
      if (frame !== p.frame) { p.frame = frame; p.sprite.texture = tex[frame]; }
      const sp = p.sprite;
      sp.position.set(Math.round(sx), Math.round(p.y));
      sp.alpha = particleAlpha(p.kind, a);
      sp.scale.set(scale);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const l of this.liveList) {
      l.sprite?.destroy();
      if (l.chicks) for (const c of l.chicks) c.sprite.destroy();
    }
    for (const s of this.freeSprites) s.destroy();
    for (const p of this.particles) p.sprite.destroy();
    this.liveList.length = 0;
    this.live.clear();
    this.freeSprites.length = 0;
    this.particles.length = 0;
  }
}

export const createPlaceLifeSystem: SystemFactory = (layers, services) => new PlaceLifeSystem(layers, services);
