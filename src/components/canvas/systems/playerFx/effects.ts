import * as PIXI from "pixi.js";
import type { AgentData, SpritePool } from "../../SpritePool";
import type { BubbleSystem } from "../../BubbleSystem";
import type { FrameContext } from "../types";
import { inView, type ViewRect } from "../view";
import { emitCanvasEvent } from "../../../../lib/canvasBus";
import { fxDuration, fxFrame } from "../beats/beatFrames";
import type { FxLayer, FxSpritePool } from "./fxPool";
import {
  DIGIT_ADVANCE, PFX_ANIMS, pfxDuration, pfxFrame, digitCells,
  type PfxName,
} from "./playerFxFrames";
import {
  arcBow, arcPoint, burstScale, coinCount, dotCount, dropBounce, easeIn, easeInOut, fadeOut,
  feelingSpiralPoint, feelingStyle, flashAlpha, hopHeight, isTalking, perimeterPoint, pinDone,
  pulse, rumorWispPoint, secretTravelSeconds, talkArcDone, thoughtFallPoint, type Point,
} from "./fxMath";

/**
 * The player-action effects. Each one owns the few pooled sprites it needs, moves them in
 * `update` (no allocation there: positions go through module scratch points) and gives them
 * back in `dispose`. They are created only when the player does something, so building an
 * object per effect is fine; what must not allocate is the frame path.
 */

export interface Env {
  pool: FxSpritePool;
  /** playerfx.png cells. */
  tex: PIXI.Texture[];
  /** playerfxdigits.png cells, or null while that strip loads / if it failed. */
  digits: PIXI.Texture[] | null;
  /** beats.png cells (the generic ping), or null. */
  beats: PIXI.Texture[] | null;
  sprites: SpritePool;
  bubbles: BubbleSystem;
}

export interface Fx {
  /** Only one effect per key lives at a time (a repeat replaces the old one); null = stackable. */
  readonly key: string | null;
  /** Advance by `f.seconds`; false once finished. */
  update(env: Env, f: FrameContext): boolean;
  dispose(env: Env): void;
}

/**
 * Dedupe keys, shared with the system: it disposes the old effect with a key *before* building
 * its replacement, so a repeat reuses the sprites just handed back instead of doubling them.
 */
export const fxKey = {
  talk: (a: number, b: number) => `talk:${Math.min(a, b)}:${Math.max(a, b)}`,
  pin: (agent: number) => `pin:${agent}`,
  secret: (a: number, b: number) => `secret:${a}:${b}`,
  confront: (a: number, b: number) => `confront:${Math.min(a, b)}:${Math.max(a, b)}`,
  intro: (agent: number) => `intro:${agent}`,
  farewell: (agent: number) => `farewell:${agent}`,
  event: (location: number) => `event:${location}`,
  thought: (agent: number) => `thought:${agent}`,
  letter: (agent: number) => `letter:${agent}`,
  rumor: (seeder: number) => `rumor:${seeder}`,
  feeling: (agent: number) => `feeling:${agent}`,
  flash: "flash",
} as const;

/** Feet-anchored agents are ~27px tall; effects that sit "at the head" use this lift. */
const HEAD = 28;

const pt: Point = { x: 0, y: 0 };
const pt2: Point = { x: 0, y: 0 };

function cellOf(name: PfxName): number { return PFX_ANIMS[name].start; }
const C_DOT_PINK = cellOf("dotPink"), C_DOT_PINK_BIG = cellOf("dotPinkBig"), C_HEART = cellOf("dotHeart");
const C_DOT_GOLD = cellOf("dotGold"), C_DOT_GOLD_BIG = cellOf("dotGoldBig");
const C_RING = cellOf("groundRing"), C_SUITCASE = cellOf("suitcase");

/** Acquire a hidden sprite; the effect shows it when it first places it. */
function grab(env: Env, tex: PIXI.Texture | undefined, layer: FxLayer = "over"): PIXI.Sprite | null {
  if (!tex) return null;
  const s = env.pool.acquire(tex, layer);
  if (s) s.visible = false;
  return s;
}
function setTex(s: PIXI.Sprite, tex: PIXI.Texture): void {
  if (s.texture !== tex) s.texture = tex;
}
/** Position + alpha + scale, snapped to whole pixels (nearest-scaled art shimmers otherwise). */
function place(s: PIXI.Sprite | null, view: ViewRect, x: number, y: number, alpha = 1, sx = 1, sy = sx, margin = 48): void {
  if (!s) return;
  s.position.set(Math.round(x), Math.round(y));
  s.alpha = alpha;
  s.scale.set(sx, sy);
  s.visible = alpha > 0.01 && inView(view, x, y, margin);
}
function hide(s: PIXI.Sprite | null): void { if (s) s.visible = false; }
function releaseAll(env: Env, list: Array<PIXI.Sprite | null>): void {
  for (let i = 0; i < list.length; i++) env.pool.release(list[i]);
  list.length = 0;
}
function findAgent(agents: ArrayLike<AgentData> | undefined, id: number): AgentData | null {
  if (!agents) return null;
  for (let i = 0; i < agents.length; i++) if (agents[i]?.id === id) return agents[i];
  return null;
}

// ── suggest_talk ─────────────────────────────────────────────────────────────────────────────

const TALK_DOTS = 18;
const SPEECH_S = 1.8;
/** Where on the agent the arc attaches: mid-body reads as "between them" without hiding heads. */
const ARC_LIFT = 20;

/**
 * The matchmaker: a speech bubble over both agents, then a pulsing dotted arc with a heart in
 * the middle that stays until they stand within ~2 tiles, are talking, or a minute has passed.
 */
export class TalkFx implements Fx {
  readonly key: string;
  private elapsed = 0;
  private endAt = -1;
  private readonly dots: Array<PIXI.Sprite | null> = [];
  private heart: PIXI.Sprite | null;
  private readonly bubbles: Array<PIXI.Sprite | null> = [];
  private readonly aStr: string;
  private readonly bStr: string;

  constructor(env: Env, private readonly a: number, private readonly b: number) {
    this.key = fxKey.talk(a, b);
    this.aStr = String(a);
    this.bStr = String(b);
    for (let i = 0; i < TALK_DOTS; i++) this.dots.push(grab(env, env.tex[C_DOT_PINK]));
    this.heart = grab(env, env.tex[C_HEART]);
    const sp = cellOf("speech");
    this.bubbles.push(grab(env, env.tex[sp]), grab(env, env.tex[sp]));
  }

  update(env: Env, f: FrameContext): boolean {
    this.elapsed += f.seconds;
    const t = this.elapsed;
    const sa = env.sprites.getSprite(this.aStr);
    const sb = env.sprites.getSprite(this.bStr);
    if (!sa || !sb) return false;

    const dist = Math.hypot(sa.x - sb.x, sa.y - sb.y);
    if (this.endAt < 0 && talkArcDone({ elapsed: t, dist, talking: isTalking(f.data.conversations, this.a, this.b) })) {
      this.endAt = t;
    }
    const life = this.endAt < 0 ? Math.min(1, t / 0.25) : 1 - (t - this.endAt) / 0.5;
    if (life <= 0) return false;

    const ax = sa.x, ay = sa.y - ARC_LIFT, bx = sb.x, by = sb.y - ARC_LIFT;
    const n = dotCount(dist, TALK_DOTS);
    const bow = arcBow(dist);
    const mid = n >> 1;
    for (let i = 0; i < this.dots.length; i++) {
      const s = this.dots[i];
      if (!s) continue;
      if (i >= n || i === mid) { s.visible = false; continue; }
      const fr = (i + 0.5) / n;
      arcPoint(ax, ay, bx, by, bow, fr, pt);
      const p = pulse(fr, t);
      setTex(s, env.tex[p > 0.85 ? C_DOT_PINK_BIG : C_DOT_PINK]);
      place(s, f.view, pt.x, pt.y, (0.4 + 0.6 * p) * life, 2);
    }
    if (this.heart) {
      arcPoint(ax, ay, bx, by, bow, (mid + 0.5) / n, pt);
      place(this.heart, f.view, pt.x, pt.y, life, 2 + 0.6 * (0.5 + 0.5 * Math.sin(t * 6)));
    }

    if (this.bubbles.length > 0) {
      if (t < SPEECH_S) {
        const pop = 0.6 + 0.4 * easeInOut(t / 0.25);
        const alpha = fadeOut(t, SPEECH_S, 0.3);
        const tex = env.tex[pfxFrame("speech", t, true)];
        for (let k = 0; k < 2; k++) {
          const s = this.bubbles[k];
          const who = k === 0 ? sa : sb;
          if (!s) continue;
          setTex(s, tex);
          // Beside the mood emote (which floats at dx -8), not on top of it.
          place(s, f.view, who.x + 20, who.y - 40 + Math.sin(t * 5) * 1.2, alpha, pop);
        }
      } else {
        releaseAll(env, this.bubbles);
      }
    }
    return true;
  }

  dispose(env: Env): void {
    releaseAll(env, this.dots);
    env.pool.release(this.heart);
    this.heart = null;
    releaseAll(env, this.bubbles);
  }
}

// ── suggest_go_to ────────────────────────────────────────────────────────────────────────────

const PIN_DOTS = 20;
const ARRIVE_S = 0.7;
const RING_SCALE = 1.25;

/**
 * A bobbing pin and a turning ground ring at the destination's door, with a faint dotted
 * trail from the agent. It stays until the agent arrives (inside the location, or next to the
 * pin), then pops with a glint; 90 s at most.
 */
export class PinFx implements Fx {
  readonly key: string;
  private elapsed = 0;
  private arrivedAt = -1;
  private readonly idStr: string;
  private readonly pin: PIXI.Sprite | null;
  private readonly ring: PIXI.Sprite | null;
  private readonly spark: PIXI.Sprite | null;
  private readonly dots: Array<PIXI.Sprite | null> = [];

  constructor(env: Env, private readonly agentId: number, private readonly locId: number, private readonly destX: number, private readonly destY: number) {
    this.key = fxKey.pin(agentId);
    this.idStr = String(agentId);
    this.ring = grab(env, env.tex[C_RING], "ground");
    this.pin = grab(env, env.tex[cellOf("pin")]);
    // Tip of the pin (row 28 of 32, plus its outline) sits on the anchor point.
    this.pin?.anchor.set(0.5, 29.5 / 32);
    this.spark = grab(env, env.tex[cellOf("coinSparkle")]);
    for (let i = 0; i < PIN_DOTS; i++) this.dots.push(grab(env, env.tex[C_DOT_GOLD], "ground"));
  }

  update(env: Env, f: FrameContext): boolean {
    this.elapsed += f.seconds;
    const t = this.elapsed;
    const sp = env.sprites.getSprite(this.idStr);
    const agent = findAgent(f.data.agents, this.agentId);
    if (!sp && !agent) return false;

    const dx = this.destX, dy = this.destY;
    const dist = sp ? Math.hypot(sp.x - dx, sp.y - dy) : Infinity;
    if (this.arrivedAt < 0 && pinDone({ elapsed: t, atLocation: agent?.current_location === this.locId, dist })) {
      this.arrivedAt = t;
    }

    if (this.arrivedAt >= 0) {
      const at = t - this.arrivedAt;
      if (at >= ARRIVE_S) return false;
      const k = at / ARRIVE_S;
      place(this.pin, f.view, dx, dy - easeInOut(k) * 14, 1 - k);
      place(this.ring, f.view, dx, dy, 0.9 * (1 - k), RING_SCALE * (1 + k * 0.5), RING_SCALE * 0.5 * (1 + k * 0.5));
      if (this.spark) {
        setTex(this.spark, env.tex[pfxFrame("coinSparkle", at)]);
        place(this.spark, f.view, dx, dy - 18, 1, 1.6);
      }
      for (let i = 0; i < this.dots.length; i++) hide(this.dots[i]);
      return true;
    }

    const intro = Math.min(1, t / 0.3);
    if (this.pin) {
      setTex(this.pin, env.tex[pfxFrame("pin", t, true)]);
      place(this.pin, f.view, dx, dy - Math.abs(Math.sin(t * 4)) * 4, intro);
    }
    if (this.ring) {
      setTex(this.ring, env.tex[pfxFrame("groundRing", t, true)]);
      place(this.ring, f.view, dx, dy, 0.9 * intro, RING_SCALE, RING_SCALE * 0.5);
    }
    hide(this.spark);

    const showTrail = sp && dist > 48;
    const n = showTrail ? dotCount(dist, PIN_DOTS) : 0;
    for (let i = 0; i < this.dots.length; i++) {
      const s = this.dots[i];
      if (!s) continue;
      if (!showTrail || i >= n) { s.visible = false; continue; }
      const fr = (i + 0.5) / n;
      const p = pulse(fr, t);
      setTex(s, env.tex[p > 0.85 ? C_DOT_GOLD_BIG : C_DOT_GOLD]);
      place(s, f.view, sp!.x + (dx - sp!.x) * fr, sp!.y - 4 + (dy - 2 - (sp!.y - 4)) * fr, (0.35 + 0.5 * p) * intro, 1.6);
    }
    return true;
  }

  dispose(env: Env): void {
    env.pool.release(this.pin);
    env.pool.release(this.ring);
    env.pool.release(this.spark);
    releaseAll(env, this.dots);
  }
}

// ── give_money ───────────────────────────────────────────────────────────────────────────────

const COIN_FLIGHT = 0.55;
const COIN_STAGGER = 0.09;
const COIN_LAND_LIFT = 14;
const LABEL_DELAY = 0.45;
const LABEL_S = 1.6;
const DIGIT_SCALE = 2;
const MAX_LABEL_GLYPHS = 9;

interface Coin { s: PIXI.Sprite | null; ox: number; startH: number; delay: number }

/**
 * Coins rain onto the agent, each ending in a glint, and a gold "+N" floats up from their head.
 * The number is pixel digits from the atlas rather than a PIXI.Text: crisp at any zoom and
 * pooled like everything else.
 */
export class CoinFx implements Fx {
  readonly key = null;
  private elapsed = 0;
  private readonly idStr: string;
  private readonly coins: Coin[] = [];
  private readonly glyphs: Array<PIXI.Sprite | null> = [];
  private readonly cells: number[];
  private readonly life: number;

  constructor(env: Env, agentId: number, amount: number) {
    this.idStr = String(agentId);
    const n = coinCount(amount);
    for (let i = 0; i < n; i++) {
      this.coins.push({
        s: grab(env, env.tex[cellOf("coin")]),
        // Deterministic scatter: same amount, same shower.
        ox: ((i * 37) % 11) - 5,
        startH: 46 + (i % 3) * 6,
        delay: i * COIN_STAGGER,
      });
    }
    this.cells = env.digits ? digitCells(amount).slice(0, MAX_LABEL_GLYPHS) : [];
    for (const c of this.cells) this.glyphs.push(grab(env, env.digits?.[c]));
    this.life = Math.max((n - 1) * COIN_STAGGER + COIN_FLIGHT + pfxDuration("coinSparkle"), LABEL_DELAY + LABEL_S);
  }

  update(env: Env, f: FrameContext): boolean {
    this.elapsed += f.seconds;
    const t = this.elapsed;
    if (t >= this.life) return false;
    const sp = env.sprites.getSprite(this.idStr);
    if (!sp) return false;

    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      if (!c.s) continue;
      const ct = t - c.delay;
      if (ct < 0) { c.s.visible = false; continue; }
      if (ct < COIN_FLIGHT) {
        const k = ct / COIN_FLIGHT;
        setTex(c.s, env.tex[pfxFrame("coin", ct, true)]);
        const lift = c.startH + (COIN_LAND_LIFT - c.startH) * easeIn(k);
        place(c.s, f.view, sp.x + c.ox * (1 - k * 0.6), sp.y - lift, 1, 1.2);
      } else if (ct < COIN_FLIGHT + pfxDuration("coinSparkle")) {
        setTex(c.s, env.tex[pfxFrame("coinSparkle", ct - COIN_FLIGHT)]);
        place(c.s, f.view, sp.x + c.ox * 0.4, sp.y - COIN_LAND_LIFT, 1, 1.2);
      } else {
        c.s.visible = false;
      }
    }

    const lt = t - LABEL_DELAY;
    const n = this.glyphs.length;
    if (lt >= 0 && lt < LABEL_S && n > 0) {
      const k = lt / LABEL_S;
      const rise = 18 * (1 - (1 - k) * (1 - k));
      const scale = DIGIT_SCALE * (lt < 0.15 ? 1.3 - 0.3 * (lt / 0.15) : 1);
      const alpha = fadeOut(lt, LABEL_S, 0.4);
      const step = DIGIT_ADVANCE * scale;
      for (let i = 0; i < n; i++) {
        place(this.glyphs[i], f.view, sp.x + (i - (n - 1) / 2) * step, sp.y - HEAD - 12 - rise, alpha, scale);
      }
    } else {
      for (let i = 0; i < n; i++) hide(this.glyphs[i]);
    }
    return true;
  }

  dispose(env: Env): void {
    for (const c of this.coins) env.pool.release(c.s);
    this.coins.length = 0;
    releaseAll(env, this.glyphs);
  }
}

// ── tell_secret ──────────────────────────────────────────────────────────────────────────────

const TRAIL = 4;
const ABSORB_S = 0.35;
const SWIRL_LIFT = 22;

/**
 * A lavender whisper leaves the teller's head, trailing curls behind it, and lands on the
 * listener. "shh" (the whisper emote) on the teller as it leaves, "!" on the listener as it lands.
 */
export class SecretFx implements Fx {
  readonly key: string;
  private elapsed = 0;
  private landed = false;
  private readonly aStr: string;
  private readonly bStr: string;
  private readonly head: PIXI.Sprite | null;
  private readonly trail: Array<PIXI.Sprite | null> = [];
  private readonly travel: number;

  constructor(env: Env, a: number, b: number) {
    this.key = fxKey.secret(a, b);
    this.aStr = String(a);
    this.bStr = String(b);
    const sa = env.sprites.getSprite(this.aStr);
    const sb = env.sprites.getSprite(this.bStr);
    this.travel = sa && sb ? secretTravelSeconds(Math.hypot(sa.x - sb.x, sa.y - sb.y)) : 1.2;
    if (sa) env.bubbles.showEmote(this.aStr, "whisper", { x: sa.x, y: sa.y });
    const cell = cellOf("swirl");
    this.head = grab(env, env.tex[cell]);
    for (let i = 0; i < TRAIL; i++) this.trail.push(grab(env, env.tex[cell]));
  }

  update(env: Env, f: FrameContext): boolean {
    this.elapsed += f.seconds;
    const t = this.elapsed;
    const sa = env.sprites.getSprite(this.aStr);
    const sb = env.sprites.getSprite(this.bStr);
    if (!sa || !sb) return false;
    const ax = sa.x, ay = sa.y - SWIRL_LIFT, bx = sb.x, by = sb.y - SWIRL_LIFT;
    const bow = arcBow(Math.hypot(ax - bx, ay - by)) * 0.8;

    if (t < this.travel) {
      const fr = easeInOut(t / this.travel);
      arcPoint(ax, ay, bx, by, bow, fr, pt);
      if (this.head) {
        setTex(this.head, env.tex[pfxFrame("swirl", t, true)]);
        place(this.head, f.view, pt.x, pt.y, 1, 0.85);
      }
      for (let k = 0; k < this.trail.length; k++) {
        const s = this.trail[k];
        if (!s) continue;
        const fk = fr - 0.07 * (k + 1);
        if (fk <= 0) { s.visible = false; continue; }
        arcPoint(ax, ay, bx, by, bow, fk, pt2);
        setTex(s, env.tex[pfxFrame("swirl", t + 0.05 * (k + 1), true)]);
        place(s, f.view, pt2.x, pt2.y, 0.6 - 0.13 * k, 0.75 - 0.13 * k);
      }
      return true;
    }

    if (!this.landed) {
      this.landed = true;
      env.bubbles.showEmote(this.bStr, "exclaim", { x: sb.x, y: sb.y });
      for (let k = 0; k < this.trail.length; k++) hide(this.trail[k]);
    }
    const at = t - this.travel;
    if (at >= ABSORB_S) return false;
    const k = at / ABSORB_S;
    if (this.head) {
      setTex(this.head, env.tex[pfxFrame("swirl", t, true)]);
      place(this.head, f.view, bx, by, 1 - k, 0.85 + 0.8 * k);
    }
    return true;
  }

  dispose(env: Env): void {
    env.pool.release(this.head);
    releaseAll(env, this.trail);
  }
}

// ── force_confront ───────────────────────────────────────────────────────────────────────────

const CLASH_S = 1.7;

/** Crossed swords flash over both agents' heads, next to the angry emote each gets. */
export class ConfrontFx implements Fx {
  readonly key: string;
  private elapsed = 0;
  private readonly ids: string[];
  private readonly swords: Array<PIXI.Sprite | null> = [];

  constructor(env: Env, a: number, b: number) {
    this.key = fxKey.confront(a, b);
    this.ids = [String(a), String(b)];
    for (const id of this.ids) {
      const sp = env.sprites.getSprite(id);
      if (sp) env.bubbles.showEmote(id, "anger", { x: sp.x, y: sp.y });
      this.swords.push(grab(env, env.tex[cellOf("clash")]));
    }
  }

  update(env: Env, f: FrameContext): boolean {
    this.elapsed += f.seconds;
    const t = this.elapsed;
    if (t >= CLASH_S) return false;
    const tex = env.tex[pfxFrame("clash", t, true)];
    const alpha = fadeOut(t, CLASH_S, 0.35);
    for (let i = 0; i < this.swords.length; i++) {
      const s = this.swords[i];
      const sp = env.sprites.getSprite(this.ids[i]);
      if (!s) continue;
      if (!sp) { s.visible = false; continue; }
      setTex(s, tex);
      place(s, f.view, sp.x + 20, sp.y - 42, alpha, 1.5);
    }
    return true;
  }

  dispose(env: Env): void { releaseAll(env, this.swords); }
}

// ── introduce_agent ──────────────────────────────────────────────────────────────────────────

const INTRO_WAIT_S = 30;
const INTRO_LIFE_S = 3.4;

/**
 * Waits for the newcomer's sprite (it only exists after the next agents poll), then plays a
 * pillar of light, confetti and a suitcase dropped beside them — and pans the camera there.
 */
export class IntroFx implements Fx {
  readonly key: string;
  private elapsed = 0;
  private playing = false;
  private t = 0;
  private x = 0;
  private y = 0;
  private column: PIXI.Sprite | null = null;
  private confetti: PIXI.Sprite | null = null;
  private suitcase: PIXI.Sprite | null = null;
  private readonly idStr: string;

  constructor(agentId: number) {
    this.key = fxKey.intro(agentId);
    this.idStr = String(agentId);
  }

  update(env: Env, f: FrameContext): boolean {
    if (!this.playing) {
      this.elapsed += f.seconds;
      const sp = env.sprites.getSprite(this.idStr);
      if (!sp) return this.elapsed < INTRO_WAIT_S;
      this.playing = true;
      this.x = sp.x;
      this.y = sp.y;
      this.column = grab(env, env.tex[cellOf("column")]);
      this.column?.anchor.set(0.5, 0.92);
      this.confetti = grab(env, env.tex[cellOf("confetti")]);
      this.suitcase = grab(env, env.tex[C_SUITCASE]);
      this.suitcase?.anchor.set(0.5, 24.5 / 32);
      env.bubbles.showEmote(this.idStr, "wave", { x: sp.x, y: sp.y });
      // The camera goes to them: the player just made someone, so show who and where.
      emitCanvasEvent({ type: "focus", x: sp.x, y: sp.y });
    }

    this.t += f.seconds;
    const t = this.t;
    if (t >= INTRO_LIFE_S) return false;
    const v = f.view;
    if (this.column) {
      setTex(this.column, env.tex[pfxFrame("column", t)]);
      place(this.column, v, this.x, this.y + 2, fadeOut(t, 1.3, 0.55), 1.8);
    }
    if (this.confetti) {
      const active = t < pfxDuration("confetti") + 0.1;
      setTex(this.confetti, env.tex[pfxFrame("confetti", t)]);
      if (active) place(this.confetti, v, this.x, this.y - 14, 1, 1.6);
      else this.confetti.visible = false;
    }
    if (this.suitcase) {
      // Lands beside them a beat after the light starts, bounces twice, waits, fades.
      const st = t - 0.25;
      if (st < 0) this.suitcase.visible = false;
      else place(this.suitcase, v, this.x + 16, this.y - dropBounce(st, 46), fadeOut(t, INTRO_LIFE_S, 0.8));
    }
    return true;
  }

  dispose(env: Env): void {
    env.pool.release(this.column);
    env.pool.release(this.confetti);
    env.pool.release(this.suitcase);
  }
}

// ── remove_agent ─────────────────────────────────────────────────────────────────────────────

const FAREWELL_LIFE_S = 3.4;
/** If the sprite has not vanished by now (slow poll), poof anyway. */
const POOF_LATEST_S = 1.6;
const HOP_S = 0.36;

/**
 * A wave, then a puff of dust where the agent stood, and their little suitcase hops away and
 * fades. The sprite disappears on the next poll, so the position is captured at the start.
 */
export class FarewellFx implements Fx {
  readonly key: string;
  private t = 0;
  private poofAt = -1;
  private readonly idStr: string;
  private readonly poof: PIXI.Sprite | null;
  private readonly suitcase: PIXI.Sprite | null;

  constructor(env: Env, agentId: number, private readonly x: number, private readonly y: number, private readonly dir: 1 | -1) {
    this.key = fxKey.farewell(agentId);
    this.idStr = String(agentId);
    if (env.sprites.getSprite(this.idStr)) env.bubbles.showEmote(this.idStr, "wave", { x, y });
    this.poof = grab(env, env.tex[cellOf("poof")]);
    this.suitcase = grab(env, env.tex[C_SUITCASE]);
    this.suitcase?.anchor.set(0.5, 24.5 / 32);
  }

  update(env: Env, f: FrameContext): boolean {
    this.t += f.seconds;
    const t = this.t;
    if (t >= FAREWELL_LIFE_S) return false;
    if (this.poofAt < 0 && (t >= POOF_LATEST_S || !env.sprites.getSprite(this.idStr))) this.poofAt = t;
    if (this.poofAt < 0) return true;

    const pt0 = t - this.poofAt;
    if (this.poof) {
      if (pt0 < pfxDuration("poof")) {
        setTex(this.poof, env.tex[pfxFrame("poof", pt0)]);
        place(this.poof, f.view, this.x, this.y - 8, 1, 1.4);
      } else {
        this.poof.visible = false;
      }
    }
    if (this.suitcase) {
      // Waits a beat in the dust, then hops off in the direction the agent was facing.
      const st = pt0 - 0.35;
      const walk = Math.max(0, st) * 26 * this.dir;
      const life = FAREWELL_LIFE_S - this.poofAt;
      place(this.suitcase, f.view, this.x + this.dir * 10 + walk, this.y - hopHeight(st, HOP_S, 8, 6), fadeOut(pt0, life, 0.9));
    }
    return true;
  }

  dispose(env: Env): void {
    env.pool.release(this.poof);
    env.pool.release(this.suitcase);
  }
}

// ── event ────────────────────────────────────────────────────────────────────────────────────

const EVENT_SPARKS = 10;
const EVENT_LIFE_S = 1.5;

/** A golden shock ring over the event's building, with sparkles popping around its walls. */
export class EventBurstFx implements Fx {
  readonly key: string;
  private t = 0;
  private readonly cx: number;
  private readonly cy: number;
  private readonly scale: number;
  private readonly burst: PIXI.Sprite | null;
  private readonly echo: PIXI.Sprite | null;
  private readonly sparks: Array<PIXI.Sprite | null> = [];

  constructor(env: Env, locationId: number, private readonly rx: number, private readonly ry: number, private readonly rw: number, private readonly rh: number) {
    this.key = fxKey.event(locationId);
    this.cx = rx + rw / 2;
    this.cy = ry + rh / 2;
    this.scale = burstScale(rw, rh);
    const c = cellOf("burst");
    this.burst = grab(env, env.tex[c]);
    this.echo = grab(env, env.tex[c]);
    for (let i = 0; i < EVENT_SPARKS; i++) this.sparks.push(grab(env, env.tex[cellOf("coinSparkle")]));
  }

  update(env: Env, f: FrameContext): boolean {
    this.t += f.seconds;
    const t = this.t;
    if (t >= EVENT_LIFE_S) return false;
    const margin = Math.max(this.rw, this.rh) + 32;
    if (this.burst) {
      setTex(this.burst, env.tex[pfxFrame("burst", t)]);
      place(this.burst, f.view, this.cx, this.cy, 1, this.scale, this.scale, margin);
    }
    if (this.echo) {
      const et = t - 0.22;
      if (et < 0 || et >= pfxDuration("burst")) this.echo.visible = false;
      else {
        setTex(this.echo, env.tex[pfxFrame("burst", et)]);
        place(this.echo, f.view, this.cx, this.cy, 0.7, this.scale * 0.7, this.scale * 0.7, margin);
      }
    }
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i];
      if (!s) continue;
      const st = t - (0.1 + i * 0.07);
      if (st < 0 || st >= pfxDuration("coinSparkle")) { s.visible = false; continue; }
      perimeterPoint(this.rx, this.ry, this.rw, this.rh, i / EVENT_SPARKS + 0.03, pt);
      setTex(s, env.tex[pfxFrame("coinSparkle", st)]);
      place(s, f.view, pt.x, pt.y, 1, 1.6);
    }
    return true;
  }

  dispose(env: Env): void {
    env.pool.release(this.burst);
    env.pool.release(this.echo);
    releaseAll(env, this.sparks);
  }
}

// ── weather ──────────────────────────────────────────────────────────────────────────────────

const FLASH_S = 0.55;
const FLASH_PEAK = 0.16;

/**
 * The weather shows itself, so the answer to changing it is only a soft flash of light across
 * the screen — the "click" of the switch. One full-view sprite, resized to the view each frame.
 */
export class FlashFx implements Fx {
  readonly key = fxKey.flash;
  private t = 0;
  private readonly s: PIXI.Sprite | null;

  constructor(env: Env) {
    this.s = env.pool.acquire(PIXI.Texture.WHITE);
    if (this.s) {
      this.s.anchor.set(0);
      this.s.tint = 0xfff4d6;
      this.s.visible = false;
    }
  }

  update(_env: Env, f: FrameContext): boolean {
    this.t += f.seconds;
    if (this.t >= FLASH_S) return false;
    const s = this.s;
    if (s) {
      s.position.set(f.view.x, f.view.y);
      s.width = f.view.w;
      s.height = f.view.h;
      s.alpha = flashAlpha(this.t, FLASH_PEAK, FLASH_S);
      s.visible = s.alpha > 0.005;
    }
    return true;
  }

  dispose(env: Env): void {
    // The pool resets anchor and tint on the next acquire.
    env.pool.release(this.s);
  }
}

// ── whisper_thought ──────────────────────────────────────────────────────────────────────────

const THOUGHT_FALL_S = 1.1;
const THOUGHT_HEIGHT = 90;
const THOUGHT_TRAIL = 4;

/** What sets a falling wisp apart: its dedupe key, tint and the bubble it lands in. */
interface ThoughtStyle {
  key: string;
  /** Tint of the head and trail (the pool resets it to white on the next acquire). */
  tint?: number;
  emote: string;
}

/**
 * A lavender wisp drops out of the sky and curls down into the agent's head, then a "think"
 * bubble: the idea arrived from nowhere. Same swirl cell as the secret, since both are words
 * nobody said out loud. LetterFx reuses the fall with its own look.
 */
export class ThoughtFx implements Fx {
  readonly key: string;
  private t = 0;
  private landed = false;
  private readonly idStr: string;
  private readonly emote: string;
  private readonly head: PIXI.Sprite | null;
  private readonly trail: Array<PIXI.Sprite | null> = [];

  constructor(env: Env, agentId: number, style?: ThoughtStyle) {
    this.key = style?.key ?? fxKey.thought(agentId);
    this.emote = style?.emote ?? "think";
    this.idStr = String(agentId);
    const cell = cellOf("swirl");
    this.head = grab(env, env.tex[cell]);
    for (let i = 0; i < THOUGHT_TRAIL; i++) this.trail.push(grab(env, env.tex[cell]));
    if (style?.tint != null) {
      if (this.head) this.head.tint = style.tint;
      for (const s of this.trail) if (s) s.tint = style.tint;
    }
  }

  update(env: Env, f: FrameContext): boolean {
    this.t += f.seconds;
    const t = this.t;
    const sp = env.sprites.getSprite(this.idStr);
    if (!sp) return false;
    const hx = sp.x, hy = sp.y - SWIRL_LIFT;

    if (t < THOUGHT_FALL_S) {
      const k = t / THOUGHT_FALL_S;
      thoughtFallPoint(easeIn(k), THOUGHT_HEIGHT, pt);
      if (this.head) {
        setTex(this.head, env.tex[pfxFrame("swirl", t, true)]);
        place(this.head, f.view, hx + pt.x, hy + pt.y, Math.min(1, t / 0.2), 0.9);
      }
      for (let i = 0; i < this.trail.length; i++) {
        const s = this.trail[i];
        if (!s) continue;
        const ki = k - 0.06 * (i + 1);
        if (ki <= 0) { s.visible = false; continue; }
        thoughtFallPoint(easeIn(ki), THOUGHT_HEIGHT, pt2);
        setTex(s, env.tex[pfxFrame("swirl", t + 0.05 * (i + 1), true)]);
        place(s, f.view, hx + pt2.x, hy + pt2.y, 0.55 - 0.12 * i, 0.75 - 0.12 * i);
      }
      return true;
    }

    if (!this.landed) {
      this.landed = true;
      env.bubbles.showEmote(this.idStr, this.emote, { x: sp.x, y: sp.y });
      for (let i = 0; i < this.trail.length; i++) hide(this.trail[i]);
    }
    const at = t - THOUGHT_FALL_S;
    if (at >= ABSORB_S) return false;
    const k = at / ABSORB_S;
    if (this.head) place(this.head, f.view, hx, hy, 1 - k, 0.9 + 0.9 * k);
    return true;
  }

  dispose(env: Env): void {
    env.pool.release(this.head);
    releaseAll(env, this.trail);
  }
}

// ── send_letter ──────────────────────────────────────────────────────────────────────────────

/**
 * The anonymous letter: the thought's fall in parchment gold, landing as a "question" bubble
 * (who sent this?) instead of a "think" one. Cheap on purpose: the recipient is the only one
 * who shows anything, since there is no sender to picture.
 */
export class LetterFx extends ThoughtFx {
  constructor(env: Env, recipientId: number) {
    super(env, recipientId, { key: fxKey.letter(recipientId), tint: 0xf2d98a, emote: "question" });
  }
}

// ── start_rumor ──────────────────────────────────────────────────────────────────────────────

const RUMOR_WISPS = 5;
const RUMOR_STAGGER = 0.12;
const RUMOR_DRIFT_S = 1.3;
const RUMOR_DIST = 56;

/**
 * The seeder gets the "shh" emote and a fan of pink wisps leaves their head, drifting off in
 * every direction and fading: the story is out, and nobody can say where it will land. The
 * subject gets nothing — they don't know yet, and neither should the picture.
 */
export class RumorFx implements Fx {
  readonly key: string;
  private t = 0;
  private readonly idStr: string;
  private readonly wisps: Array<PIXI.Sprite | null> = [];
  private readonly life = (RUMOR_WISPS - 1) * RUMOR_STAGGER + RUMOR_DRIFT_S;

  constructor(env: Env, seederId: number) {
    this.key = fxKey.rumor(seederId);
    this.idStr = String(seederId);
    const sp = env.sprites.getSprite(this.idStr);
    if (sp) env.bubbles.showEmote(this.idStr, "whisper", { x: sp.x, y: sp.y });
    for (let i = 0; i < RUMOR_WISPS; i++) {
      const s = grab(env, env.tex[cellOf("swirl")]);
      // Rosier than the secret's lavender: this one is meant to travel.
      if (s) s.tint = 0xffb3c8;
      this.wisps.push(s);
    }
  }

  update(env: Env, f: FrameContext): boolean {
    this.t += f.seconds;
    const t = this.t;
    if (t >= this.life) return false;
    const sp = env.sprites.getSprite(this.idStr);
    if (!sp) return false;
    const hx = sp.x, hy = sp.y - SWIRL_LIFT - 4;
    for (let i = 0; i < this.wisps.length; i++) {
      const s = this.wisps[i];
      if (!s) continue;
      const wt = t - i * RUMOR_STAGGER;
      if (wt < 0 || wt >= RUMOR_DRIFT_S) { s.visible = false; continue; }
      const k = wt / RUMOR_DRIFT_S;
      rumorWispPoint(i, RUMOR_WISPS, k, RUMOR_DIST, pt);
      setTex(s, env.tex[pfxFrame("swirl", wt, true)]);
      place(s, f.view, hx + pt.x, hy + pt.y, fadeOut(wt, RUMOR_DRIFT_S, 0.5), 0.6 + 0.3 * k);
    }
    return true;
  }

  dispose(env: Env): void { releaseAll(env, this.wisps); }
}

// ── stir_feeling ─────────────────────────────────────────────────────────────────────────────

const FEELING_PARTICLES = 8;
const FEELING_CLIMB_S = 1.2;
const FEELING_STAGGER = 0.14;
const FEELING_RISE = 34;

/**
 * The feeling wells up: particles in its colour (hearts for a crush, sour green for jealousy,
 * gold for confidence, grey-blue wisps for stress) spiral up around the agent, and the emote
 * the canvas uses for that state pops over their head.
 */
export class FeelingFx implements Fx {
  readonly key: string;
  private t = 0;
  private readonly idStr: string;
  private readonly animated: boolean;
  private readonly parts: Array<PIXI.Sprite | null> = [];
  private readonly life = (FEELING_PARTICLES - 1) * FEELING_STAGGER + FEELING_CLIMB_S;

  constructor(env: Env, agentId: number, feeling: string | undefined) {
    this.key = fxKey.feeling(agentId);
    this.idStr = String(agentId);
    const style = feelingStyle(feeling);
    this.animated = style.cell === "swirl";
    const sp = env.sprites.getSprite(this.idStr);
    if (sp) env.bubbles.showEmote(this.idStr, style.emote, { x: sp.x, y: sp.y });
    for (let i = 0; i < FEELING_PARTICLES; i++) {
      const s = grab(env, env.tex[cellOf(style.cell)]);
      if (s) s.tint = style.tint;
      this.parts.push(s);
    }
  }

  update(env: Env, f: FrameContext): boolean {
    this.t += f.seconds;
    const t = this.t;
    if (t >= this.life) return false;
    const sp = env.sprites.getSprite(this.idStr);
    if (!sp) return false;
    for (let i = 0; i < this.parts.length; i++) {
      const s = this.parts[i];
      if (!s) continue;
      const pt0 = t - i * FEELING_STAGGER;
      if (pt0 < 0 || pt0 >= FEELING_CLIMB_S) { s.visible = false; continue; }
      const k = pt0 / FEELING_CLIMB_S;
      feelingSpiralPoint(i, FEELING_PARTICLES, k, t, FEELING_RISE, pt);
      if (this.animated) setTex(s, env.tex[pfxFrame("swirl", pt0, true)]);
      const alpha = Math.min(1, pt0 / 0.15) * fadeOut(pt0, FEELING_CLIMB_S, 0.4);
      place(s, f.view, sp.x + pt.x, sp.y + pt.y, alpha, this.animated ? 0.6 : 1.6);
    }
    return true;
  }

  dispose(env: Env): void { releaseAll(env, this.parts); }
}

// ── fallback ─────────────────────────────────────────────────────────────────────────────────

/** The old generic answer for an intervention we have no picture for: a gold ring and a "!". */
export class PingFx implements Fx {
  readonly key = null;
  private t = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly idStr: string;
  private readonly s: PIXI.Sprite | null;
  private readonly dur = fxDuration("ping");

  constructor(env: Env, agentId: number) {
    this.idStr = String(agentId);
    const sp = env.sprites.getSprite(this.idStr);
    if (sp) {
      this.lastX = sp.x;
      this.lastY = sp.y;
      env.bubbles.showEmote(this.idStr, "exclaim", { x: sp.x, y: sp.y });
    }
    this.s = sp ? grab(env, env.beats?.[fxFrame("ping", 0)]) : null;
  }

  update(env: Env, f: FrameContext): boolean {
    this.t += f.seconds;
    if (this.t >= this.dur) return false;
    const sp = env.sprites.getSprite(this.idStr);
    if (sp) { this.lastX = sp.x; this.lastY = sp.y; }
    if (this.s && env.beats) {
      setTex(this.s, env.beats[fxFrame("ping", this.t)]);
      place(this.s, f.view, this.lastX, this.lastY - 4, fadeOut(this.t, this.dur, this.dur * 0.25), 1, 0.6);
    }
    return true;
  }

  dispose(env: Env): void { env.pool.release(this.s); }
}

