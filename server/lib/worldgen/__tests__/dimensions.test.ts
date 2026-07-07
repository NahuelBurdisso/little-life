import { describe, it, expect } from 'vitest';
import { dimensionsStage } from '../stages/dimensions';
import { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT } from '../config';
import { makeRng } from '../rng';
import type { WorldContext } from '../types';

const EMPTY_CTX: WorldContext = {
  dimensions: null, terrainTiles: null, roads: null, publicBuildings: null,
  homes: null, interiors: null, names: null,
};
const RNG = makeRng(0);

function run(cfg: any, agentCount: number, extras: any = {}) {
  return dimensionsStage.run(EMPTY_CTX, RNG, cfg, agentCount, extras).dimensions!;
}

describe('dimensions stage', () => {
  it('medium tier returns 60×45', () => {
    expect(run({ sizeTier: 'medium', overrides: {} }, 15)).toEqual({ width: 60, height: 45 });
  });

  it('large tier returns 80×60', () => {
    expect(run({ sizeTier: 'large', overrides: {} }, 15)).toEqual({ width: 80, height: 60 });
  });

  it('custom tier returns customDimensions verbatim', () => {
    expect(
      run({ sizeTier: 'custom', customDimensions: { width: 55, height: 42 }, overrides: {} }, 15)
    ).toEqual({ width: 55, height: 42 });
  });

  it('auto formula scales with agent count', () => {
    // N=15 → 30 + ceil(1.8*15) = 30 + 27 = 57, clamped up to MIN_WIDTH=56 (57 > 56 OK)
    // height: 20 + ceil(1.3*15) = 20 + 20 = 40, clamped up to MIN_HEIGHT=43
    expect(run({ sizeTier: 'auto', overrides: {} }, 15)).toEqual({ width: 57, height: 43 });
  });

  it('auto formula clamps at MIN for low agent counts', () => {
    // N=1 → 30 + 2 = 32, clamped up to MIN_WIDTH=48
    //       20 + 2 = 22, clamped up to MIN_HEIGHT=37
    expect(run({ sizeTier: 'auto', overrides: {} }, 1)).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it('auto formula clamps at MAX for high agent counts', () => {
    // N=100 → clamps at MAX_WIDTH=90, MAX_HEIGHT=70
    expect(run({ sizeTier: 'auto', overrides: {} }, 100)).toEqual({ width: MAX_WIDTH, height: MAX_HEIGHT });
  });

  it('overrides.dimensions short-circuits everything below it', () => {
    const cfg = {
      sizeTier: 'medium' as const,
      overrides: { dimensions: { width: 99, height: 55 } },
    };
    expect(run(cfg, 15)).toEqual({ width: 99, height: 55 });
  });

  it('extras.expandPin has highest priority (beats overrides)', () => {
    const cfg = {
      sizeTier: 'medium' as const,
      overrides: { dimensions: { width: 99, height: 55 } },
    };
    expect(run(cfg, 15, { expandPin: { width: 70, height: 52 } })).toEqual({ width: 70, height: 52 });
  });
});
