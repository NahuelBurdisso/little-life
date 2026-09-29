/**
 * Behaviour of the ambient critters as plain state machines. Pure — no PixiJS, no
 * allocation in the step functions (the system preallocates one state object per pool
 * slot and mutates it), and every random choice goes through an injected `rnd` so tests
 * are deterministic.
 *
 * All positions are world pixels; `dt` is seconds. Critters are drawn facing right and
 * mirrored by `facing` (+1 right, -1 left).
 */
import { AMBIENT_FRAMES } from './ambientFrames';

export type Rng = () => number;
/** Whether a world point is unwalkable for ground critters (buildings...). */
export type Blocked = (x: number, y: number) => boolean;

/** mulberry32 — tiny seeded generator for tests and the system's own stream. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rnd: Rng, lo: number, hi: number) => lo + rnd() * (hi - lo);
/** Which of `n` frames a clock `t` is on when each lasts `period` seconds. */
const cycle = (t: number, period: number, n: number) => Math.floor(t / period) % n;

// ── Birds ───────────────────────────────────────────────────────────────────────────────

/** A walker closer than this (px) sends a bird flying. */
export const BIRD_FLEE_RADIUS = 40;
const BIRD_FLIGHT_TIME = 2.5;    // seconds airborne before the bird is out of the picture
const BIRD_TETHER = 60;          // px a foraging bird may stray from where it landed

export type BirdMode = 'idle' | 'peck' | 'hop' | 'flee';

export interface BirdState {
  mode: BirdMode;
  /** Seconds in the current mode, and how long that mode lasts. */
  t: number;
  dur: number;
  x: number;
  y: number;
  /** Where it landed; foraging hops drift back toward it. */
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  /** Px above the ground (hop arc, then flight). */
  lift: number;
  /** Airborne long enough to leave: the system recycles it. */
  gone: boolean;
}

export const newBird = (): BirdState => ({
  mode: 'idle', t: 0, dur: 1, x: 0, y: 0, homeX: 0, homeY: 0, vx: 0, vy: 0, facing: 1, lift: 0, gone: false,
});

export function resetBird(b: BirdState, x: number, y: number, rnd: Rng): void {
  b.x = x; b.y = y; b.homeX = x; b.homeY = y;
  b.vx = 0; b.vy = 0; b.lift = 0; b.gone = false;
  b.facing = rnd() < 0.5 ? 1 : -1;
  b.mode = rnd() < 0.5 ? 'peck' : 'idle';
  b.t = 0;
  b.dur = b.mode === 'peck' ? between(rnd, 1.2, 2.8) : between(rnd, 0.5, 1.6);
}

function birdMode(b: BirdState, mode: BirdMode, dur: number): void {
  b.mode = mode; b.t = 0; b.dur = dur;
}

/**
 * `tdx/tdy` is the vector from the nearest walker to the bird and `td2` its squared
 * length (Infinity when nobody is around), so the step needs no agent list.
 */
export function stepBird(
  b: BirdState, dt: number, tdx: number, tdy: number, td2: number, rnd: Rng, blocked: Blocked,
): void {
  if (b.mode !== 'flee' && td2 < BIRD_FLEE_RADIUS * BIRD_FLEE_RADIUS) {
    const len = Math.sqrt(td2);
    let nx = len > 0.001 ? tdx / len : b.facing;
    // Always leave sideways too, so a walker straight above doesn't send it into their face.
    if (Math.abs(nx) < 0.3) nx = nx < 0 || (nx === 0 && b.facing < 0) ? -0.3 : 0.3;
    const speed = between(rnd, 80, 110);
    b.vx = nx * speed;
    b.vy = -between(rnd, 40, 65);
    b.facing = b.vx >= 0 ? 1 : -1;
    b.lift = 0;
    birdMode(b, 'flee', BIRD_FLIGHT_TIME);
  }

  b.t += dt;
  switch (b.mode) {
    case 'flee':
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.lift += 14 * dt;
      if (b.t >= b.dur) b.gone = true;
      return;

    case 'hop': {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.lift = Math.sin(Math.PI * Math.min(1, b.t / b.dur)) * 3;
      if (b.t < b.dur) return;
      b.lift = 0;
      if (rnd() < 0.7) birdMode(b, 'peck', between(rnd, 1.2, 2.8));
      else birdMode(b, 'idle', between(rnd, 0.5, 1.6));
      return;
    }

    case 'peck':
    case 'idle': {
      if (b.t < b.dur) return;
      const r = rnd();
      const pecking = b.mode === 'peck';
      if (r < (pecking ? 0.25 : 0.2)) {
        // Hop a few px, biased home once it has wandered.
        const far = Math.hypot(b.x - b.homeX, b.y - b.homeY) > BIRD_TETHER;
        const ang = far ? Math.atan2(b.homeY - b.y, b.homeX - b.x) + between(rnd, -0.6, 0.6) : rnd() * Math.PI * 2;
        const dist = between(rnd, 6, 12);
        const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist * 0.6;
        if (blocked(b.x + dx, b.y + dy)) { birdMode(b, 'idle', between(rnd, 0.5, 1.2)); return; }
        const dur = 0.22;
        b.vx = dx / dur; b.vy = dy / dur;
        if (Math.abs(dx) > 1) b.facing = dx >= 0 ? 1 : -1;
        birdMode(b, 'hop', dur);
      } else if (pecking ? r < 0.6 : r < 0.75) {
        // After a burst of pecking, look up; after looking, peck.
        birdMode(b, pecking ? 'idle' : 'peck', pecking ? between(rnd, 0.5, 1.6) : between(rnd, 1.2, 2.8));
      } else {
        // Another round of the same, sometimes glancing the other way first.
        if (rnd() < 0.5) b.facing = b.facing === 1 ? -1 : 1;
        birdMode(b, b.mode, pecking ? between(rnd, 1.2, 2.8) : between(rnd, 0.5, 1.6));
      }
      return;
    }
  }
}

export function birdFrame(b: BirdState): number {
  switch (b.mode) {
    case 'hop': return AMBIENT_FRAMES.bird.hop;
    case 'flee': return AMBIENT_FRAMES.bird.fly[cycle(b.t, 0.08, 2)];
    case 'peck': return AMBIENT_FRAMES.bird.peck[cycle(b.t, 0.18, 2)];
    default: return AMBIENT_FRAMES.bird.peck[0];
  }
}

// ── Butterflies ─────────────────────────────────────────────────────────────────────────

const BUTTERFLY_TETHER = 70;     // px from its flower patch before it turns back

export interface ButterflyState {
  x: number;
  y: number;
  ax: number;
  ay: number;
  heading: number;
  turn: number;
  speed: number;
  t: number;
  facing: 1 | -1;
  /** Vertical flutter offset for drawing (px, screen down positive). */
  bob: number;
}

export const newButterfly = (): ButterflyState => ({
  x: 0, y: 0, ax: 0, ay: 0, heading: 0, turn: 0, speed: 20, t: 0, facing: 1, bob: 0,
});

export function resetButterfly(b: ButterflyState, x: number, y: number, rnd: Rng): void {
  b.x = x; b.y = y; b.ax = x; b.ay = y;
  b.heading = rnd() * Math.PI * 2;
  b.turn = 0;
  b.speed = between(rnd, 14, 24);
  b.t = rnd() * 10;
  b.facing = Math.cos(b.heading) >= 0 ? 1 : -1;
  b.bob = 0;
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function stepButterfly(b: ButterflyState, dt: number, rnd: Rng): void {
  b.t += dt;
  b.turn += (rnd() - 0.5) * 10 * dt;
  b.turn -= b.turn * 0.8 * dt;
  if (b.turn > 3) b.turn = 3; else if (b.turn < -3) b.turn = -3;
  b.heading += b.turn * dt;

  const dx = b.ax - b.x, dy = b.ay - b.y;
  if (dx * dx + dy * dy > BUTTERFLY_TETHER * BUTTERFLY_TETHER) {
    b.heading += wrapPi(Math.atan2(dy, dx) - b.heading) * Math.min(1, 1.5 * dt);
  }
  const c = Math.cos(b.heading);
  b.x += c * b.speed * dt;
  b.y += Math.sin(b.heading) * b.speed * dt;
  if (c > 0.2) b.facing = 1; else if (c < -0.2) b.facing = -1;
  b.bob = Math.sin(b.t * 6) * 1.5;
}

export const butterflyFrame = (b: ButterflyState): number =>
  AMBIENT_FRAMES.butterfly[cycle(b.t, 0.09, 2)];

// ── Moths ───────────────────────────────────────────────────────────────────────────────

export interface MothState {
  x: number;
  y: number;
  /** The lit window it circles. */
  ax: number;
  ay: number;
  angle: number;
  spin: number;
  radius: number;
  targetRadius: number;
  retarget: number;
  t: number;
  facing: 1 | -1;
}

export const newMoth = (): MothState => ({
  x: 0, y: 0, ax: 0, ay: 0, angle: 0, spin: 4, radius: 8, targetRadius: 8, retarget: 1, t: 0, facing: 1,
});

export function resetMoth(m: MothState, ax: number, ay: number, rnd: Rng): void {
  m.ax = ax; m.ay = ay; m.x = ax; m.y = ay;
  m.angle = rnd() * Math.PI * 2;
  m.spin = (rnd() < 0.5 ? -1 : 1) * between(rnd, 3, 7);
  m.radius = between(rnd, 3, 10);
  m.targetRadius = m.radius;
  m.retarget = between(rnd, 0.3, 1.5);
  m.t = rnd() * 10;
  m.facing = 1;
}

export function stepMoth(m: MothState, dt: number, rnd: Rng): void {
  m.t += dt;
  m.retarget -= dt;
  if (m.retarget <= 0) {
    // Drawn to the glass, then thrown off it again.
    m.targetRadius = between(rnd, 1, 13);
    m.spin = (rnd() < 0.3 ? -Math.sign(m.spin) : Math.sign(m.spin)) * between(rnd, 3, 7);
    m.retarget = between(rnd, 0.4, 1.6);
  }
  m.radius += (m.targetRadius - m.radius) * Math.min(1, 3 * dt);
  m.angle += m.spin * dt;
  const px = m.x;
  m.x = m.ax + Math.cos(m.angle) * m.radius + Math.sin(m.t * 23) * 0.8;
  m.y = m.ay + Math.sin(m.angle) * m.radius * 0.7 + Math.cos(m.t * 19) * 0.8;
  if (m.x - px > 0.05) m.facing = 1; else if (m.x - px < -0.05) m.facing = -1;
}

export const mothFrame = (m: MothState): number => AMBIENT_FRAMES.moth[cycle(m.t, 0.05, 2)];

// ── Cats ────────────────────────────────────────────────────────────────────────────────

const CAT_WALK_SPEED = 20;       // px/s
const CAT_FOLLOW_SPEED = 30;
const CAT_ROAM = 56;             // px from home it wanders
const CAT_FOLLOW_TRIGGER = 80;   // a resident this close may catch its interest
const CAT_FOLLOW_KEEP = 24;      // stops this far behind them
const CAT_FOLLOW_GIVE_UP = 160;  // a resident this far away is forgotten
const CAT_FOLLOW_CHANCE = 0.2;   // per decision, when a resident is close

export type CatMode = 'sit' | 'lick' | 'walk' | 'follow';

export interface CatState {
  mode: CatMode;
  t: number;
  dur: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  homeX: number;
  homeY: number;
  facing: 1 | -1;
  /** Seconds before it may follow someone again. */
  followCool: number;
  /** Following, but caught up: sit-frame instead of walk-frame. */
  moving: boolean;
}

export const newCat = (): CatState => ({
  mode: 'sit', t: 0, dur: 1, x: 0, y: 0, tx: 0, ty: 0, homeX: 0, homeY: 0, facing: 1, followCool: 0, moving: false,
});

export function resetCat(c: CatState, hx: number, hy: number, rnd: Rng): void {
  c.homeX = hx; c.homeY = hy; c.x = hx; c.y = hy; c.tx = hx; c.ty = hy;
  c.mode = 'sit'; c.t = 0; c.dur = between(rnd, 1, 4);
  c.facing = rnd() < 0.5 ? 1 : -1;
  c.followCool = between(rnd, 0, 10);
  c.moving = false;
}

function catMode(c: CatState, mode: CatMode, dur: number): void {
  c.mode = mode; c.t = 0; c.dur = dur; c.moving = mode === 'walk';
}

/** Move toward (tx, ty) by `step` px unless the ground there is blocked. Returns the distance left. */
function catMove(c: CatState, tx: number, ty: number, step: number, blocked: Blocked): number {
  const dx = tx - c.x, dy = ty - c.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1.5) return 0;
  const k = Math.min(1, step / d);
  const nx = c.x + dx * k, ny = c.y + dy * k;
  if (blocked(nx, ny)) return -1;
  c.x = nx; c.y = ny;
  if (Math.abs(dx) > 0.5) c.facing = dx >= 0 ? 1 : -1;
  return d - step;
}

/**
 * `agentD2` is the squared distance to the nearest resident (Infinity if none) and
 * (`ax`, `ay`) where they stand — a cat follows whoever is nearest.
 */
export function stepCat(
  c: CatState, dt: number, rnd: Rng, blocked: Blocked, agentD2: number, ax: number, ay: number,
): void {
  c.t += dt;
  if (c.followCool > 0) c.followCool -= dt;

  switch (c.mode) {
    case 'walk': {
      const left = catMove(c, c.tx, c.ty, CAT_WALK_SPEED * dt, blocked);
      if (left === -1) catMode(c, 'sit', between(rnd, 1, 3));          // bumped into something
      else if (left <= 0) catMode(c, 'sit', between(rnd, 4, 12));      // arrived
      return;
    }

    case 'follow': {
      if (c.t >= c.dur || agentD2 > CAT_FOLLOW_GIVE_UP * CAT_FOLLOW_GIVE_UP) {
        c.followCool = between(rnd, 25, 50);
        catMode(c, 'sit', between(rnd, 3, 8));
        return;
      }
      if (agentD2 > CAT_FOLLOW_KEEP * CAT_FOLLOW_KEEP) {
        const left = catMove(c, ax, ay, CAT_FOLLOW_SPEED * dt, blocked);
        c.moving = left !== -1;
      } else {
        c.moving = false;
      }
      return;
    }

    case 'sit':
    case 'lick': {
      if (c.t < c.dur) return;
      // A decision point: follow a passing resident, groom, or wander.
      if (c.followCool <= 0 && agentD2 < CAT_FOLLOW_TRIGGER * CAT_FOLLOW_TRIGGER && rnd() < CAT_FOLLOW_CHANCE) {
        catMode(c, 'follow', between(rnd, 8, 16));
        c.moving = true;
        return;
      }
      const r = rnd();
      if (c.mode === 'sit' && r < 0.25) { catMode(c, 'lick', between(rnd, 2, 3.5)); return; }
      if (c.mode === 'lick' || r < 0.45) { catMode(c, 'sit', between(rnd, 4, 9)); return; }

      // Pick somewhere to go: back toward home when it has strayed, otherwise a spot near it.
      const homeD = Math.hypot(c.x - c.homeX, c.y - c.homeY);
      for (let i = 0; i < 4; i++) {
        const ang = rnd() * Math.PI * 2;
        const rad = homeD > CAT_ROAM * 2 ? between(rnd, 0, 16) : between(rnd, 16, CAT_ROAM);
        const tx = c.homeX + Math.cos(ang) * rad;
        const ty = c.homeY + Math.sin(ang) * rad * 0.6;
        if (blocked(tx, ty)) continue;
        c.tx = tx; c.ty = ty;
        catMode(c, 'walk', 0);
        return;
      }
      catMode(c, 'sit', between(rnd, 2, 5));
      return;
    }
  }
}

export function catFrame(c: CatState): number {
  switch (c.mode) {
    case 'lick': return AMBIENT_FRAMES.cat.lick;
    case 'walk': return AMBIENT_FRAMES.cat.walk[cycle(c.t, 0.22, 2)];
    case 'follow': return c.moving ? AMBIENT_FRAMES.cat.walk[cycle(c.t, 0.16, 2)] : AMBIENT_FRAMES.cat.sit;
    default: return AMBIENT_FRAMES.cat.sit;
  }
}

// ── Ducks ───────────────────────────────────────────────────────────────────────────────

const DUCK_LOOKAHEAD = 6;        // px probed ahead so it turns before leaving the water

export interface DuckState {
  x: number;
  y: number;
  heading: number;
  speed: number;
  mode: 'swim' | 'rest';
  t: number;
  dur: number;
  facing: 1 | -1;
}

export const newDuck = (): DuckState => ({
  x: 0, y: 0, heading: 0, speed: 9, mode: 'swim', t: 0, dur: 4, facing: 1,
});

export function resetDuck(d: DuckState, x: number, y: number, rnd: Rng): void {
  d.x = x; d.y = y;
  d.heading = rnd() * Math.PI * 2;
  d.speed = between(rnd, 7, 12);
  d.mode = 'swim'; d.t = 0; d.dur = between(rnd, 3, 8);
  d.facing = Math.cos(d.heading) >= 0 ? 1 : -1;
}

export function stepDuck(d: DuckState, dt: number, rnd: Rng, isWater: Blocked): void {
  d.t += dt;
  if (d.mode === 'rest') {
    if (d.t >= d.dur) { d.mode = 'swim'; d.t = 0; d.dur = between(rnd, 3, 8); }
    return;
  }
  const c = Math.cos(d.heading), s = Math.sin(d.heading);
  if (!isWater(d.x + c * DUCK_LOOKAHEAD, d.y + s * DUCK_LOOKAHEAD)) {
    // Shore ahead: turn away and float a moment.
    d.heading += Math.PI * between(rnd, 0.6, 1.4);
    d.mode = 'rest'; d.t = 0; d.dur = between(rnd, 0.4, 1.5);
    d.facing = Math.cos(d.heading) >= 0 ? 1 : -1;
    return;
  }
  d.x += c * d.speed * dt;
  d.y += s * d.speed * dt;
  if (d.t >= d.dur) {
    // Drift onto a new line now and then.
    d.heading += between(rnd, -0.9, 0.9);
    d.t = 0; d.dur = between(rnd, 3, 8);
    d.facing = Math.cos(d.heading) >= 0 ? 1 : -1;
  }
}

export const duckFrame = (d: DuckState): number => AMBIENT_FRAMES.duck[cycle(d.t, 0.6, 2)];

// ── Fountain ────────────────────────────────────────────────────────────────────────────

/** Well splash frame at animation clock `t` (seconds). */
export const splashFrame = (t: number): number => AMBIENT_FRAMES.splash[cycle(t, 0.18, 3)];
