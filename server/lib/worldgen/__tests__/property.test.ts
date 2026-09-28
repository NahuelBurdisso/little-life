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

        // Location names are unique. `setup.seedWorld` keys its locationMap by
        // name and resolves each agent's home with `.find(l => l.name === ...)`,
        // so one duplicate would silently point an agent's home FK at one building
        // and its spawn position at another.
        const names = r.locations.map((l) => l.name);
        expect(new Set(names).size, `duplicate location name in ${seed}`)
          .toBe(names.length);

        // Entry points. The south-centre rule holds for every enclosed building —
        // and, as it happens, for market_square and farmyard, which are derived but
        // still emit a south door. Only mainstreet and alley put their entry inside
        // their own footprint.
        const INSIDE_OWN_FOOTPRINT = ['mainstreet', 'alley'];
        const T = 32;
        for (const b of r.locations) {
          if (INSIDE_OWN_FOOTPRINT.includes(b.type)) {
            expect(b.entry_point.x, `${b.name} entry x outside own footprint`)
              .toBeGreaterThanOrEqual(b.position.x);
            expect(b.entry_point.x).toBeLessThan(b.position.x + b.position.width);
            expect(b.entry_point.y, `${b.name} entry y outside own footprint`)
              .toBeGreaterThanOrEqual(b.position.y);
            expect(b.entry_point.y).toBeLessThan(b.position.y + b.position.height);
          } else if (b.type === 'market_square' || b.type === 'farmyard') {
            // Same south-centre rule, asserted on the tile rather than the pixel:
            // `deriveFarmyard` floors the half-width and `deriveMarketSquare` does
            // not, so on an odd-width plot one door lands on the tile boundary and
            // the other on the tile centre. Both resolve to the same tile, which is
            // all anything downstream reads.
            expect(Math.floor(b.entry_point.x / T), `${b.name} door column`)
              .toBe(b.position.x / T + Math.floor(b.position.width / T / 2));
            expect(b.entry_point.y).toBe(b.position.y + b.position.height);
          } else {
            expect(b.entry_point.x).toBe(b.position.x + b.position.width / 2);
            expect(b.entry_point.y).toBe(b.position.y + b.position.height);
          }
        }

        // Every entry tile is walkable and belongs to exactly one location.
        //
        // The derived outdoor plots used to be skipped outright, which is why a
        // stacked alley laid across a shop's doorstep survived three review rounds:
        // the door sits *outside* the shop's footprint, so the overlap check above
        // cannot see it, and nothing else looked. The renderer paints the alley over
        // the door and `findContainingLocation` resolved the ambiguity by array
        // order, so entering the shop could put an agent in the alley.
        const TILE = 32;
        const { width: gw, height: gh } = r.dimensions;
        for (const b of r.locations) {
          const ex = Math.floor(b.entry_point.x / TILE);
          const ey = Math.floor(b.entry_point.y / TILE);
          expect(ex, `${b.name} entry x off-map`).toBeGreaterThanOrEqual(0);
          expect(ex).toBeLessThan(gw);
          expect(ey, `${b.name} entry y off-map`).toBeGreaterThanOrEqual(0);
          expect(ey).toBeLessThan(gh);
          expect(r.collisionGrid[ey * gw + ex], `${b.name} entry tile is blocked`).toBe('0');

          for (const o of r.locations) {
            if (o === b || o.type === b.type && o.name === b.name) continue;
            const ox = o.position.x / TILE, oy = o.position.y / TILE;
            const ow = o.position.width / TILE, oh = o.position.height / TILE;
            const inside = ex >= ox && ex < ox + ow && ey >= oy && ey < oy + oh;
            expect(inside, `${b.name} doorway sits inside ${o.name}`).toBe(false);
          }
        }

        // Determinism: same seed → same positions
        const r2 = generateWorld({ sizeTier: 'auto', overrides: {}, seed }, n);
        expect(r.locations.map((l) => l.position)).toEqual(r2.locations.map((l) => l.position));
      }
    });
  }
});
