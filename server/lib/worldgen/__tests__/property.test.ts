import { describe, it, expect } from 'vitest';
import { generateWorld } from '../pipeline';
import { MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT } from '../config';

const AGENT_COUNTS = [5, 13, 30];
const SEED_COUNT = 100; // 100 × 3 = 300 runs

describe('property: generateWorld invariants', () => {
  for (const n of AGENT_COUNTS) {
    it(`produces valid output for ${SEED_COUNT} random seeds (agents=${n})`, () => {
      for (let i = 0; i < SEED_COUNT; i++) {
        const seed = `prop-${n}-${i}`;
        const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed }, n);
        expect(r.dimensions.width).toBeGreaterThanOrEqual(MIN_WIDTH);
        expect(r.dimensions.width).toBeLessThanOrEqual(MAX_WIDTH);
        expect(r.dimensions.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
        expect(r.dimensions.height).toBeLessThanOrEqual(MAX_HEIGHT);

        const homes = r.locations.filter((l) => l.type === 'home');
        // No floor; halfAgents for N=5 is 3.
        expect(homes.length).toBeGreaterThanOrEqual(Math.ceil(n / 2));

        // No overlap between any pair of locations.
        for (let a = 0; a < r.locations.length; a++) {
          for (let b = a + 1; b < r.locations.length; b++) {
            const la = r.locations[a].position, lb = r.locations[b].position;
            const overlap = la.x < lb.x + lb.width && la.x + la.width > lb.x &&
                            la.y < lb.y + lb.height && la.y + la.height > lb.y;
            expect(overlap).toBe(false);
          }
        }

        // Roads exist in result
        expect(r.roads.length).toBeGreaterThan(0);

        // All public buildings have valid entry points (south-centered)
        const publicBuildings = r.locations.filter((l) => l.type !== 'home');
        for (const b of publicBuildings) {
          // Skip outdoor locations (they have different position semantics)
          if (['market_square', 'mainstreet', 'alley', 'farmyard'].includes(b.type)) continue;
          expect(b.entry_point.x).toBe(b.position.x + b.position.width / 2);
          expect(b.entry_point.y).toBe(b.position.y + b.position.height);
        }

        // Determinism: same seed → same positions
        const r2 = generateWorld({ sizeTier: 'auto', overrides: {}, seed }, n);
        expect(r.locations.map((l) => l.position)).toEqual(r2.locations.map((l) => l.position));
      }
    });
  }
});
