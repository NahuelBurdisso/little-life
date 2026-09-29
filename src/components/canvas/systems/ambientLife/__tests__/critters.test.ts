import { describe, it, expect } from 'vitest';
import {
  makeRng, newBird, resetBird, stepBird, birdFrame, BIRD_FLEE_RADIUS,
  newButterfly, resetButterfly, stepButterfly, butterflyFrame,
  newMoth, resetMoth, stepMoth, mothFrame,
  newCat, resetCat, stepCat, catFrame,
  newDuck, resetDuck, stepDuck, duckFrame,
  splashFrame,
} from '../critters';
import { AMBIENT_FRAMES, AMBIENT_FRAME_COUNT } from '../ambientFrames';

const NONE = Infinity;
const open = () => false;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function validFrame(f: number) {
  expect(Number.isInteger(f)).toBe(true);
  expect(f).toBeGreaterThanOrEqual(0);
  expect(f).toBeLessThan(AMBIENT_FRAME_COUNT);
}

describe('makeRng', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = makeRng(7), b = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('bird', () => {
  const start = (rnd = makeRng(1)) => {
    const b = newBird();
    resetBird(b, 100, 100, rnd);
    return b;
  };

  it('starts on the ground, pecking or looking about', () => {
    const b = start();
    expect(['idle', 'peck']).toContain(b.mode);
    expect(b.gone).toBe(false);
  });

  it('pecks, hops and idles while nobody is near — and stays put on the ground', () => {
    const rnd = makeRng(3);
    const b = start(rnd);
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 120; i++) {
      stepBird(b, 1 / 60, 0, 0, NONE, rnd, open);
      seen.add(b.mode);
      expect(b.mode).not.toBe('flee');
    }
    expect(seen.has('peck')).toBe(true);
    expect(seen.has('idle')).toBe(true);
    expect(seen.has('hop')).toBe(true);
    // Hops are a few pixels each; two minutes of foraging never carries a bird far.
    expect(dist(b, { x: 100, y: 100 })).toBeLessThan(200);
    expect(b.lift).toBe(0);
  });

  it('flies off, away from the walker, when one comes within 40px', () => {
    const rnd = makeRng(5);
    const b = start(rnd);
    // Walker stands to the left of the bird, 30px away (bird - walker = +30, 0).
    stepBird(b, 1 / 60, 30, 0, 30 * 30, rnd, open);
    expect(b.mode).toBe('flee');
    expect(b.facing).toBe(1);
    const x0 = b.x, y0 = b.y;
    for (let i = 0; i < 30; i++) stepBird(b, 1 / 60, 30, 0, 900, rnd, open);
    expect(b.x).toBeGreaterThan(x0 + 20);   // away from the walker
    expect(b.y).toBeLessThan(y0);           // and up the screen
    expect(b.lift).toBeGreaterThan(0);
  });

  it('flees leftward from a walker on its right', () => {
    const rnd = makeRng(5);
    const b = start(rnd);
    stepBird(b, 1 / 60, -20, 5, 425, rnd, open);
    expect(b.mode).toBe('flee');
    expect(b.facing).toBe(-1);
    for (let i = 0; i < 20; i++) stepBird(b, 1 / 60, -20, 5, 425, rnd, open);
    expect(b.x).toBeLessThan(100);
  });

  it('ignores walkers outside the flee radius', () => {
    const rnd = makeRng(5);
    const b = start(rnd);
    const d = BIRD_FLEE_RADIUS + 1;
    stepBird(b, 1 / 60, d, 0, d * d, rnd, open);
    expect(b.mode).not.toBe('flee');
  });

  it('flees even from a walker standing exactly on it', () => {
    const rnd = makeRng(5);
    const b = start(rnd);
    stepBird(b, 1 / 60, 0, 0, 0, rnd, open);
    expect(b.mode).toBe('flee');
    stepBird(b, 1 / 60, 0, 0, 0, rnd, open);
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });

  it('is gone a few seconds after taking off, and never lands again', () => {
    const rnd = makeRng(9);
    const b = start(rnd);
    stepBird(b, 1 / 60, 10, 0, 100, rnd, open);
    let frames = 0;
    while (!b.gone && frames < 60 * 10) { stepBird(b, 1 / 60, NONE, 0, NONE, rnd, open); frames++; }
    expect(b.gone).toBe(true);
    expect(frames / 60).toBeGreaterThan(1);
    expect(frames / 60).toBeLessThan(5);
    expect(b.mode).toBe('flee');
  });

  it('will not hop into a blocked spot', () => {
    const rnd = makeRng(11);
    const b = start(rnd);
    const wall = () => true;
    for (let i = 0; i < 60 * 60; i++) stepBird(b, 1 / 60, 0, 0, NONE, rnd, wall);
    expect(b.x).toBe(100);
    expect(b.y).toBe(100);
  });

  it('draws valid frames: peck pair on the ground, hop, then wing beats', () => {
    const rnd = makeRng(2);
    const b = start(rnd);
    for (let i = 0; i < 60 * 30; i++) { stepBird(b, 1 / 60, 0, 0, NONE, rnd, open); validFrame(birdFrame(b)); }
    b.mode = 'hop'; expect(birdFrame(b)).toBe(AMBIENT_FRAMES.bird.hop);
    b.mode = 'flee';
    const flap = new Set<number>();
    for (let t = 0; t < 1; t += 0.02) { b.t = t; flap.add(birdFrame(b)); }
    expect([...flap].sort()).toEqual([...AMBIENT_FRAMES.bird.fly].sort());
    b.mode = 'peck';
    const peck = new Set<number>();
    for (let t = 0; t < 1; t += 0.02) { b.t = t; peck.add(birdFrame(b)); }
    expect([...peck].sort()).toEqual([...AMBIENT_FRAMES.bird.peck].sort());
  });
});

describe('butterfly', () => {
  it('flutters about its flower patch without drifting away', () => {
    const rnd = makeRng(4);
    const b = newButterfly();
    resetButterfly(b, 300, 200, rnd);
    let maxD = 0;
    const xs = new Set<number>();
    for (let i = 0; i < 60 * 90; i++) {
      stepButterfly(b, 1 / 60, rnd);
      maxD = Math.max(maxD, dist(b, { x: 300, y: 200 }));
      if (i % 60 === 0) xs.add(Math.round(b.x));
    }
    expect(maxD).toBeLessThan(140);
    expect(xs.size).toBeGreaterThan(20);           // it actually travels
    expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });

  it('faces the way it flies and beats its wings', () => {
    const rnd = makeRng(4);
    const b = newButterfly();
    resetButterfly(b, 0, 0, rnd);
    const frames = new Set<number>();
    for (let i = 0; i < 120; i++) { stepButterfly(b, 1 / 60, rnd); frames.add(butterflyFrame(b)); }
    expect([...frames].sort()).toEqual([...AMBIENT_FRAMES.butterfly].sort());
    expect([-1, 1]).toContain(b.facing);
  });
});

describe('moth', () => {
  it('circles its lit window', () => {
    const rnd = makeRng(6);
    const m = newMoth();
    resetMoth(m, 500, 300, rnd);
    let maxD = 0, minD = 1e9;
    for (let i = 0; i < 60 * 60; i++) {
      stepMoth(m, 1 / 60, rnd);
      const d = dist(m, { x: 500, y: 300 });
      maxD = Math.max(maxD, d);
      minD = Math.min(minD, d);
    }
    expect(maxD).toBeLessThan(20);
    expect(maxD).toBeGreaterThan(4);   // not stuck on the glass
    expect(minD).toBeLessThan(8);      // it drifts close to the light
  });

  it('flaps with valid frames', () => {
    const rnd = makeRng(6);
    const m = newMoth();
    resetMoth(m, 0, 0, rnd);
    const frames = new Set<number>();
    for (let i = 0; i < 60; i++) { stepMoth(m, 1 / 60, rnd); validFrame(mothFrame(m)); frames.add(mothFrame(m)); }
    expect(frames.size).toBe(2);
  });
});

describe('cat', () => {
  const start = (rnd = makeRng(1)) => {
    const c = newCat();
    resetCat(c, 200, 200, rnd);
    return c;
  };

  it('starts sitting by its home', () => {
    const c = start();
    expect(c.mode).toBe('sit');
    expect(c.x).toBe(200);
  });

  it('wanders near home and sits, licks and walks', () => {
    const rnd = makeRng(8);
    const c = start(rnd);
    const seen = new Set<string>();
    let maxD = 0;
    for (let i = 0; i < 60 * 300; i++) {
      stepCat(c, 1 / 60, rnd, open, NONE, 0, 0);
      seen.add(c.mode);
      maxD = Math.max(maxD, dist(c, { x: 200, y: 200 }));
      validFrame(catFrame(c));
    }
    expect(seen.has('sit')).toBe(true);
    expect(seen.has('walk')).toBe(true);
    expect(seen.has('lick')).toBe(true);
    expect(seen.has('follow')).toBe(false);
    expect(maxD).toBeLessThan(90);
  });

  it('sometimes follows a resident who walks by, keeping a polite distance', () => {
    const rnd = makeRng(12);
    let followed = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = makeRng(seed);
      const c = start(r);
      const agent = { x: 230, y: 200 };
      let close = 1e9;
      for (let i = 0; i < 60 * 60; i++) {
        const d2 = (agent.x - c.x) ** 2 + (agent.y - c.y) ** 2;
        stepCat(c, 1 / 60, r, open, d2, agent.x, agent.y);
        if (c.mode === 'follow') { followed++; close = Math.min(close, dist(c, agent)); break; }
      }
      if (c.mode === 'follow') expect(close).toBeGreaterThan(0);
    }
    expect(followed).toBeGreaterThan(3);
    expect(followed).toBeLessThan(20);   // "sometimes", not always
    void rnd;
  });

  it('trails the resident as they walk off, then gives up and sits', () => {
    const rnd = makeRng(2);
    const c = start(rnd);
    c.mode = 'follow'; c.t = 0; c.dur = 6;
    const agent = { x: 260, y: 200 };
    for (let i = 0; i < 60 * 3; i++) {
      agent.x += 0.4;  // ~24px/s
      const d2 = (agent.x - c.x) ** 2 + (agent.y - c.y) ** 2;
      stepCat(c, 1 / 60, rnd, open, d2, agent.x, agent.y);
    }
    expect(c.mode).toBe('follow');
    expect(dist(c, agent)).toBeLessThan(45);
    expect(dist(c, agent)).toBeGreaterThan(8);
    for (let i = 0; i < 60 * 5; i++) stepCat(c, 1 / 60, rnd, open, NONE, 0, 0);
    expect(c.mode).not.toBe('follow');
  });

  it('drops the chase when the resident is out of range', () => {
    const rnd = makeRng(2);
    const c = start(rnd);
    c.mode = 'follow'; c.t = 0; c.dur = 60;
    stepCat(c, 1 / 60, rnd, open, 400 * 400, 600, 200);
    expect(c.mode).toBe('sit');
  });

  it('does not walk through blocked ground', () => {
    const rnd = makeRng(8);
    const c = start(rnd);
    const wall = () => true;
    for (let i = 0; i < 60 * 120; i++) stepCat(c, 1 / 60, rnd, wall, NONE, 0, 0);
    expect(c.x).toBe(200);
    expect(c.y).toBe(200);
  });

  it('walks home after straying', () => {
    const rnd = makeRng(3);
    const c = start(rnd);
    c.x = 200 + 300; c.mode = 'sit'; c.t = 0; c.dur = 0.1;
    for (let i = 0; i < 60 * 40; i++) stepCat(c, 1 / 60, rnd, open, NONE, 0, 0);
    expect(dist(c, { x: 200, y: 200 })).toBeLessThan(200);
  });

  it('shows sit / lick / walk frames', () => {
    const c = start();
    c.mode = 'sit'; expect(catFrame(c)).toBe(AMBIENT_FRAMES.cat.sit);
    c.mode = 'lick'; expect(catFrame(c)).toBe(AMBIENT_FRAMES.cat.lick);
    c.mode = 'walk';
    const w = new Set<number>();
    for (let t = 0; t < 1; t += 0.02) { c.t = t; w.add(catFrame(c)); }
    expect([...w].sort()).toEqual([...AMBIENT_FRAMES.cat.walk].sort());
  });
});

describe('duck', () => {
  // A 10x10 tile pond at tiles (0..9, 0..9), 32px tiles.
  const pond = (x: number, y: number) => x >= 0 && y >= 0 && x < 320 && y < 320;

  it('paddles around without leaving the water', () => {
    const rnd = makeRng(5);
    const d = newDuck();
    resetDuck(d, 160, 160, rnd);
    let travelled = 0, px = d.x, py = d.y;
    for (let i = 0; i < 60 * 120; i++) {
      stepDuck(d, 1 / 60, rnd, pond);
      expect(pond(d.x, d.y)).toBe(true);
      travelled += Math.hypot(d.x - px, d.y - py);
      px = d.x; py = d.y;
      validFrame(duckFrame(d));
    }
    expect(travelled).toBeGreaterThan(100);
  });

  it('stays put when boxed in', () => {
    const rnd = makeRng(5);
    const d = newDuck();
    resetDuck(d, 16, 16, rnd);
    const puddle = (x: number, y: number) => Math.abs(x - 16) < 3 && Math.abs(y - 16) < 3;
    for (let i = 0; i < 60 * 60; i++) stepDuck(d, 1 / 60, rnd, puddle);
    expect(puddle(d.x, d.y)).toBe(true);
  });
});

describe('splashFrame', () => {
  it('loops the three splash frames', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 3; t += 0.05) { const f = splashFrame(t); validFrame(f); seen.add(f); }
    expect([...seen].sort()).toEqual([...AMBIENT_FRAMES.splash].sort());
  });
});
