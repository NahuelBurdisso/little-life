import { describe, it, expect } from 'vitest';
import {
  statePoseFor,
  poseOffsets,
  newPoseOffsets,
  POSE_KINDS,
  SHIVER_TINT,
  type PoseKind,
} from '../statePose';

const states = (...types: string[]) => ({ activeStates: types.map(type => ({ type })) });
const kindOf = (a: Parameters<typeof statePoseFor>[0]) => statePoseFor(a).kind;

describe('statePoseFor: single states', () => {
  it.each([
    ['drunk', 'sway'],
    ['sick', 'shiver'],
    ['hungover', 'shiver'],
    ['heartbroken', 'slump'],
    ['depressed', 'slump'],
    ['grieving', 'slump'],
    ['angry', 'stomp'],
    ['euphoric', 'bounce'],
    ['stressed', 'fidget'],
    ['arrested', 'hunch'],
  ])('%s -> %s', (state, kind) => {
    expect(kindOf(states(state))).toBe(kind);
  });

  it('gives no pose for states without a body language', () => {
    for (const s of ['lonely', 'jealous', 'in_debt', 'confident', 'infatuated', 'alcoholic']) {
      expect(kindOf(states(s)), s).toBe('none');
    }
    expect(kindOf({})).toBe('none');
    expect(kindOf({ activeStates: [], needs: null })).toBe('none');
  });

  it('only shiver tints the sprite', () => {
    for (const kind of POSE_KINDS) {
      const tinted = kind === 'shiver';
      const sample = { sway: 'drunk', shiver: 'sick', slump: 'grieving', stomp: 'angry', bounce: 'euphoric', fidget: 'stressed', hunch: 'arrested', none: 'lonely' }[kind];
      expect(statePoseFor(states(sample)).tint === 0xffffff, kind).toBe(!tinted);
    }
    expect(statePoseFor(states('sick')).tint).toBe(SHIVER_TINT);
  });
});

describe('statePoseFor: mood thresholds', () => {
  it('slumps below 20 and bounces above 85, strictly', () => {
    expect(kindOf({ needs: { mood: 19.9 } })).toBe('slump');
    expect(kindOf({ needs: { mood: 20 } })).toBe('none');
    expect(kindOf({ needs: { mood: 50 } })).toBe('none');
    expect(kindOf({ needs: { mood: 85 } })).toBe('none');
    expect(kindOf({ needs: { mood: 85.1 } })).toBe('bounce');
    expect(kindOf({ needs: { mood: 100 } })).toBe('bounce');
    expect(kindOf({ needs: { mood: 0 } })).toBe('slump');
  });

  it('treats a missing mood as neutral', () => {
    expect(kindOf({ needs: {} })).toBe('none');
    expect(kindOf({ needs: { mood: undefined } })).toBe('none');
  });
});

describe('statePoseFor: priority', () => {
  // Order (highest first): arrested, drunk, sick/hungover, angry, sad (states or mood < 20),
  // stressed, happy (euphoric or mood > 85).
  it('arrest overrides everything: nobody swaggers off in cuffs', () => {
    expect(kindOf(states('drunk', 'arrested'))).toBe('hunch');
    expect(kindOf(states('angry', 'arrested', 'euphoric'))).toBe('hunch');
  });

  it('drunk beats angry: the sway is a body impairment, the stomp only a mood', () => {
    expect(kindOf(states('angry', 'drunk'))).toBe('sway');
    expect(kindOf(states('drunk', 'angry'))).toBe('sway');
  });

  it('a drunk who is also sick still sways; sick beats angry and sadness', () => {
    expect(kindOf(states('sick', 'drunk'))).toBe('sway');
    expect(kindOf(states('angry', 'sick'))).toBe('shiver');
    expect(kindOf(states('heartbroken', 'hungover'))).toBe('shiver');
  });

  it('angry beats sad and stressed', () => {
    expect(kindOf(states('grieving', 'angry'))).toBe('stomp');
    expect(kindOf(states('stressed', 'angry'))).toBe('stomp');
    expect(kindOf({ ...states('angry'), needs: { mood: 5 } })).toBe('stomp');
  });

  it('sadness beats stress and happiness', () => {
    expect(kindOf(states('stressed', 'depressed'))).toBe('slump');
    expect(kindOf({ ...states('stressed'), needs: { mood: 10 } })).toBe('slump');
    expect(kindOf({ ...states('euphoric', 'heartbroken') })).toBe('slump');
  });

  it('stress beats a high mood', () => {
    expect(kindOf({ ...states('stressed'), needs: { mood: 95 } })).toBe('fidget');
    expect(kindOf(states('euphoric', 'stressed'))).toBe('fidget');
  });

  it('does not depend on the order states are listed in', () => {
    const all = ['drunk', 'sick', 'angry', 'grieving', 'stressed', 'euphoric', 'arrested'];
    const forward = kindOf(states(...all));
    expect(kindOf(states(...[...all].reverse()))).toBe(forward);
    expect(forward).toBe('hunch');
  });

  it('returns shared descriptors, so the per-frame path allocates nothing', () => {
    expect(statePoseFor(states('drunk'))).toBe(statePoseFor(states('drunk')));
  });
});

describe('poseOffsets', () => {
  const out = newPoseOffsets();
  const sample = (kind: PoseKind, seconds: number, step = 1 / 240) => {
    const range = { dx: [0, 0], dy: [0, 0], rot: [0, 0] };
    for (let t = 0; t <= seconds; t += step) {
      poseOffsets(kind, t, out);
      for (const k of ['dx', 'dy', 'rot'] as const) {
        range[k][0] = Math.min(range[k][0], out[k]);
        range[k][1] = Math.max(range[k][1], out[k]);
      }
    }
    return range;
  };

  it('none is the identity', () => {
    poseOffsets('none', 3.7, out);
    expect(out).toEqual({ dx: 0, dy: 0, rot: 0, scaleY: 1, breathRate: 1 });
  });

  it('sway: +-0.12 rad lean and +-1.5 px drift at 0.4 Hz', () => {
    const r = sample('sway', 2.5);
    expect(r.rot[1]).toBeCloseTo(0.12, 2);
    expect(r.rot[0]).toBeCloseTo(-0.12, 2);
    expect(r.dx[1]).toBeCloseTo(1.5, 1);
    expect(r.dx[0]).toBeCloseTo(-1.5, 1);
    poseOffsets('sway', 0, out);
    const start = { ...out };
    poseOffsets('sway', 2.5, out); // one full period later
    expect(out.rot).toBeCloseTo(start.rot, 6);
    expect(out.dx).toBeCloseTo(start.dx, 6);
    expect(out.dy).toBe(0);
  });

  it('shiver: a fast jitter within +-0.5 px', () => {
    const r = sample('shiver', 1);
    expect(r.dx[1]).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(r.dx[0]).toBeGreaterThanOrEqual(-0.5 - 1e-9);
    expect(r.dx[1]).toBeGreaterThan(0.4);
    // Fast: many sign changes per second.
    let flips = 0;
    let prev = 0;
    for (let t = 0; t < 1; t += 1 / 240) {
      poseOffsets('shiver', t, out);
      const s = Math.sign(out.dx);
      if (s !== 0 && prev !== 0 && s !== prev) flips++;
      if (s !== 0) prev = s;
    }
    expect(flips).toBeGreaterThan(8);
  });

  it('slump: squashed to 0.94, leaning forward 0.08 rad, breathing slower, and still', () => {
    for (const t of [0, 0.3, 1.9]) {
      poseOffsets('slump', t, out);
      expect(out.scaleY).toBeCloseTo(0.94, 6);
      expect(out.rot).toBeCloseTo(0.08, 6);
      expect(out.breathRate).toBeLessThan(1);
      expect(out.breathRate).toBeGreaterThan(0);
      expect(out.dx).toBe(0);
      expect(out.dy).toBe(0);
    }
  });

  it('stomp: a 1 px hop once every 1.2 s, then a small shake, otherwise still', () => {
    const r = sample('stomp', 1.2);
    expect(r.dy[0]).toBeCloseTo(-1, 1);       // up is negative y
    expect(r.dy[1]).toBeLessThanOrEqual(1e-9); // never dips below rest
    expect(Math.abs(r.dx[0])).toBeGreaterThan(0);
    expect(Math.abs(r.dx[0])).toBeLessThan(0.6);
    // Periodic every 1.2 s.
    poseOffsets('stomp', 0.13, out);
    const a = out.dy;
    poseOffsets('stomp', 0.13 + 1.2 * 3, out);
    expect(out.dy).toBeCloseTo(a, 6);
    // Mostly rest: the hop only fills the start of the cycle.
    poseOffsets('stomp', 0.9, out);
    expect(out.dy).toBe(0);
    expect(out.dx).toBe(0);
  });

  it('bounce: a happy hop every 2 s', () => {
    const r = sample('bounce', 2);
    expect(r.dy[0]).toBeLessThan(-1);
    expect(r.dy[0]).toBeGreaterThan(-2.5);
    expect(r.dy[1]).toBeLessThanOrEqual(1e-9);
    poseOffsets('bounce', 1.5, out);
    expect(out.dy).toBe(0);
    poseOffsets('bounce', 0.1, out);
    const a = out.dy;
    poseOffsets('bounce', 0.1 + 2 * 5, out);
    expect(out.dy).toBeCloseTo(a, 6);
  });

  it('fidget: a quick 0.5 px twitch every 0.8 s, alternating sides', () => {
    const r = sample('fidget', 1.6);
    expect(r.dx[1]).toBeCloseTo(0.5, 1);
    expect(r.dx[0]).toBeCloseTo(-0.5, 1);
    poseOffsets('fidget', 0.5, out);
    expect(out.dx).toBe(0);
    expect(out.dy).toBe(0);
  });

  it('hunch: leaning and squashed like a slump but without breathing', () => {
    poseOffsets('hunch', 1, out);
    expect(out.rot).toBeGreaterThan(0.05);
    expect(out.scaleY).toBeLessThan(1);
    expect(out.breathRate).toBe(0);
    expect(out.dy).toBe(0);
  });

  it('is finite for any clock value', () => {
    for (const kind of POSE_KINDS) {
      for (const t of [0, 1e-9, 12.3456, 3600, 1e6]) {
        poseOffsets(kind, t, out);
        for (const v of Object.values(out)) expect(Number.isFinite(v), `${kind} @${t}`).toBe(true);
      }
    }
  });
});
