import type { LocationSeed } from '../types';
import { FitError, type Stage } from '../types';
import { TILE } from '../config';
const HOME_TILES = 3;           // 3×3 tile footprint
const HOME_PX = HOME_TILES * TILE;
const PUBLIC_BUFFER = 2;        // tiles of buffer around public buildings
const HOME_SPACING = 2;         // min Chebyshev distance between home footprints

/**
 * Home services — matches what getDefaultServices('home') in maps.ts returns.
 * Kept inline here so we don't depend on maps.ts internals that may change.
 */
const HOME_SERVICES = [
  { needSatisfied: 'energy', amount: 8, cost: 0, itemRequired: null as string | null },
  { needSatisfied: 'comfort', amount: 5, cost: 0, itemRequired: null as string | null },
  { needSatisfied: 'hunger', amount: 10, cost: 0, itemRequired: 'food_raw' as string | null },
];

const HOME_DESCRIPTIONS = [
  'A cozy farmhouse with a well-worn porch',
  'A warm house with flower boxes in every window',
  'A tidy house with an herb garden out back',
  'A quiet residence, always well-lit',
  'A stately house with a polished front door',
  'A cluttered but charming cottage',
  'A small apartment decorated with paintings',
  'A bohemian loft filled with instruments',
  'A spartan house with heavy curtains',
  'A bright cottage with a red roof',
  'A stone house with ivy-covered walls',
  'A modest cabin near the edge of town',
  'A cheerful yellow house with a garden',
  'A renovated barn turned cozy home',
  'A two-story house with a balcony',
];

export const homesStage: Stage<{ homes: LocationSeed[] }> = {
  name: 'homes',
  dependsOn: ['dimensions', 'roads', 'publicBuildings'],
  needsAgents: true,
  run(ctx, rng, cfg, agentCount, extras) {
    if (!ctx.dimensions || !ctx.publicBuildings) {
      throw new Error('homes: missing dimensions or publicBuildings');
    }
    const { width, height } = ctx.dimensions;

    // --- Compute homeCount (§7.4) ---
    const halfAgents = Math.ceil(agentCount / 2);
    let maxReferenced = 0;
    if (extras.agents) {
      maxReferenced = extras.agents.reduce((max, a) => {
        const match = a.homeName?.match(/Home (\d+)/);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
    }
    const homeCount = Math.max(halfAgents, maxReferenced);
    if (homeCount === 0) return { homes: [] };

    const roadTiles = ctx.roads?.tiles ?? [];

    // --- Override path ---
    if (cfg.overrides?.homePositions) {
      const pinned = cfg.overrides.homePositions;
      if (pinned.length !== homeCount) {
        throw new FitError('homes',
          `override length ${pinned.length} does not match homeCount ${homeCount}`);
      }
      // Validate each pin fits.
      const blocked = buildBlockedMask(ctx.publicBuildings, roadTiles, width, height);
      for (const p of pinned) {
        if (!pinFits(p, blocked, width, height)) {
          throw new FitError('homes',
            `pinned position at (${p.x}, ${p.y}) does not fit`);
        }
      }
      return { homes: pinned.map((p, i) => emitHome(p, i, rng)) };
    }

    // --- Normal path: enumerate candidates → shuffle → greedy pick ---
    const blocked = buildBlockedMask(ctx.publicBuildings, roadTiles, width, height);
    const candidates: Array<{ tx: number; ty: number }> = [];
    for (let ty = 1; ty + HOME_TILES <= height - 1; ty++) {
      for (let tx = 1; tx + HOME_TILES <= width - 1; tx++) {
        if (footprintClear(tx, ty, blocked, width)) {
          candidates.push({ tx, ty });
        }
      }
    }
    const shuffled = rng.shuffle(candidates);

    // Greedy select with Chebyshev spacing rule.
    const chosen: Array<{ tx: number; ty: number }> = [];
    for (const c of shuffled) {
      if (chosen.length >= homeCount) break;
      const tooClose = chosen.some((o) =>
        Math.max(Math.abs(o.tx - c.tx), Math.abs(o.ty - c.ty)) < HOME_TILES + HOME_SPACING);
      if (!tooClose) chosen.push(c);
    }

    if (chosen.length < homeCount) {
      throw new FitError('homes',
        `not enough spots for ${homeCount} homes (found ${chosen.length})`);
    }

    const homes: LocationSeed[] = chosen.map((c, i) =>
      emitHome({ x: c.tx * TILE, y: c.ty * TILE }, i, rng));
    return { homes };
  },
};

// --- Helpers ---

function buildBlockedMask(
  publicBuildings: LocationSeed[],
  roadTiles: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): boolean[] {
  const mask = new Array<boolean>(width * height).fill(false);
  // Map border (1-tile frame).
  for (let x = 0; x < width; x++) {
    mask[x] = true;
    mask[(height - 1) * width + x] = true;
  }
  for (let y = 0; y < height; y++) {
    mask[y * width] = true;
    mask[y * width + (width - 1)] = true;
  }
  // Road tiles + 1-tile buffer (consistent with building↔road spacing rule)
  for (const t of roadTiles) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = t.x + dx, ny = t.y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          mask[ny * width + nx] = true;
        }
      }
    }
  }
  // Public buildings + 2-tile buffer.
  for (const loc of publicBuildings) {
    const tx0 = Math.max(0, Math.floor(loc.position.x / TILE) - PUBLIC_BUFFER);
    const ty0 = Math.max(0, Math.floor(loc.position.y / TILE) - PUBLIC_BUFFER);
    const tx1 = Math.min(width - 1, Math.ceil((loc.position.x + loc.position.width) / TILE) + PUBLIC_BUFFER);
    const ty1 = Math.min(height - 1, Math.ceil((loc.position.y + loc.position.height) / TILE) + PUBLIC_BUFFER);
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        mask[ty * width + tx] = true;
      }
    }
  }
  return mask;
}

function footprintClear(tx: number, ty: number, blocked: boolean[], width: number): boolean {
  for (let dy = 0; dy < HOME_TILES; dy++) {
    for (let dx = 0; dx < HOME_TILES; dx++) {
      if (blocked[(ty + dy) * width + (tx + dx)]) return false;
    }
  }
  return true;
}

function pinFits(
  p: { x: number; y: number },
  blocked: boolean[],
  width: number,
  height: number,
): boolean {
  if (p.x % TILE !== 0 || p.y % TILE !== 0) return false;
  const tx = p.x / TILE, ty = p.y / TILE;
  if (tx < 1 || ty < 1 || tx + HOME_TILES > width - 1 || ty + HOME_TILES > height - 1) return false;
  return footprintClear(tx, ty, blocked, width);
}

function emitHome(
  pos: { x: number; y: number },
  idx: number,
  rng: import('../rng').RNG,
): LocationSeed {
  return {
    name: `Home ${idx + 1}`,
    type: 'home',
    position: { x: pos.x, y: pos.y, width: HOME_PX, height: HOME_PX },
    entry_point: { x: pos.x + HOME_PX / 2, y: pos.y + HOME_PX },
    capacity: 2,
    current_occupants: [],
    operating_hours: null,
    services: HOME_SERVICES.map((s) => ({ ...s })),
    description: rng.pick(HOME_DESCRIPTIONS),
    owner: null,
  };
}
