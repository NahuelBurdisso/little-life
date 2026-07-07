import { describe, it, expect } from 'vitest';
import { generateWorld } from '../pipeline';
import { MIN_WIDTH, MIN_HEIGHT } from '../config';
import type { WorldGenConfig } from '../config';

const CFG_AUTO: WorldGenConfig = { sizeTier: 'auto', overrides: {} };

describe('generateWorld', () => {
  it('produces a GenResult with all fields populated', () => {
    const r = generateWorld({ ...CFG_AUTO, seed: 'hello' }, 10);
    expect(r.seed).toBe('hello');
    expect(r.dimensions.width).toBeGreaterThanOrEqual(MIN_WIDTH);
    expect(r.dimensions.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(r.locations.length).toBeGreaterThan(0);
    expect(typeof r.collisionGrid).toBe('string');
    expect(r.collisionGrid.length).toBe(r.dimensions.width * r.dimensions.height);
  });

  it('same seed → identical locations', () => {
    const a = generateWorld({ ...CFG_AUTO, seed: 'repeat' }, 13);
    const b = generateWorld({ ...CFG_AUTO, seed: 'repeat' }, 13);
    expect(a.locations.map((l) => ({ name: l.name, pos: l.position, ep: l.entry_point })))
      .toEqual(b.locations.map((l) => ({ name: l.name, pos: l.position, ep: l.entry_point })));
  });

  it('generates a random seed when none provided, returns it', () => {
    const r = generateWorld({ sizeTier: 'auto', overrides: {} }, 10);
    expect(r.seed).toMatch(/^[0-9A-Za-z]{8}$/);
  });

  it('auto-expands dimensions on FitError and retries', () => {
    // Use minimum dimensions, then request many agents so homes can't fit.
    const r = generateWorld({ sizeTier: 'auto', overrides: {} }, 40);
    expect(r.dimensions.width).toBeGreaterThanOrEqual(MIN_WIDTH);
  });

  it('aborts on FitError when custom tier is too small', () => {
    // Custom tier bypasses auto-expand (spec §4.3). The FitError from the
    // homes stage propagates unchanged rather than becoming "cap reached".
    expect(() => generateWorld(
      { sizeTier: 'custom', customDimensions: { width: MIN_WIDTH, height: MIN_HEIGHT }, overrides: {} },
      80, // too many agents for minimum map
    )).toThrowError(/\[homes\] not enough spots/);
  });

  it('does not leak expandPin into cfg.overrides after return', () => {
    const cfg = { ...CFG_AUTO, seed: 'leak-test' };
    const before = JSON.stringify(cfg);
    generateWorld(cfg, 40);
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it('passes opts.agents through to the homes stage', () => {
    // Agent references Home 10 — home count must grow to 10 even though halfAgents=1.
    const r = generateWorld(
      { ...CFG_AUTO, seed: 'agents-test' },
      2,
      { agents: [{ homeName: 'Home 10' }] },
    );
    const homes = r.locations.filter((l) => l.type === 'home');
    expect(homes).toHaveLength(10);
  });

  it('collisionGrid has correct length and content', () => {
    const r = generateWorld({ ...CFG_AUTO, seed: 'grid' }, 10);
    expect(r.collisionGrid.length).toBe(r.dimensions.width * r.dimensions.height);
    expect(/^[01]+$/.test(r.collisionGrid)).toBe(true);
  });
});
