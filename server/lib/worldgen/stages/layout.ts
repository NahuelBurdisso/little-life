import {
  getTemplatesForAgentCount,
  templateToLocationSeed,
  type BuildingTemplate,
} from '../buildingTemplates';
import { FitError, type Stage, type Zone } from '../types';
import type { LocationSeed } from '../types';
// RNG type used implicitly via stage interface
import { TILE } from '../config';
const BUILDING_GAP = 2;
const ROAD_BUFFER = 1;
const BORDER_BUFFER = 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Set<string> of "x,y" keys for O(1) lookup. */
function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Build the blocked mask: border + road tiles + road buffer. */
function buildBlockedMask(
  width: number,
  height: number,
  roadTiles: Array<{ x: number; y: number }>,
): Set<string> {
  const blocked = new Set<string>();

  // Border frame (BORDER_BUFFER tiles from each edge)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (
        x < BORDER_BUFFER ||
        x >= width - BORDER_BUFFER ||
        y < BORDER_BUFFER ||
        y >= height - BORDER_BUFFER
      ) {
        blocked.add(tileKey(x, y));
      }
    }
  }

  // Road tiles + ROAD_BUFFER around them
  for (const t of roadTiles) {
    for (let dy = -ROAD_BUFFER; dy <= ROAD_BUFFER; dy++) {
      for (let dx = -ROAD_BUFFER; dx <= ROAD_BUFFER; dx++) {
        blocked.add(tileKey(t.x + dx, t.y + dy));
      }
    }
  }

  return blocked;
}

/** Check if a building footprint at (sx, sy) with size (w, h) fits without
 *  hitting any blocked tile. */
function fits(
  sx: number,
  sy: number,
  w: number,
  h: number,
  blocked: Set<string>,
): boolean {
  for (let y = sy; y < sy + h; y++) {
    for (let x = sx; x < sx + w; x++) {
      if (blocked.has(tileKey(x, y))) return false;
    }
  }
  return true;
}

/** Mark a building footprint + BUILDING_GAP buffer as blocked. */
function markPlaced(
  sx: number,
  sy: number,
  w: number,
  h: number,
  blocked: Set<string>,
): void {
  for (let y = sy - BUILDING_GAP; y < sy + h + BUILDING_GAP; y++) {
    for (let x = sx - BUILDING_GAP; x < sx + w + BUILDING_GAP; x++) {
      blocked.add(tileKey(x, y));
    }
  }
}

/** Score a template against a zone. */
function scoreZone(
  template: BuildingTemplate,
  zone: Zone,
  usedAreaByZone: Map<string, number>,
): number {
  const zoneArea =
    (zone.bounds.x2 - zone.bounds.x1 + 1) *
    (zone.bounds.y2 - zone.bounds.y1 + 1);
  const used = usedAreaByZone.get(zone.id) ?? 0;
  const remainingFraction = Math.max(0, 1 - used / zoneArea);

  let score = 0;
  for (const [key, weight] of Object.entries(template.zoneWeights)) {
    score += weight * (zone.affinity[key] ?? 0);
  }
  return score * remainingFraction;
}

/** Generate grid-snap candidate slots within a zone for a building. */
function generateSlots(
  zone: Zone,
  w: number,
  h: number,
): Array<{ x: number; y: number }> {
  const slots: Array<{ x: number; y: number }> = [];
  const { x1, y1, x2, y2 } = zone.bounds;
  const spacingX = w + BUILDING_GAP;
  const spacingY = h + BUILDING_GAP;

  for (let sy = y1 + 2; sy + h <= y2 - 1; sy += spacingY) {
    for (let sx = x1 + 2; sx + w <= x2 - 1; sx += spacingX) {
      slots.push({ x: sx, y: sy });
    }
  }
  return slots;
}

// ─── Outdoor location derivation ──────────────────────────────────────────────

function deriveMainstreet(
  roadTiles: Array<{ x: number; y: number }>,
): LocationSeed | null {
  if (roadTiles.length === 0) return null;

  // Find the main street row: the y value that appears most in road tiles.
  // Main street is horizontal, so group by y.
  const yCount = new Map<number, number>();
  for (const t of roadTiles) {
    yCount.set(t.y, (yCount.get(t.y) ?? 0) + 1);
  }
  // Pick the y with most tiles (main street spans full width)
  let bestY = roadTiles[0].y;
  let bestCount = 0;
  for (const [y, count] of yCount) {
    if (count > bestCount) {
      bestCount = count;
      bestY = y;
    }
  }

  // Find x range for this y
  let minX = Infinity;
  let maxX = -Infinity;
  for (const t of roadTiles) {
    if (t.y === bestY) {
      if (t.x < minX) minX = t.x;
      if (t.x > maxX) maxX = t.x;
    }
  }

  const midX = Math.floor((minX + maxX) / 2);
  const streetLen = maxX - minX + 1;

  return {
    name: 'Main Street',
    type: 'mainstreet',
    position: {
      x: minX * TILE,
      y: bestY * TILE,
      width: streetLen * TILE,
      height: 2 * TILE,
    },
    entry_point: { x: midX * TILE, y: bestY * TILE },
    capacity: Math.max(20, streetLen),
    current_occupants: [],
    operating_hours: null,
    services: [],
    description:
      'The main thoroughfare through town, where most commerce and socializing happens.',
    owner: null,
  };
}

function deriveMarketSquare(
  placedBuildings: Array<{ type: string; tileX: number; tileY: number; w: number; h: number }>,
  blocked: Set<string>,
): LocationSeed | null {
  const townSquare = placedBuildings.find((b) => b.type === 'town_square');
  if (!townSquare) return null;

  // Look for open 4x4 area south of the town square
  const startY = townSquare.tileY + townSquare.h + 1;
  const startX = townSquare.tileX;
  const minW = 4;
  const minH = 4;

  for (let y = startY; y < startY + 5; y++) {
    for (let x = startX; x < startX + townSquare.w; x++) {
      if (fits(x, y, minW, minH, blocked)) {
        return {
          name: 'Market Square',
          type: 'market_square',
          position: {
            x: x * TILE,
            y: y * TILE,
            width: minW * TILE,
            height: minH * TILE,
          },
          entry_point: { x: (x + minW / 2) * TILE, y: (y + minH) * TILE },
          capacity: 15,
          current_occupants: [],
          operating_hours: null,
          services: [],
          description:
            'An open square south of the town center, where vendors and performers gather.',
          owner: null,
        };
      }
    }
  }
  return null;
}

function deriveAlley(
  placedBuildings: Array<{ type: string; tileX: number; tileY: number; w: number; h: number }>,
): LocationSeed | null {
  const commercialTypes = ['shop', 'tavern', 'bakery', 'pawnshop', 'divebar'];
  const commercial = placedBuildings.filter((b) =>
    commercialTypes.includes(b.type),
  );

  for (let i = 0; i < commercial.length; i++) {
    for (let j = i + 1; j < commercial.length; j++) {
      const a = commercial[i];
      const b = commercial[j];
      // Check horizontal gap
      const gapX = Math.max(0, Math.max(b.tileX - (a.tileX + a.w), a.tileX - (b.tileX + b.w)));
      const gapY = Math.max(0, Math.max(b.tileY - (a.tileY + a.h), a.tileY - (b.tileY + b.h)));

      // Adjacent buildings with small gap
      if (gapX <= 3 && gapX > 0 && gapY === 0) {
        const alleyX = Math.min(a.tileX + a.w, b.tileX + b.w);
        const alleyY = Math.max(a.tileY, b.tileY);
        const alleyH = Math.min(a.tileY + a.h, b.tileY + b.h) - alleyY;
        if (alleyH >= 2) {
          return {
            name: 'Back Alley',
            type: 'alley',
            position: {
              x: alleyX * TILE,
              y: alleyY * TILE,
              width: gapX * TILE,
              height: alleyH * TILE,
            },
            entry_point: {
              x: (alleyX + Math.floor(gapX / 2)) * TILE,
              y: (alleyY + alleyH) * TILE,
            },
            capacity: 4,
            current_occupants: [],
            operating_hours: null,
            services: [],
            description:
              'A narrow alley between two commercial buildings, dimly lit and discreet.',
            owner: null,
          };
        }
      }
      if (gapY <= 3 && gapY > 0 && gapX === 0) {
        const alleyX = Math.max(a.tileX, b.tileX);
        const alleyY = Math.min(a.tileY + a.h, b.tileY + b.h);
        const alleyW = Math.min(a.tileX + a.w, b.tileX + b.w) - alleyX;
        if (alleyW >= 2) {
          return {
            name: 'Back Alley',
            type: 'alley',
            position: {
              x: alleyX * TILE,
              y: alleyY * TILE,
              width: alleyW * TILE,
              height: gapY * TILE,
            },
            entry_point: {
              x: (alleyX + Math.floor(alleyW / 2)) * TILE,
              y: (alleyY + gapY) * TILE,
            },
            capacity: 4,
            current_occupants: [],
            operating_hours: null,
            services: [],
            description:
              'A narrow alley between two commercial buildings, dimly lit and discreet.',
            owner: null,
          };
        }
      }
    }
  }
  return null;
}

function deriveFarmyard(
  placedBuildings: Array<{ type: string; tileX: number; tileY: number; w: number; h: number }>,
  blocked: Set<string>,
): LocationSeed | null {
  const farm = placedBuildings.find((b) => b.type === 'farm');
  if (!farm) return null;

  const minW = 3;
  const minH = 3;

  // Try east first, then south
  const candidates = [
    { x: farm.tileX + farm.w + 1, y: farm.tileY },
    { x: farm.tileX, y: farm.tileY + farm.h + 1 },
  ];

  for (const c of candidates) {
    if (fits(c.x, c.y, minW, minH, blocked)) {
      return {
        name: 'Farmyard',
        type: 'farmyard',
        position: {
          x: c.x * TILE,
          y: c.y * TILE,
          width: minW * TILE,
          height: minH * TILE,
        },
        entry_point: {
          x: (c.x + Math.floor(minW / 2)) * TILE,
          y: (c.y + minH) * TILE,
        },
        capacity: 6,
        current_occupants: [],
        operating_hours: null,
        services: [],
        description:
          'An open yard beside the farm, where chickens scratch and tools lean against the fence.',
        owner: null,
      };
    }
  }
  return null;
}

// ─── Stage ────────────────────────────────────────────────────────────────────

export const layoutStage: Stage<{ publicBuildings: LocationSeed[] }> = {
  name: 'layout',
  dependsOn: ['dimensions', 'roads'],
  run(ctx, rng, _cfg, agentCount) {
    if (!ctx.dimensions) throw new Error('layout: dimensions not populated');
    if (!ctx.roads) throw new Error('layout: roads not populated');

    const { width, height } = ctx.dimensions;
    const { tiles: roadTiles, zones } = ctx.roads;

    // 1. Select templates
    const templates = getTemplatesForAgentCount(agentCount);

    // 2. Build blocked mask
    const blocked = buildBlockedMask(width, height, roadTiles);

    // 3. Sort templates largest-first by footprint area
    const sorted = [...templates].sort(
      (a, b) => b.size.w * b.size.h - a.size.w * a.size.h,
    );

    // Track used area per zone for remaining-area scoring
    const usedAreaByZone = new Map<string, number>();

    // Track placed buildings for outdoor derivation
    const placedBuildings: Array<{
      type: string;
      tileX: number;
      tileY: number;
      w: number;
      h: number;
    }> = [];
    const locationSeeds: LocationSeed[] = [];

    // 4. Place each template
    for (const template of sorted) {
      const { w, h } = template.size;

      // a. Score each zone
      const scoredZones = zones.map((z) => ({
        zone: z,
        score: scoreZone(template, z, usedAreaByZone),
      }));

      // b. Stable shuffle then sort by score desc (RNG breaks ties)
      const shuffled = rng.shuffle(scoredZones);
      shuffled.sort((a, b) => b.score - a.score);

      let placed = false;

      // c. Try each zone in score order
      for (const { zone } of shuffled) {
        const slots = generateSlots(zone, w, h);
        if (slots.length === 0) continue;

        const shuffledSlots = rng.shuffle(slots);

        for (const slot of shuffledSlots) {
          if (fits(slot.x, slot.y, w, h, blocked)) {
            // Place!
            markPlaced(slot.x, slot.y, w, h, blocked);

            // Update used area
            const prev = usedAreaByZone.get(zone.id) ?? 0;
            usedAreaByZone.set(zone.id, prev + w * h);

            // Convert to LocationSeed
            locationSeeds.push(
              templateToLocationSeed(template, slot.x, slot.y),
            );

            placedBuildings.push({
              type: template.type,
              tileX: slot.x,
              tileY: slot.y,
              w,
              h,
            });

            placed = true;
            break;
          }
        }

        if (placed) break;
      }

      if (!placed) {
        throw new FitError(
          'layout',
          `cannot place ${template.name} (${w}×${h}) — no space in any zone`,
        );
      }
    }

    // 5. Derive outdoor locations
    const mainstreet = deriveMainstreet(roadTiles);
    if (mainstreet) locationSeeds.push(mainstreet);

    const marketSquare = deriveMarketSquare(placedBuildings, blocked);
    if (marketSquare) locationSeeds.push(marketSquare);

    const alley = deriveAlley(placedBuildings);
    if (alley) locationSeeds.push(alley);

    const farmyard = deriveFarmyard(placedBuildings, blocked);
    if (farmyard) locationSeeds.push(farmyard);

    return { publicBuildings: locationSeeds };
  },
};
