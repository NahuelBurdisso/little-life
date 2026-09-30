import * as PIXI from "pixi.js";
import { actionTypeOf } from "../../SpritePool";
import type { AgentData } from "../../SpritePool";
import type { AgentSprite } from "../../AgentSprite";
import { loadStrip } from "../../stripAtlas";
import { OUTDOOR_TYPES } from "../../../../../server/lib/worldgen/buildingTemplates";
import { detailLevel, inView } from "../view";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { activityFor, isAudienceActivity, isPerformerActivity } from "./activity";
import type { ActivityId } from "./activity";
import { ACTIVITY_FX_URL, FX_CELLS, FX_CELL_COUNT, FX_CELL_SIZE, fxCellAt } from "./activityFrames";
import { ACTIVITY_SPECS, DRUNK_LOOP, END_EMOTE_MIN_S } from "./activitySpecs";
import type { ActivitySpec, LoopEmote } from "./activitySpecs";
import { agentPhase, crossedUp, inWindow, shotIndex, shotsBetween } from "./emitters";
import type { EmitterSpec } from "./emitters";

/** Live particles per layer; a spawn with the pool full is dropped rather than recycled. */
const POOL_GROUND = 28;
const POOL_OVER = 44;
/** Most shots one emitter may fire in a single frame (a long frame must not burst). */
const MAX_SHOTS_PER_FRAME = 2;
/** The body's `workStroke` counts as a strike when it rises through this. */
const STRIKE_LINE = 0.85;
/** Below this `lyingBlend` the body is upright enough to be seen doing things. */
const LYING_HIDE_ABOVE = 0.3;
/** Another awake agent this close (server px) makes a socializing agent part of a group. */
const NEAR_PX = 72;
/** A performer this close (server px) draws a watcher's eyes. */
const AUDIENCE_PX = 260;
/** Romance score past which the mingle emote is a heart, not a sparkle. */
const ROMANCE_HEART = 40;
/** Last share of a particle's life spent fading out. */
const FADE_FRACTION = 0.35;

interface Particle {
  sprite: PIXI.Sprite;
  active: boolean;
  spec: EmitterSpec | null;
  age: number;
  life: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  /** Fixed cell for 'pick' particles; -1 = follow the animation. */
  cell: number;
  shown: number;
}

interface Pool {
  layer: PIXI.Container;
  items: Particle[];
}

interface Entry {
  id: string;
  numId: number;
  /** Per-agent seconds added to the shared clock so neighbours do not puff in lockstep. */
  phase: number;
  activity: ActivityId;
  /** performance.now() when the current activity began. */
  since: number;
  sprite: AgentSprite | null;
  /** The sprite the pose was last applied to; a rebuilt sprite needs it again. */
  posed: AgentSprite | null;
  prevClock: number;
  prevStroke: number;
  drunk: boolean;
  /** Standing by someone they are romantically involved with (mingle's heart). */
  romantic: boolean;
  bobber: PIXI.Sprite | null;
  /**
   * Middle of the top edge of the building the agent is inside, for `at: 'roof'` emitters; `hasRoof`
   * is false out of doors (a road, a park, a farmyard), where there is no roofline to anchor to.
   */
  hasRoof: boolean;
  roofX: number;
  roofY: number;
  seen: number;
}

/**
 * What agents are doing, shown on the agent: posture, a repeating emote, and small pooled
 * particles at the hands and feet (sweat and dust for a jogger, steam off the plate, a bobber
 * with ripples, sparks at the anvil...). The choice of activity is `activityFor`, the look of
 * each is data in `activitySpecs`; this class only decides once per poll and animates per frame.
 *
 * Cost: every particle is a pooled sprite (no allocations per frame), spawns are skipped for
 * agents off screen and at far zoom, and the pools cap the total.
 */
class ActivityFxSystem implements CanvasSystem {
  private textures: PIXI.Texture[] | null = null;
  private ground: Pool;
  private over: Pool;
  private readonly entries = new Map<string, Entry>();
  /** Same entries as an array, so the per-frame loop allocates no iterator. */
  private list: Entry[] = [];
  private readonly locationTypes = new Map<number, string>();
  /** Footprint of every location (the rows' own `position` objects, not copies). */
  private readonly locationRects = new Map<number, { x: number; y: number; width: number }>();
  private readonly romantic = new Set<string>();
  /** Reused for emote positions: `showEmote` reads it immediately. */
  private readonly pt = { x: 0, y: 0 };
  private generation = 0;
  private destroyed = false;

  constructor(layers: CanvasLayers, private readonly services: CanvasServices) {
    this.ground = { layer: layers.ground, items: [] };
    this.over = { layer: layers.overAgents, items: [] };
    loadStrip(ACTIVITY_FX_URL, FX_CELL_COUNT, FX_CELL_SIZE)
      .then(t => {
        if (this.destroyed) return;
        this.textures = t;
        this.fill(this.ground, POOL_GROUND);
        this.fill(this.over, POOL_OVER);
      })
      // Postures and emotes still work without the particle atlas.
      .catch(err => console.warn("[activity fx] atlas failed to load:", err));
  }

  private fill(pool: Pool, n: number): void {
    for (let i = 0; i < n; i++) {
      const sprite = new PIXI.Sprite(this.textures![0]);
      sprite.anchor.set(0.5);
      sprite.eventMode = "none";
      sprite.visible = false;
      pool.layer.addChild(sprite);
      pool.items.push({
        sprite, active: false, spec: null, age: 0, life: 1, x: 0, y: 0, vx: 0, vy: 0, face: 1, cell: -1, shown: -1,
      });
    }
  }

  // ── Once per poll ─────────────────────────────────────────────────────────────────────────

  onData(data: DataContext): void {
    this.generation++;
    const now = performance.now();

    this.locationTypes.clear();
    this.locationRects.clear();
    for (const l of data.locations) {
      if (typeof l?.id === "number" && typeof l?.type === "string") {
        this.locationTypes.set(l.id, l.type);
        if (l.position) this.locationRects.set(l.id, l.position);
      }
    }
    this.romantic.clear();
    for (const r of data.relationships ?? []) {
      if ((r?.romance_ab ?? 0) > ROMANCE_HEART || (r?.romance_ba ?? 0) > ROMANCE_HEART) {
        this.romantic.add(pairKey(r.agent_a, r.agent_b));
      }
    }

    let changed = false;
    for (const agent of data.agents) {
      const id = String(agent.id);
      let e = this.entries.get(id);
      if (!e) {
        e = {
          id, numId: Number(agent.id), phase: agentPhase(agent.id), activity: "none", since: now,
          sprite: null, posed: null, prevClock: 0, prevStroke: 0, drunk: false, romantic: false, bobber: null,
          hasRoof: false, roofX: 0, roofY: 0, seen: 0,
        };
        this.entries.set(id, e);
        changed = true;
      }
      e.seen = this.generation;
      e.sprite = this.services.sprites.getSprite(id) ?? null;
      e.drunk = (agent.activeStates ?? []).some(s => s.type === "drunk");
      this.anchorRoof(e, agent);

      const next = this.activityOf(agent, data.agents);
      if (next !== e.activity) this.switchActivity(e, next, now);
      else if (e.sprite !== e.posed) this.applyPose(e);
      e.romantic = next === "mingle" && this.nearRomantic(agent, data.agents);
    }

    for (const e of this.list) {
      if (e.seen !== this.generation) {
        this.dropBobber(e);
        this.entries.delete(e.id);
        changed = true;
      }
    }
    if (changed) this.list = Array.from(this.entries.values());

    this.faceThePerformers(data.agents);
  }

  /** Remember where the roofline of the building this agent is in is (or that there is none). */
  private anchorRoof(e: Entry, agent: AgentData): void {
    const here = agent.current_location;
    const rect = here != null ? this.locationRects.get(here) : undefined;
    const type = here != null ? this.locationTypes.get(here) : undefined;
    e.hasRoof = !!rect && type !== undefined && !OUTDOOR_TYPES.has(type);
    if (e.hasRoof) {
      e.roofX = rect!.x + rect!.width / 2;
      e.roofY = rect!.y;
    }
  }

  private activityOf(agent: AgentData, all: AgentData[]): ActivityId {
    const raw = agent.current_action;
    const zone = typeof raw === "object" && raw ? (raw as { zoneActivity?: string }).zoneActivity : undefined;
    const type = actionTypeOf(agent);
    const here = agent.current_location ?? null;
    return activityFor({
      actionType: type,
      zoneActivity: zone ?? null,
      atWorkplace: agent.workplace != null && here === agent.workplace,
      workplaceType: agent.workplace != null ? this.locationTypes.get(agent.workplace) ?? null : null,
      nearOthers: type === "socializing" && hasNeighbour(agent, all),
    });
  }

  private switchActivity(e: Entry, next: ActivityId, now: number): void {
    const prev = e.activity;
    const lasted = (now - e.since) / 1000;
    e.activity = next;
    e.since = now;
    this.applyPose(e);
    if (!e.sprite) return;

    this.pt.x = e.sprite.x;
    this.pt.y = e.sprite.y;
    const before = ACTIVITY_SPECS[prev];
    if (before.endEmote && lasted >= END_EMOTE_MIN_S) {
      this.services.bubbles.showEmote(e.id, before.endEmote, this.pt);
    }
    const spec = ACTIVITY_SPECS[next];
    if (spec.startEmote) this.services.bubbles.showEmote(e.id, spec.startEmote, this.pt);
    if (!spec.bobber) this.dropBobber(e);
  }

  private applyPose(e: Entry): void {
    const spec = ACTIVITY_SPECS[e.activity];
    e.sprite?.setActivityPose(spec.pose, spec.tint ?? 0xffffff);
    e.posed = e.sprite;
  }

  private nearRomantic(agent: AgentData, all: AgentData[]): boolean {
    for (const o of all) {
      if (o.id === agent.id || !isNear(agent, o)) continue;
      if (this.romantic.has(pairKey(agent.id, o.id))) return true;
    }
    return false;
  }

  /** Watchers turn to look at whoever is on stage, nearest first. */
  private faceThePerformers(agents: AgentData[]): void {
    for (const e of this.list) {
      if (!isAudienceActivity(e.activity) || !e.sprite) continue;
      const me = agents.find(a => a.id === e.numId);
      if (!me) continue;
      let best: AgentData | null = null;
      let bestD = AUDIENCE_PX;
      for (const o of agents) {
        if (o.id === me.id) continue;
        const oe = this.entries.get(String(o.id));
        if (!oe || !isPerformerActivity(oe.activity)) continue;
        const d = dist(me, o);
        if (d < bestD) { best = o; bestD = d; }
      }
      if (best) {
        const dx = (best.position?.x ?? 0) - (me.position?.x ?? 0);
        if (Math.abs(dx) > 4) e.sprite.setFacing(dx < 0 ? -1 : 1);
      }
    }
  }

  // ── Every frame ───────────────────────────────────────────────────────────────────────────

  update(frame: FrameContext): void {
    const textures = this.textures;
    const detail = detailLevel(frame.view.scale);
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      try {
        this.animateEntry(e, frame, detail);
      } catch (err) {
        console.warn("[activity fx] update failed:", err);
      }
    }
    if (!textures) return;
    this.stepPool(this.ground, frame);
    this.stepPool(this.over, frame);
  }

  private animateEntry(e: Entry, frame: FrameContext, detail: 0 | 1 | 2): void {
    const clock = frame.now / 1000 + e.phase;
    const sprite = e.sprite;
    const prevClock = e.prevClock || clock;
    e.prevClock = clock;
    if (!sprite || sprite.container.destroyed) return;

    const stroke = sprite.workStroke;
    const prevStroke = e.prevStroke;
    e.prevStroke = stroke;

    // Off screen, lying down or between two steps: nothing to see, nothing to spend. The roofline
    // is the exception (a bed indoors is exactly where a house has something to show), so an agent
    // who is on screen but not standing still runs only the `at: 'roof'` emitters.
    const onScreen = inView(frame.view, sprite.x, sprite.y);
    const bodyShows = onScreen && sprite.lyingBlend < LYING_HIDE_ABOVE && !sprite.isWalking;
    if (!bodyShows) {
      if (e.bobber) e.bobber.visible = false;
      if (onScreen && detail > 0) this.stepRoofEmitters(e, frame, prevClock, clock);
      return;
    }

    const spec = ACTIVITY_SPECS[e.activity];
    if (spec.loopEmotes) {
      for (const le of spec.loopEmotes) this.loopEmote(e, le, prevClock, clock, sprite);
    }
    if (e.drunk) this.loopEmote(e, DRUNK_LOOP, prevClock, clock, sprite);

    if (detail === 0) {
      if (e.bobber) e.bobber.visible = false;
      return;
    }
    if (spec.bobber) this.stepBobber(e, spec, clock, sprite);
    const emitters = spec.emitters;
    if (!emitters || !this.textures) return;
    const strike = crossedUp(prevStroke, stroke, STRIKE_LINE);
    for (let i = 0; i < emitters.length; i++) {
      const em = emitters[i];
      if (em.minDetail && detail < em.minDetail) continue;
      let shots = em.trigger === 'stroke'
        ? (strike ? 1 : 0)
        : shotsBetween(em.every ?? 1, em.offset ?? 0, prevClock, clock);
      if (shots === 0 || (em.window && !inWindow(em.window, clock))) continue;
      if (shots > MAX_SHOTS_PER_FRAME) shots = MAX_SHOTS_PER_FRAME;
      const n = shots * (em.count ?? 1);
      for (let k = 0; k < n; k++) this.spawn(em, spec, e);
    }
  }

  /** Fire only the roofline emitters (see `animateEntry`): nothing else is drawn for this agent. */
  private stepRoofEmitters(e: Entry, frame: FrameContext, prevClock: number, clock: number): void {
    const spec = ACTIVITY_SPECS[e.activity];
    const emitters = spec.emitters;
    if (!emitters || !this.textures || !e.sprite || !e.hasRoof) return;
    for (let i = 0; i < emitters.length; i++) {
      const em = emitters[i];
      if (em.at !== "roof" || (em.minDetail && detailLevel(frame.view.scale) < em.minDetail)) continue;
      let shots = shotsBetween(em.every ?? 1, em.offset ?? 0, prevClock, clock);
      if (shots === 0 || (em.window && !inWindow(em.window, clock))) continue;
      if (shots > MAX_SHOTS_PER_FRAME) shots = MAX_SHOTS_PER_FRAME;
      for (let k = 0; k < shots * (em.count ?? 1); k++) this.spawn(em, spec, e);
    }
  }

  private loopEmote(e: Entry, le: LoopEmote, from: number, to: number, sprite: AgentSprite): void {
    const off = le.offset ?? 0;
    if (shotsBetween(le.every, off, from, to) === 0) return;
    const names = le.names;
    let name = names[Math.abs(shotIndex(le.every, off, to)) % names.length];
    // Two people who are together pass a heart, not a sparkle.
    if (name === "sparkle" && e.romantic) name = "heart";
    this.pt.x = sprite.x;
    this.pt.y = sprite.y;
    this.services.bubbles.showEmote(e.id, name, this.pt);
  }

  /** The float rides on the water in front of the angler and is pulled under at a bite. */
  private stepBobber(e: Entry, spec: ActivitySpec, clock: number, sprite: AgentSprite): void {
    const b = spec.bobber!;
    const tex = this.textures;
    if (!tex) return;
    let s = e.bobber;
    if (!s || s.destroyed) {
      s = new PIXI.Sprite(tex[FX_CELLS.bobber.start]);
      s.anchor.set(0.5, 0.75);
      s.eventMode = "none";
      this.ground.layer.addChild(s);
      e.bobber = s;
    }
    const m = ((clock % b.cycle) + b.cycle) % b.cycle;
    const dipped = m >= b.dipFrom && m < b.dipTo;
    const cell = FX_CELLS.bobber.start + (dipped ? 1 : 0);
    if (s.texture !== tex[cell]) s.texture = tex[cell];
    s.position.set(sprite.x + sprite.facingDir * b.dx, sprite.y + b.dy + Math.sin(clock * 2.4) * 0.35);
    s.visible = true;
  }

  private dropBobber(e: Entry): void {
    if (e.bobber && !e.bobber.destroyed) e.bobber.destroy();
    e.bobber = null;
  }

  private spawn(em: EmitterSpec, spec: ActivitySpec, e: Entry): void {
    const sprite = e.sprite;
    if (!sprite) return;
    // A roofline emitter needs a roof; an agent outdoors has none.
    if (em.at === "roof" && !e.hasRoof) return;
    const pool = em.layer === "ground" ? this.ground : this.over;
    let p: Particle | null = null;
    for (let i = 0; i < pool.items.length; i++) {
      if (!pool.items[i].active) { p = pool.items[i]; break; }
    }
    if (!p) return;

    // The roof belongs to the building, not to the way the body faces.
    const f = em.at === "roof" ? 1 : sprite.facingDir;
    let x = (em.at === "roof" ? e.roofX : sprite.x) + f * em.x;
    let y = (em.at === "roof" ? e.roofY : sprite.y) + em.y;
    if (em.at === "hand") {
      // Follows the body's bob, lean and running lap.
      x += sprite.rig.x;
      y += sprite.rig.y;
    } else if (em.at === "bobber" && spec.bobber) {
      x += f * spec.bobber.dx;
      y += spec.bobber.dy;
    }
    x += rnd() * (em.spreadX ?? 0);
    y += rnd() * (em.spreadY ?? 0);

    p.spec = em;
    p.face = f;
    p.age = 0;
    p.life = em.life;
    p.x = x;
    p.y = y;
    p.vx = f * (em.vx ?? 0) + rnd() * (em.velSpreadX ?? 0);
    p.vy = (em.vy ?? 0) + rnd() * (em.velSpreadY ?? 0);
    p.cell = em.anim === "pick" ? FX_CELLS[em.sprite].start + Math.floor(Math.random() * FX_CELLS[em.sprite].count) : -1;
    p.shown = -1;
    p.active = true;
    const sc = em.scale ?? 1;
    p.sprite.scale.set(em.flip || em.tilt ? f * sc : sc, sc);
    p.sprite.rotation = 0;
    p.sprite.alpha = 1;
    p.sprite.position.set(x, y);
    p.sprite.visible = true;
  }

  private stepPool(pool: Pool, frame: FrameContext): void {
    const tex = this.textures!;
    const dt = frame.seconds;
    const items = pool.items;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      if (!p.active) continue;
      const em = p.spec!;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      p.vy += (em.gravity ?? 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const cell = p.cell >= 0
        ? p.cell
        : fxCellAt(em.sprite, p.age, p.life, em.anim === "loop" ? "loop" : "life", em.fps);
      if (cell !== p.shown) {
        p.shown = cell;
        p.sprite.texture = tex[cell];
      }
      if (em.tilt) p.sprite.rotation = Math.atan2(p.vy, Math.abs(p.vx) + 1) * p.face;
      const left = p.life - p.age;
      const span = p.life * FADE_FRACTION;
      p.sprite.alpha = left < span ? left / span : 1;
      p.sprite.position.set(p.x, p.y);
      p.sprite.visible = inView(frame.view, p.x, p.y, 16);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const e of this.list) this.dropBobber(e);
    for (const pool of [this.ground, this.over]) {
      for (const p of pool.items) {
        p.sprite.parent?.removeChild(p.sprite);
        p.sprite.destroy();
      }
      pool.items.length = 0;
    }
    this.entries.clear();
    this.list = [];
    this.textures = null;
  }
}

/** Uniform in [-1, 1]. */
function rnd(): number {
  return Math.random() * 2 - 1;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function dist(a: AgentData, b: AgentData): number {
  return Math.hypot((a.position?.x ?? 0) - (b.position?.x ?? 0), (a.position?.y ?? 0) - (b.position?.y ?? 0));
}

function isNear(a: AgentData, b: AgentData): boolean {
  return dist(a, b) < NEAR_PX;
}

function hasNeighbour(agent: AgentData, all: AgentData[]): boolean {
  for (const o of all) {
    if (o.id === agent.id) continue;
    if (actionTypeOf(o) === "sleeping") continue;
    if (isNear(agent, o)) return true;
  }
  return false;
}

export const createActivityFxSystem: SystemFactory = (layers, services) => new ActivityFxSystem(layers, services);
