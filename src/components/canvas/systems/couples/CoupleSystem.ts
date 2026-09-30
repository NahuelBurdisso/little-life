import * as PIXI from "pixi.js";
import type { AgentData } from "../../SpritePool";
import type { AgentSprite } from "../../AgentSprite";
import { detailLevel, inView } from "../view";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import {
  GLANCE_HOLD_MS, GLANCE_PX, armInArmNow, coupleKey, facingToward, glanceGapMs, heartDue, idleTogetherNow,
  isAdultAge, nextHeartAt, nudgeFor, openCouplePairs,
} from "./couplePairs";
import type { CouplePair } from "./couplePairs";

/** Seconds over which a walker's speed is smoothed (a sprite eases to a stop between server steps). */
const VELOCITY_TAU_S = 0.4;
/** The pull and the hand link fade in and out at this rate: 4/s = a quarter of a second. */
const BLEND_PER_S = 4;
/** Together this long (s) before the first heart, so a couple brushing past do not pulse. */
const HEART_AFTER_TOGETHER_S = 2;
/** The joined hands: slightly above the feet, inset from each body's middle. */
const HAND_Y = -9;
const HAND_INSET_PX = 3;
const LINK_WIDTH_PX = 2;
const LINK_COLOR = 0xe08a9c;
const LINK_ALPHA = 0.9;
/** Culling margin (px) around a member of a pair. */
const VIEW_MARGIN = 48;
/** The zone activities the sim uses for the private evening: the sprite stays hushed, no flourishes. */
const HUSHED_ZONES: ReadonlySet<string> = new Set(["tryst", "sneak_home"]);

/** What a member of a couple (or a crush) is doing, smoothed over frames. */
interface Track {
  id: string;
  numId: number;
  x: number;
  y: number;
  /** Smoothed velocity in px/s. */
  vx: number;
  vy: number;
  /** False until a position is remembered (first frame, or after being off screen). */
  seeded: boolean;
  /** The pull (px) currently applied to the container pivot. */
  shiftX: number;
  shiftY: number;
  applied: boolean;
  /** Accumulated each frame by the pairs the agent belongs to. */
  wantX: number;
  wantY: number;
  /** The server row says they are in the private evening (or sneaking home): keep it hushed. */
  hushed: boolean;
  /** The sprite the pull was applied to; a rebuilt sprite starts clean. */
  sprite: AgentSprite | null;
  seen: number;
}

interface PairState {
  ta: Track;
  tb: Track;
  arm: boolean;
  /** 0..1, eased: how much of the pull and the hand link is showing. */
  blend: number;
  togetherFor: number;
  /** -1 until first scheduled (in `update`, on the frame clock). */
  nextHeart: number;
  flip: boolean;
  link: PIXI.Sprite | null;
  seen: number;
}

interface Glancer {
  id: string;
  targetId: string;
  /** -1 until first scheduled (in `update`, on the frame clock). */
  nextAt: number;
  until: number;
  /** Facing to go back to when the glance ends. */
  restore: 1 | -1;
  holding: boolean;
  seen: number;
}

/**
 * Open couples (married / engaged / partners) and the smitten, made visible:
 *  - walking together they pull ~6 px closer and a thin line joins their hands (ground layer);
 *  - standing together they turn to face each other, and now and then a heart floats up
 *    (at most one per pair per 25 s);
 *  - an infatuated resident near their crush steals a glance every 4-6 s.
 *
 * Secret lovers get none of it: the client only knows the public tags, and hiding is the point.
 * Adults only, and a missing age counts as a minor. The pull is a cosmetic `pivot` shift on the
 * sprite's container -- its logical position (what movement, bubbles and this system's own
 * geometry read) is never touched, so nothing fights the walk. `update` reuses its objects.
 */
class CoupleSystem implements CanvasSystem {
  private readonly tracks = new Map<string, Track>();
  private trackList: Track[] = [];
  private readonly pairs = new Map<string, PairState>();
  private pairList: PairState[] = [];
  private readonly glancers = new Map<string, Glancer>();
  private glancerList: Glancer[] = [];
  private readonly linkPool: PIXI.Sprite[] = [];

  private readonly byId = new Map<number, AgentData>();
  private readonly scratch: CouplePair[] = [];
  private readonly pairKeys = new Set<string>();
  /** Reused for emote positions: `showEmote` reads it immediately. */
  private readonly pt = { x: 0, y: 0 };
  private generation = 0;

  constructor(private readonly layers: CanvasLayers, private readonly services: CanvasServices) {}

  // -- Once per poll ---------------------------------------------------------------------------

  onData(data: DataContext): void {
    this.generation++;
    const gen = this.generation;
    this.byId.clear();
    for (const a of data.agents) this.byId.set(a.id, a);

    openCouplePairs(data.relationships, id => isAdultAge(this.byId.get(id)?.age), this.scratch);
    this.pairKeys.clear();
    let listsChanged = false;
    for (const p of this.scratch) {
      this.pairKeys.add(p.key);
      if (this.track(p.a, gen)) listsChanged = true;
      if (this.track(p.b, gen)) listsChanged = true;
      const ta = this.tracks.get(String(p.a))!;
      const tb = this.tracks.get(String(p.b))!;
      let st = this.pairs.get(p.key);
      if (!st) {
        st = { ta, tb, arm: false, blend: 0, togetherFor: 0, nextHeart: -1, flip: false, link: null, seen: gen };
        this.pairs.set(p.key, st);
        listsChanged = true;
      }
      st.seen = gen;
      st.ta = ta;
      st.tb = tb;
    }

    // Crushes: an infatuated adult whose target is an adult (and not already their open partner).
    for (const agent of data.agents) {
      if (!isAdultAge(agent.age)) continue;
      const state = agent.activeStates?.find(s => s.type === "infatuated" && typeof s.target_agent_id === "number");
      const targetId = state?.target_agent_id;
      if (typeof targetId !== "number" || targetId === agent.id) continue;
      if (!isAdultAge(this.byId.get(targetId)?.age)) continue;
      if (this.pairKeys.has(coupleKey(agent.id, targetId))) continue;
      const id = String(agent.id);
      let g = this.glancers.get(id);
      if (!g) {
        g = { id, targetId: String(targetId), nextAt: -1, until: 0, restore: 1, holding: false, seen: gen };
        this.glancers.set(id, g);
        listsChanged = true;
      }
      g.seen = gen;
      g.targetId = String(targetId);
      if (this.track(agent.id, gen)) listsChanged = true;
      if (this.track(targetId, gen)) listsChanged = true;
    }

    for (const t of this.tracks.values()) {
      if (t.seen !== gen) continue;
      const raw = this.byId.get(t.numId)?.current_action;
      const zone = typeof raw === "object" && raw ? raw.zoneActivity : undefined;
      t.hushed = zone != null && HUSHED_ZONES.has(zone);
    }

    for (const [key, st] of this.pairs) {
      if (st.seen === gen) continue;
      this.releaseLink(st);
      this.pairs.delete(key);
      listsChanged = true;
    }
    for (const [id, g] of this.glancers) {
      if (g.seen === gen) continue;
      this.endGlance(g);
      this.glancers.delete(id);
      listsChanged = true;
    }
    for (const [id, t] of this.tracks) {
      if (t.seen === gen) continue;
      this.clearShift(t);
      this.tracks.delete(id);
      listsChanged = true;
    }
    if (listsChanged) {
      this.trackList = Array.from(this.tracks.values());
      this.pairList = Array.from(this.pairs.values());
      this.glancerList = Array.from(this.glancers.values());
    }
  }

  /**
   * Marks `numId`'s track as seen this poll, creating it when new. Returns whether it was created:
   * `trackList` (what every frame walks) is only rebuilt when a list changed, and a crush moving on
   * to somebody new creates a track without any pair or glancer being new, so the caller must count
   * it or the newcomer is never sampled.
   */
  private track(numId: number, gen: number): boolean {
    const id = String(numId);
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        id, numId, x: 0, y: 0, vx: 0, vy: 0, seeded: false, shiftX: 0, shiftY: 0, applied: false,
        wantX: 0, wantY: 0, hushed: false, sprite: null, seen: gen,
      };
      this.tracks.set(id, t);
      t.seen = gen;
      return true;
    }
    t.seen = gen;
    return false;
  }

  // -- Every frame -----------------------------------------------------------------------------

  update(frame: FrameContext): void {
    if (this.trackList.length === 0) return;
    const near = detailLevel(frame.view.scale) > 0;

    const tl = this.trackList;
    for (let i = 0; i < tl.length; i++) {
      const t = tl[i];
      t.wantX = 0;
      t.wantY = 0;
      try { this.sample(t, frame, near); } catch (err) { console.warn("[couples] sample failed:", err); }
    }
    const pl = this.pairList;
    for (let i = 0; i < pl.length; i++) {
      try { this.stepPair(pl[i], frame); } catch (err) { console.warn("[couples] pair failed:", err); }
    }
    const gl = this.glancerList;
    for (let i = 0; i < gl.length; i++) {
      try { this.stepGlance(gl[i], frame); } catch (err) { console.warn("[couples] glance failed:", err); }
    }
    for (let i = 0; i < tl.length; i++) this.applyShift(tl[i]);
  }

  /** Smooth this agent's velocity from where their (un-pulled) container moved. */
  private sample(t: Track, frame: FrameContext, near: boolean): void {
    const sprite = this.services.sprites.getSprite(t.id) ?? null;
    if (sprite !== t.sprite) {
      // A rebuilt sprite (world reset) has none of our pull on it.
      t.sprite = sprite;
      t.applied = false;
      t.shiftX = 0;
      t.shiftY = 0;
      t.seeded = false;
    }
    if (!sprite || sprite.container.destroyed || !near || !inView(frame.view, sprite.x, sprite.y, VIEW_MARGIN)) {
      t.seeded = false;
      t.vx = 0;
      t.vy = 0;
      return;
    }
    const x = sprite.x;
    const y = sprite.y;
    if (t.seeded && frame.seconds > 0) {
      const a = 1 - Math.exp(-frame.seconds / VELOCITY_TAU_S);
      t.vx += ((x - t.x) / frame.seconds - t.vx) * a;
      t.vy += ((y - t.y) / frame.seconds - t.vy) * a;
    } else {
      t.vx = 0;
      t.vy = 0;
    }
    t.x = x;
    t.y = y;
    t.seeded = true;
  }

  /** The sprite, if it is on screen and sampled this frame. */
  private live(t: Track): AgentSprite | null {
    const s = t.sprite;
    return s && t.seeded && !s.container.destroyed ? s : null;
  }

  private stepPair(p: PairState, frame: FrameContext): void {
    const sa = this.live(p.ta);
    const sb = this.live(p.tb);
    if (!sa || !sb) {
      p.arm = false;
      p.togetherFor = 0;
      this.settle(p, false, frame.seconds, 0, 0, 0);
      return;
    }
    const dx = sb.x - sa.x;
    const dy = sb.y - sa.y;
    const dist = Math.hypot(dx, dy);
    const lying = sa.lyingBlend > 0.3 || sb.lyingBlend > 0.3;
    const hushed = p.ta.hushed || p.tb.hushed;

    p.arm = !lying && !hushed && armInArmNow(p.arm, dist, p.ta.vx, p.ta.vy, p.tb.vx, p.tb.vy);
    const idle = !lying && !hushed && !p.arm && idleTogetherNow(dist, p.ta.vx, p.ta.vy, p.tb.vx, p.tb.vy);

    if (idle) {
      // Two people standing together look at each other, not off in different directions.
      const fa = facingToward(dx);
      const fb = facingToward(-dx);
      if (fa !== 0) sa.setFacing(fa);
      if (fb !== 0) sb.setFacing(fb);
    }
    this.settle(p, p.arm, frame.seconds, dx, dy, dist);
    this.maybeHeart(p, p.arm || idle, sa, sb, frame);
  }

  /** Ease the pull/link toward on or off, accumulate each member's pull, and place the link. */
  private settle(p: PairState, on: boolean, seconds: number, dx: number, dy: number, dist: number): void {
    const step = BLEND_PER_S * seconds;
    p.blend = on ? Math.min(1, p.blend + step) : Math.max(0, p.blend - step);
    if (p.blend <= 0) {
      this.releaseLink(p);
      return;
    }
    if (dist < 1e-3) {
      if (p.link) p.link.visible = false;
      return;
    }
    const ux = dx / dist;
    const uy = dy / dist;
    const pull = nudgeFor(dist) * p.blend;
    p.ta.wantX += ux * pull;
    p.ta.wantY += uy * pull;
    p.tb.wantX -= ux * pull;
    p.tb.wantY -= uy * pull;

    // The hand link joins the two rendered hand points (each body pulled toward the other).
    const gap = dist - 2 * pull - 2 * HAND_INSET_PX;
    if (gap < 2) {
      if (p.link) p.link.visible = false;
      return;
    }
    const link = p.link ?? this.acquireLink(p);
    link.position.set(p.ta.x + ux * (pull + HAND_INSET_PX), p.ta.y + uy * (pull + HAND_INSET_PX) + HAND_Y);
    link.rotation = Math.atan2(dy, dx);
    link.scale.set(gap / link.texture.width, LINK_WIDTH_PX / link.texture.height);
    link.alpha = LINK_ALPHA * p.blend;
    link.visible = true;
  }

  private maybeHeart(p: PairState, together: boolean, sa: AgentSprite, sb: AgentSprite, frame: FrameContext): void {
    if (!together) {
      p.togetherFor = 0;
      return;
    }
    p.togetherFor += frame.seconds;
    if (p.nextHeart < 0) p.nextHeart = frame.now + HEART_AFTER_TOGETHER_S * 1000 + Math.random() * 4000;
    if (p.togetherFor < HEART_AFTER_TOGETHER_S || !heartDue(frame.now, p.nextHeart)) return;
    p.nextHeart = nextHeartAt(frame.now, Math.random());
    p.flip = !p.flip;
    const who = p.flip ? p.ta : p.tb;
    const s = p.flip ? sa : sb;
    this.pt.x = s.x;
    this.pt.y = s.y;
    this.services.bubbles.showEmote(who.id, "heart", this.pt);
  }

  private stepGlance(g: Glancer, frame: FrameContext): void {
    const me = this.tracks.get(g.id);
    const other = this.tracks.get(g.targetId);
    const s = me ? this.live(me) : null;
    const o = other ? this.live(other) : null;
    if (!me || !other || !s || !o || me.hushed || other.hushed) {
      this.endGlance(g);
      return;
    }
    const idle = Math.hypot(me.vx, me.vy) < 2 && s.lyingBlend < 0.3;
    const near = Math.hypot(o.x - s.x, o.y - s.y) <= GLANCE_PX;
    if (g.holding) {
      // Walking off, or the crush moving away, cuts the glance short; otherwise it lasts a beat.
      if (!idle || !near || frame.now >= g.until) this.endGlance(g);
      return;
    }
    if (!idle || !near) return;
    if (g.nextAt < 0) g.nextAt = frame.now + glanceGapMs(Math.random());
    if (frame.now < g.nextAt) return;
    g.nextAt = frame.now + glanceGapMs(Math.random());
    const dir = facingToward(o.x - s.x);
    if (dir === 0) return;
    g.restore = s.facingDir;
    g.holding = true;
    g.until = frame.now + GLANCE_HOLD_MS;
    s.setFacing(dir);
  }

  private endGlance(g: Glancer): void {
    if (!g.holding) return;
    g.holding = false;
    const t = this.tracks.get(g.id);
    const s = t ? this.live(t) : null;
    if (s) s.setFacing(g.restore);
  }

  // -- The pull --------------------------------------------------------------------------------

  /** Put this frame's accumulated pull on the container pivot (pivot moves the drawing, not the position). */
  private applyShift(t: Track): void {
    const s = t.sprite;
    if (!s || s.container.destroyed) return;
    if (t.wantX === 0 && t.wantY === 0) {
      if (t.applied) this.clearShift(t);
      return;
    }
    t.shiftX = t.wantX;
    t.shiftY = t.wantY;
    s.container.pivot.set(-t.shiftX, -t.shiftY);
    t.applied = true;
  }

  private clearShift(t: Track): void {
    if (t.applied && t.sprite && !t.sprite.container.destroyed) t.sprite.container.pivot.set(0, 0);
    t.applied = false;
    t.shiftX = 0;
    t.shiftY = 0;
  }

  // -- Link pool -------------------------------------------------------------------------------

  private acquireLink(p: PairState): PIXI.Sprite {
    let s = this.linkPool.pop();
    if (!s) {
      s = new PIXI.Sprite(PIXI.Texture.WHITE);
      s.anchor.set(0, 0.5);
      s.tint = LINK_COLOR;
      s.eventMode = "none";
      this.layers.ground.addChild(s);
    }
    p.link = s;
    return s;
  }

  private releaseLink(p: PairState): void {
    if (!p.link) return;
    p.link.visible = false;
    this.linkPool.push(p.link);
    p.link = null;
  }

  destroy(): void {
    for (const t of this.tracks.values()) this.clearShift(t);
    for (const p of this.pairList) this.releaseLink(p);
    for (const s of this.linkPool) s.destroy();
    this.linkPool.length = 0;
    this.tracks.clear();
    this.pairs.clear();
    this.glancers.clear();
    this.trackList = [];
    this.pairList = [];
    this.glancerList = [];
  }
}

export const createCoupleSystem: SystemFactory = (layers, services) => new CoupleSystem(layers, services);
