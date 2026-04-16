import { INTERIOR_GRIDS, INTERIOR_ZONES, type ZoneDef } from '../data/interiors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteriorGridInfo {
  collisionString: string;
  width: number;
  height: number;
  /** [x, y] in grid coords (col, row) */
  doorTile: [number, number];
  raw: number[][];
}

// ---------------------------------------------------------------------------
// gridToCollisionString
// Cell types 0 (floor) and 3 (door) are walkable → '0'
// Cell types 1 (wall) and 2 (furniture) are blocked → '1'
// Result is row-major flat string: row0col0, row0col1, ..., rowNcolM
// ---------------------------------------------------------------------------

export function gridToCollisionString(grid: number[][]): string {
  let result = '';
  for (const row of grid) {
    for (const cell of row) {
      result += cell === 0 || cell === 3 ? '0' : '1';
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// getInteriorGrid — with Map-based cache
// ---------------------------------------------------------------------------

const gridCache = new Map<string, InteriorGridInfo>();

export function getInteriorGrid(buildingType: string): InteriorGridInfo | null {
  if (gridCache.has(buildingType)) {
    return gridCache.get(buildingType)!;
  }

  const raw = INTERIOR_GRIDS[buildingType];
  if (!raw) {
    return null;
  }

  const height = raw.length;
  const width = raw[0].length;
  const collisionString = gridToCollisionString(raw);

  // Find the door tile (type === 3)
  let doorTile: [number, number] = [0, 0];
  outer: for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (raw[row][col] === 3) {
        doorTile = [col, row];
        break outer;
      }
    }
  }

  const info: InteriorGridInfo = { collisionString, width, height, doorTile, raw };
  gridCache.set(buildingType, info);
  return info;
}

// ---------------------------------------------------------------------------
// ZoneOccupancy
// ---------------------------------------------------------------------------

export class ZoneOccupancy {
  /** Maps "building:zone" composite key → set of agent IDs */
  private zones = new Map<string, Set<number>>();
  /** Maps agentId → { building, zone } for fast reverse lookup */
  private agentLocation = new Map<number, { building: string; zone: string }>();

  private key(building: string, zone: string): string {
    return `${building}:${zone}`;
  }

  enter(agentId: number, building: string, zone: string): void {
    // Auto-remove from previous zone if present
    const prev = this.agentLocation.get(agentId);
    if (prev) {
      const prevKey = this.key(prev.building, prev.zone);
      this.zones.get(prevKey)?.delete(agentId);
    }

    // Add to new zone
    const k = this.key(building, zone);
    if (!this.zones.has(k)) {
      this.zones.set(k, new Set());
    }
    this.zones.get(k)!.add(agentId);
    this.agentLocation.set(agentId, { building, zone });
  }

  leave(agentId: number): void {
    const loc = this.agentLocation.get(agentId);
    if (!loc) return;
    const k = this.key(loc.building, loc.zone);
    this.zones.get(k)?.delete(agentId);
    this.agentLocation.delete(agentId);
  }

  getOccupants(building: string, zone: string): number[] {
    const k = this.key(building, zone);
    const set = this.zones.get(k);
    return set ? Array.from(set) : [];
  }

  isFull(building: string, zone: string, maxOccupants: number): boolean {
    const k = this.key(building, zone);
    const count = this.zones.get(k)?.size ?? 0;
    return count >= maxOccupants;
  }

  findAgentZone(agentId: number): { building: string; zone: string } | null {
    return this.agentLocation.get(agentId) ?? null;
  }

  clear(): void {
    this.zones.clear();
    this.agentLocation.clear();
  }
}

// Singleton instance for use across the server
export const zoneOccupancy = new ZoneOccupancy();

// ---------------------------------------------------------------------------
// Zone capacity helpers
// ---------------------------------------------------------------------------

/** How many ticks an agent waits before giving up on a full zone */
export const ZONE_WAIT_TIMEOUT_TICKS = 20;

/**
 * Fallback zone map: when a primary zone is full, try these alternates.
 * Key format: "buildingType:zoneId"
 */
const ZONE_FALLBACKS: Record<string, string[]> = {
  'tavern:tables': ['bar'],          // tables full → try bar
  'tavern:booth': ['tables'],        // booth full → try tables
  'shop:shelves': ['display'],       // shelves full → try display
  'clinic:exam_room': ['patient_bed'], // exam room full → try patient bed
};

/**
 * Find the best available zone for the given action inside a building.
 * Returns the first non-full zone that allows the action, trying fallbacks
 * when all primary matches are full. Returns null when no zone is available.
 */
export function findAvailableZone(
  buildingType: string,
  actionType: string,
): ZoneDef | null {
  const zones = INTERIOR_ZONES[buildingType] as ZoneDef[] | undefined;
  if (!zones || zones.length === 0) return null;

  // Zones that support the requested action
  const matching = zones.filter(z => z.allowedActions.includes(actionType));
  if (matching.length === 0) return null;

  // Try primary matches first (prefer non-full zones)
  for (const zone of matching) {
    if (!zoneOccupancy.isFull(buildingType, zone.id, zone.maxOccupants)) {
      return zone;
    }
  }

  // All primary matches are full — try fallback zones
  for (const zone of matching) {
    const key = `${buildingType}:${zone.id}`;
    const fallbacks = ZONE_FALLBACKS[key];
    if (fallbacks) {
      for (const fallbackId of fallbacks) {
        const fallbackZone = zones.find(z => z.id === fallbackId);
        if (
          fallbackZone &&
          !zoneOccupancy.isFull(buildingType, fallbackZone.id, fallbackZone.maxOccupants)
        ) {
          return fallbackZone;
        }
      }
    }
  }

  // Everything is full
  return null;
}

/**
 * Convenience wrapper matching the (actionType, buildingType) argument order
 * used in some call sites.
 */
export function resolveZoneForAction(
  actionType: string,
  buildingType: string,
): ZoneDef | null {
  return findAvailableZone(buildingType, actionType);
}

// ---------------------------------------------------------------------------
// Terrain cost helpers for open areas
// ---------------------------------------------------------------------------

export interface TerrainCostEntry {
  tileX: number;
  tileY: number;
  cost: number; // movement cost multiplier (1.0 = normal, Infinity = blocked)
}

/**
 * Build terrain cost overrides for open area locations.
 * Returns entries that override the default 1.0 cost on the world grid.
 */
export function getOpenAreaTerrainCosts(
  season: string,
  locations: Array<{ type: string; position: { x: number; y: number; width: number; height: number } }>,
  tileSize: number,
): TerrainCostEntry[] {
  const entries: TerrainCostEntry[] = [];

  for (const loc of locations) {
    const baseTileX = Math.floor(loc.position.x / tileSize);
    const baseTileY = Math.floor(loc.position.y / tileSize);

    if (loc.type === 'park') {
      // River tiles (top-left 2x2) — always blocked
      for (const [dx, dy] of [[0,0],[1,0],[0,1],[1,1]] as [number, number][]) {
        entries.push({ tileX: baseTileX + dx, tileY: baseTileY + dy, cost: Infinity });
      }
      // Grove tiles — slight cost (bushes/trees)
      for (const [dx, dy] of [[3,0],[4,0],[5,0],[6,0],[3,1],[4,1],[5,1],[6,1]] as [number, number][]) {
        entries.push({ tileX: baseTileX + dx, tileY: baseTileY + dy, cost: 1.3 });
      }
    }

    if (loc.type === 'farm') {
      // Crop tiles — seasonal cost
      const cropCost = season === 'winter' ? 1.0 : 1.5;
      for (let dx = 0; dx < 8; dx++) {
        for (const dy of [0, 1]) {
          entries.push({ tileX: baseTileX + dx, tileY: baseTileY + dy, cost: cropCost });
        }
      }
    }
  }

  return entries;
}
