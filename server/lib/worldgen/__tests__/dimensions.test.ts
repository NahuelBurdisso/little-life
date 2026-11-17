import { describe, it, expect } from 'vitest';
import { dimensionsStage } from '../stages/dimensions';
import { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT } from '../config';
import { makeRng } from '../rng';
import type { WorldContext } from '../types';

const EMPTY_CTX: WorldContext = {
  dimensions: null, terrainTiles: null, roads: null, publicBuildings: null,
  homes: null, interiors: null, names: null, warnings: null,
};
const RNG = makeRng(0);

function run(cfg: Parameters<typeof dimensionsStage.run>[2], agentCount: number, extras: Parameters<typeof dimensionsStage.run>[4] = {}) {
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
    // N=15 → 2 agents past the growth threshold of 13.
    // width:  56 + ceil(0.30 * 2) = 56 + 1 = 57
    // height: 43 + ceil(0.24 * 2) = 43 + 1 = 44
    expect(run({ sizeTier: 'auto', overrides: {} }, 15)).toEqual({ width: 57, height: 44 });
    // MAX_AGENTS is 32, the top of the range the formula is tuned for.
    expect(run({ sizeTier: 'auto', overrides: {} }, 32)).toEqual({ width: 62, height: 48 });
  });

  it('auto formula clamps at MIN for low agent counts', () => {
    // At or below the growth threshold the map is sized by MIN_WIDTH/MIN_HEIGHT,
    // which exist to keep the 3×3 zone grid non-degenerate.
    expect(run({ sizeTier: 'auto', overrides: {} }, 1)).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
    expect(run({ sizeTier: 'auto', overrides: {} }, 13)).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it('auto formula clamps at MAX for high agent counts', () => {
    // Unreachable through the wizard — MAX_AGENTS is 32, which the formula puts
    // at 62×48 — but the clamp is the only thing between a bad caller and an
    // allocation the renderer cannot handle.
    expect(run({ sizeTier: 'auto', overrides: {} }, 1000)).toEqual({ width: MAX_WIDTH, height: MAX_HEIGHT });
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
