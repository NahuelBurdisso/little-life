import type { LocationSeed } from '../types';
import { FitError, type Stage, type StageExtras } from '../types';
import { TILE, BORDER_BUFFER, ROAD_BUFFER, BUILDING_GAP, type WorldGenConfig } from '../config';
import { buildRoadDistance } from './roadDistance';
import { SOCIAL_WEIGHTS, assignHomeLabels, edgesToLabelPairs } from '../social';
/** Derived plots that are circulation space rather than a destination, and so
 *  are exempt from PUBLIC_BUFFER. Deliberately narrower than
 *  DERIVED_LOCATION_TYPES — see the comment in `buildBlockedMask`. */
const CIRCULATION_TYPES: ReadonlySet<string> = new Set(['mainstreet', 'alley']);
const HOME_TILES = 3;           // 3×3 tile footprint
const HOME_PX = HOME_TILES * TILE;
// Buffer around public buildings. Uses the shared BUILDING_GAP rather than a
// local copy — config.ts documents that these constants were centralised
// precisely because this file drifted from them once already.
const PUBLIC_BUFFER = BUILDING_GAP;
const HOME_SPACING = 2;         // min Chebyshev distance between home footprints

/** Beyond this many tiles from a road a lot is simply "off the street", and
 *  further away is not meaningfully worse. */
const FRONTAGE_CAP = 8;
/**
 * Weight multiplier for a lot whose door is directly on a road, tapering to 1×
 * at FRONTAGE_CAP.
 *
 * Was 4, chosen to match the residential affinity range (0-5) so neither term
 * would drown the other out. That reasoning ignored the pool: selection is an
 * exponential race over hundreds of candidates for a handful of picks, and
 * `layout` has already taken the road frontage for public buildings, so the
 * road-front lots that remain sit disproportionately in low-affinity zones and
 * the two weights partly cancel. Measured share of front doors more than 6 tiles
 * from any road at 13/20/30/32 agents: 27/27/29/30% at 4, 20/19/21/23% at 12,
 * 18/17/18/20% at 20. Past 12 the return is nearly flat while the frontage
 * weight range (1-25) grows to four times the zoning range, so 12 is where it
 * stops.
 *
 * Verified not to cost zoning: the realized distribution of homes over
 * residential affinity is unchanged to within a point at both 13 and 30 agents.
 */
const FRONTAGE_BONUS = 12;

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
    // `roads` is declared in `dependsOn` and both of its fields are load-bearing:
    // `tiles` keeps homes off the street and `zones` carries the residential
    // affinities the candidate weighting is built on. This used to read
    // `ctx.roads?.tiles ?? []` and `ctx.roads?.zones ?? []`, which turned a
    // missing dependency into a silent road-free, zone-free world — every home
    // weighted identically — instead of the error the other dependencies raise.
    if (!ctx.roads) {
      throw new Error('homes: roads not populated');
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

    const roadTiles = ctx.roads.tiles;

    // --- Override path ---
    if (cfg.overrides?.homePositions) {
      const pinned = cfg.overrides.homePositions;
      if (pinned.length !== homeCount) {
        // Plain Error, not FitError: a count mismatch is a config mistake and a
        // bigger map will never fix it. As a FitError the pipeline retried it
        // three times and reported "dimensions cap reached", discarding this
        // message entirely.
        throw new Error(
          `[homes] override length ${pinned.length} does not match homeCount ${homeCount}`);
      }
      // Validate each pin fits, marking it as it is accepted. Pins used to be
      // checked only against the border, roads and public buildings — never
      // against each other — so two identical pins both passed and produced two
      // homes stacked on the same tiles.
      const blocked = buildBlockedMask(ctx.publicBuildings, roadTiles, width, height);
      for (const p of pinned) {
        // Misalignment is a malformed input, not a spatial constraint — no map
        // size will ever make it fit, but as a FitError the pipeline retried it
        // three times and reported "dimensions cap reached" instead.
        if (p.x % TILE !== 0 || p.y % TILE !== 0) {
          throw new Error(
            `[homes] pinned position (${p.x}, ${p.y}) is not a multiple of TILE (${TILE})`);
        }
        if (!pinFits(p, blocked, width, height)) {
          throw new FitError('homes',
            `pinned position at (${p.x}, ${p.y}) does not fit`);
        }
        markPin(p, blocked, width, height);
      }
      const pinnedDescriptions = rng.shuffle(HOME_DESCRIPTIONS);
      return {
        homes: pinned.map((p, i) =>
          emitHome(p, i, pinnedDescriptions[i % pinnedDescriptions.length])),
      };
    }

    // --- Normal path: enumerate candidates → shuffle → greedy pick ---
    const blocked = buildBlockedMask(ctx.publicBuildings, roadTiles, width, height);
    const candidates: Array<{ tx: number; ty: number }> = [];
    for (let ty = BORDER_BUFFER; ty + HOME_TILES <= height - BORDER_BUFFER; ty++) {
      for (let tx = BORDER_BUFFER; tx + HOME_TILES <= width - BORDER_BUFFER; tx++) {
        if (footprintClear(tx, ty, blocked, width)) {
          candidates.push({ tx, ty });
        }
      }
    }
    // Order candidates by residential zoning, not by a flat shuffle.
    //
    // `dependsOn` has always listed 'roads', but only `roads.tiles` was ever read
    // — `roads.zones` and its `residential` affinities were ignored outright. So
    // homes were a pure free-space lottery: measured correlation of home share
    // with available free space r=0.984, with residential affinity only r=0.526
    // (itself an artifact, since free space correlates with affinity). The civic
    // core `cm`, whose residential affinity is 0, was actually *over*-represented
    // at ratio 1.14. No neighbourhoods formed, and the p90 home→food commute was
    // 43.6 tiles on an 86-tile diagonal.
    //
    // Weighted sampling without replacement via the exponential race: a candidate
    // with weight w gets key -ln(U)/w, and sorting ascending draws exactly in
    // proportion to w. Zero-affinity zones still get weight 1, so they remain
    // eligible and the FitError safety net below is preserved.
    const zones = ctx.roads.zones;
    const residentialAt = (tx: number, ty: number): number => {
      const z = zones.find(
        (z) => tx >= z.bounds.x1 && tx <= z.bounds.x2 && ty >= z.bounds.y1 && ty <= z.bounds.y2,
      );
      return z?.affinity.residential ?? 0;
    };
    // Second weight term: how close the front door lands to a road.
    //
    // Zoning alone put houses wherever the zone had room, which after `layout`
    // started claiming the street frontage for public buildings meant the middle
    // of the block — 56.8% of front doors more than 6 tiles from any road at 30
    // agents. Residential streets are the point of a street grid, so the two
    // weights multiply: a well-zoned lot on the street beats a well-zoned lot
    // behind it, and a badly-zoned lot on the street still loses to both.
    const roadDist = buildRoadDistance(width, height, roadTiles);
    const frontage = (tx: number, ty: number): number => {
      const dx = tx + 1, dy = ty + HOME_TILES;   // door tile, south-centre
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) return 1;
      const d = Math.min(roadDist[dy * width + dx], FRONTAGE_CAP);
      return 1 + FRONTAGE_BONUS * (1 - d / FRONTAGE_CAP);
    };
    const shuffled = candidates
      .map((c) => ({
        c,
        // Centre tile of the 3×3 footprint, so a home straddling a zone edge is
        // attributed to the zone it mostly sits in.
        key:
          -Math.log(1 - rng.next()) /
          ((residentialAt(c.tx + 1, c.ty + 1) + 1) * frontage(c.tx, c.ty)),
      }))
      .sort((a, b) => a.key - b.key)
      .map((e) => e.c);

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

    // Which plot is `Home k`. Selection above decides *where* the houses are;
    // this decides *who* lives in each, from the relationship graph. It draws
    // nothing from `rng`, so the description shuffle below sees the same stream
    // either way, and with no social input `plotOf` is the identity and the
    // output is exactly what it was before social placement existed.
    const plotOf = socialAssignment(chosen, cfg, extras, ctx.publicBuildings);

    // One shuffled pass over the description pool instead of an independent
    // `rng.pick` per home: with 15 descriptions and up to 16 homes, drawing with
    // replacement duplicated 26.4% of descriptions per world, so neighbouring
    // houses read identically in the inspector and in LLM prompts.
    //
    // Indexed by plot, not by label: a description is the house ("a bright
    // cottage with a red roof"), and the house stays put when a different
    // household is assigned to it. Emitted in label order so `Home 1` is still
    // first in the output.
    const descriptions = rng.shuffle(HOME_DESCRIPTIONS);
    const homes: LocationSeed[] = plotOf.map((plot, label) => {
      const c = chosen[plot];
      return emitHome({ x: c.tx * TILE, y: c.ty * TILE }, label, descriptions[plot % descriptions.length]);
    });
    return { homes };
  },
};

// --- Helpers ---

/**
 * Map each home label (index k for `Home k+1`) to one of the chosen plots so the
 * relationship graph shapes the neighbourhood — see `social.ts` for the why and
 * the weights. Returns the identity when social placement is off, when no edges
 * were supplied, or when none of them joins two *different* generated homes
 * (housemate-only or unknown-agent edges): the workplace pull alone is not a
 * reason to reshuffle a world whose caller asked for nothing social.
 *
 * The pinned-override path never reaches here — a pinned `homePositions[i]` is
 * the user saying where `Home i+1` goes.
 */
function socialAssignment(
  chosen: ReadonlyArray<{ tx: number; ty: number }>,
  cfg: WorldGenConfig,
  extras: StageExtras,
  publicBuildings: ReadonlyArray<LocationSeed>,
): number[] {
  const identity = chosen.map((_, i) => i);
  const edges = extras.social?.edges;
  if (cfg.socialPlacement === false || !edges?.length || !extras.agents) return identity;

  const n = chosen.length;
  // Same `Home (\d+)` parse the home count uses above.
  const labelOfHome = (homeName: string | undefined): number | undefined => {
    const m = homeName?.match(/Home (\d+)/);
    if (!m) return undefined;
    const k = Number(m[1]) - 1;
    return k >= 0 && k < n ? k : undefined;
  };
  const homeByAgent = new Map<string, number>();
  for (const a of extras.agents) {
    const label = labelOfHome(a.homeName);
    if (a.name !== undefined && label !== undefined && !homeByAgent.has(a.name)) {
      homeByAgent.set(a.name, label);
    }
  }
  const pairs = edgesToLabelPairs(edges, (name) => homeByAgent.get(name));
  if (pairs.length === 0) return identity;

  // Workplace pull: each resident with a workplace that exists in this world
  // adds a light tie from their home to its entry.
  const workDoor = new Map<string, { x: number; y: number }>();
  for (const b of publicBuildings) {
    workDoor.set(b.name, {
      x: Math.floor(b.entry_point.x / TILE),
      y: Math.floor(b.entry_point.y / TILE),
    });
  }
  const anchors: Array<Array<{ x: number; y: number; weight: number }>> =
    Array.from({ length: n }, () => []);
  for (const a of extras.agents) {
    const label = labelOfHome(a.homeName);
    const door = a.workplaceName ? workDoor.get(a.workplaceName) : undefined;
    if (label !== undefined && door) anchors[label].push({ ...door, weight: SOCIAL_WEIGHTS.workplace });
  }

  return assignHomeLabels({
    // Door tile, south-centre — the same tile `frontage` scores and `emitHome`
    // puts the entry on.
    plotDoors: chosen.map((c) => ({ x: c.tx + 1, y: c.ty + HOME_TILES })),
    pairs,
    anchors,
  });
}

function buildBlockedMask(
  publicBuildings: LocationSeed[],
  roadTiles: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): boolean[] {
  const mask = new Array<boolean>(width * height).fill(false);
  // Map border. This used to be a 1-tile frame while `layout.ts` reserved 2, so
  // homes — and only homes — sat one tile from the edge, which was every border
  // violation the layout audit reported.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (
        x < BORDER_BUFFER ||
        x >= width - BORDER_BUFFER ||
        y < BORDER_BUFFER ||
        y >= height - BORDER_BUFFER
      ) {
        mask[y * width + x] = true;
      }
    }
  }
  // Road tiles + ROAD_BUFFER (consistent with the building↔road spacing rule)
  for (const t of roadTiles) {
    for (let dy = -ROAD_BUFFER; dy <= ROAD_BUFFER; dy++) {
      for (let dx = -ROAD_BUFFER; dx <= ROAD_BUFFER; dx++) {
        const nx = t.x + dx, ny = t.y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          mask[ny * width + nx] = true;
        }
      }
    }
  }
  // Public buildings + 2-tile buffer.
  //
  // `mainstreet` and `alley` are exempt from the buffer (their footprint is
  // still blocked). They are circulation strips, not plots: Main Street *is* the
  // road, so charging it PUBLIC_BUFFER on top of the ROAD_BUFFER already applied
  // above pushed homes a full tile further off the street than the public
  // buildings that front onto it, across the whole width of the map — precisely
  // the tiles FRONTAGE_BONUS is trying to win. Both also put their entry_point
  // *inside* their own footprint, so there is no doorstep tile outside to keep
  // clear.
  //
  // The other two derived plots, `farmyard` and `market_square`, do NOT get the
  // exemption even though they are equally "open ground". Their entry_point sits
  // outside the footprint like an enclosed building's, so dropping the ring let
  // a home occupy that tile (`farmyard entry (52,35) is blocked`) and let home
  // doorways open into the middle of the plot.
  for (const loc of publicBuildings) {
    const buffer = CIRCULATION_TYPES.has(loc.type) ? 0 : PUBLIC_BUFFER;
    const tx0 = Math.max(0, Math.floor(loc.position.x / TILE) - buffer);
    const ty0 = Math.max(0, Math.floor(loc.position.y / TILE) - buffer);
    const tx1 = Math.min(width - 1, Math.ceil((loc.position.x + loc.position.width) / TILE) + buffer);
    const ty1 = Math.min(height - 1, Math.ceil((loc.position.y + loc.position.height) / TILE) + buffer);
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
  // Same BORDER_BUFFER reserve the unpinned scan honours — a pinned home used to
  // be allowed one tile from the edge while every generated one kept two.
  if (
    tx < BORDER_BUFFER ||
    ty < BORDER_BUFFER ||
    tx + HOME_TILES > width - BORDER_BUFFER ||
    ty + HOME_TILES > height - BORDER_BUFFER
  ) return false;
  return footprintClear(tx, ty, blocked, width);
}

/**
 * Mark an accepted pin's footprint plus a HOME_SPACING ring into `blocked`, so
 * the next pin is rejected unless it clears the same Chebyshev distance the
 * greedy unpinned selector enforces (HOME_TILES + HOME_SPACING between origins).
 */
function markPin(
  p: { x: number; y: number },
  blocked: boolean[],
  width: number,
  height: number,
): void {
  const tx = p.x / TILE, ty = p.y / TILE;
  for (let y = ty - HOME_SPACING; y < ty + HOME_TILES + HOME_SPACING; y++) {
    for (let x = tx - HOME_SPACING; x < tx + HOME_TILES + HOME_SPACING; x++) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      blocked[y * width + x] = true;
    }
  }
}

function emitHome(
  pos: { x: number; y: number },
  idx: number,
  description: string,
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
    description,
    owner: null,
  };
}
