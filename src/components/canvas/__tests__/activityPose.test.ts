import { describe, it, expect } from 'vitest';
import { activityPoseOffsets, newActivityOffsets, ACTIVITY_POSE_KINDS } from '../statePose';

const out = newActivityOffsets();

describe('activityPoseOffsets', () => {
  it('none leaves the body alone', () => {
    activityPoseOffsets('none', 3, out);
    expect(out).toEqual({ dx: 0, dy: 0, rot: 0, scaleY: 1, breathRate: 1, face: 0, legs: false });
  });

  it('jog runs the legs, hops fast, paces a short lap and turns at each end', () => {
    let minDy = 0, minDx = 0, maxDx = 0;
    const faces = new Set<number>();
    for (let t = 0; t < 6; t += 0.02) {
      activityPoseOffsets('jog', t, out);
      expect(out.legs).toBe(true);
      minDy = Math.min(minDy, out.dy);
      minDx = Math.min(minDx, out.dx);
      maxDx = Math.max(maxDx, out.dx);
      faces.add(out.face);
    }
    expect(minDy).toBeLessThan(-1.5);
    expect(minDy).toBeGreaterThanOrEqual(-2);
    expect(maxDx).toBeGreaterThan(4);
    expect(minDx).toBeLessThan(-4);
    expect(faces).toEqual(new Set([1, -1]));
    expect(out.rot).toBeGreaterThan(0);
  });

  it('jog faces the way it is pacing', () => {
    for (let t = 0.1; t < 6; t += 0.13) {
      const a = activityPoseOffsets('jog', t, newActivityOffsets());
      const b = activityPoseOffsets('jog', t + 0.01, newActivityOffsets());
      if (Math.abs(b.dx - a.dx) < 0.02) continue; // the turning point
      expect(a.face).toBe(b.dx > a.dx ? 1 : -1);
    }
  });

  it('crouch squats, hunches and glances both ways', () => {
    const faces = new Set<number>();
    for (let t = 0; t < 6; t += 0.1) faces.add(activityPoseOffsets('crouch', t, out).face);
    expect(faces).toEqual(new Set([1, -1]));
    expect(out.scaleY).toBeLessThan(0.9);
    expect(out.dy).toBeGreaterThan(1);
    expect(out.rot).toBeGreaterThan(0.1);
    expect(out.legs).toBe(false);
  });

  it('shifty and look glance more slowly than the crouch', () => {
    const flips = (kind: 'crouch' | 'shifty' | 'look') => {
      let n = 0, last = 0;
      for (let t = 0; t < 30; t += 0.05) {
        const f = activityPoseOffsets(kind, t, out).face;
        if (last && f !== last) n++;
        last = f;
      }
      return n;
    };
    expect(flips('crouch')).toBeGreaterThan(flips('shifty'));
    expect(flips('shifty')).toBeGreaterThanOrEqual(flips('look'));
    expect(flips('look')).toBeGreaterThan(2);
  });

  it('the pulse poses are quiet between their beats', () => {
    let clapMoving = 0, clapStill = 0, orateMoving = 0, orateStill = 0, nibbleStill = 0;
    for (let t = 0; t < 20; t += 0.05) {
      activityPoseOffsets('clap', t, out);
      if (out.dy !== 0) clapMoving++; else clapStill++;
      activityPoseOffsets('orate', t, out);
      if (out.dy !== 0) orateMoving++; else orateStill++;
      activityPoseOffsets('nibble', t, out);
      if (out.dy === 0) nibbleStill++;
    }
    expect(clapMoving).toBeGreaterThan(0);
    expect(clapStill).toBeGreaterThan(clapMoving);
    expect(orateMoving).toBeGreaterThan(0);
    expect(orateStill).toBeGreaterThan(orateMoving);
    expect(nibbleStill).toBeGreaterThan(0);
  });

  it('lean tips the body forward', () => {
    activityPoseOffsets('lean', 1, out);
    expect(out.rot).toBeGreaterThan(0.1);
  });

  it('only jog runs the legs, only glancing poses turn the head', () => {
    for (const kind of ACTIVITY_POSE_KINDS) {
      let legs = false, face = false;
      for (let t = 0; t < 10; t += 0.1) {
        activityPoseOffsets(kind, t, out);
        legs ||= out.legs;
        face ||= out.face !== 0;
      }
      expect(legs, kind).toBe(kind === 'jog');
      expect(face, kind).toBe(['jog', 'crouch', 'shifty', 'look'].includes(kind));
    }
  });

  it('is finite for any clock value and writes into the given object', () => {
    for (const kind of ACTIVITY_POSE_KINDS) {
      for (const t of [0, 1e-9, 12.3456, 3600, 1e6]) {
        const o = activityPoseOffsets(kind, t, out);
        expect(o).toBe(out);
        for (const v of [o.dx, o.dy, o.rot, o.scaleY, o.breathRate]) expect(Number.isFinite(v), `${kind} @${t}`).toBe(true);
      }
    }
  });
});
