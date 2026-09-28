import { INTERIOR_GRIDS, INTERIOR_ZONES, ACTION_ZONE_REQUIREMENTS, type ZoneDef } from '../data/interiors';

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

  /**
   * `excludeAgentId` is what stops an agent from being blocked by itself. A
   * sleeper already standing in its own `bed` (maxOccupants 1) re-evaluates
   * `sleeping` every few ticks; without the exclusion the zone reads as full,
   * the decision engine finds no zone, and routes the agent to the building
   * entry_point instead — which is why agents ended up sleeping on the doorstep.
   */
  isFull(building: string, zone: string, maxOccupants: number, excludeAgentId?: number): boolean {
    const k = this.key(building, zone);
    const set = this.zones.get(k);
    if (!set) return maxOccupants <= 0;
    const count = excludeAgentId !== undefined && set.has(excludeAgentId) ? set.size - 1 : set.size;
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
// Startup reconstruction
// ---------------------------------------------------------------------------

/**
 * Re-populate the ZoneOccupancy singleton from agent positions on server start.
 * The singleton is in-memory only, so a restart loses zone tracking. Each active
 * agent is mapped to the closest zone center within their current building (if
 * within 1.5 tiles). Home buildings (no zone grid) are skipped.
 */
export function reconstructZoneOccupancy(
  activeAgents: Array<{
    id: number;
    current_location: number | null;
    position: { x: number; y: number };
  }>,
  allLocations: Array<{
    id: number;
    type: string;
    position: { x: number; y: number; width: number; height: number };
  }>,
): void {
  const TILE_SIZE = 32;
  const MAX_SNAP_DISTANCE = 48; // 1.5 tiles

  zoneOccupancy.clear();

  const locIndex = new Map<number, { type: string; position: { x: number; y: number; width: number; height: number } }>();
  for (const loc of allLocations) {
    locIndex.set(loc.id, { type: loc.type, position: loc.position });
  }

  for (const agent of activeAgents) {
    if (agent.current_location == null) continue;
    const loc = locIndex.get(agent.current_location);
    if (!loc) continue;
    const zones = INTERIOR_ZONES[loc.type] as ZoneDef[] | undefined;
    if (!zones || zones.length === 0) continue;

    // Find the closest zone center
    let bestZone: ZoneDef | null = null;
    let bestDist = Infinity;
    for (const zone of zones) {
      const [cx, cy] = zone.center;
      const worldCx = loc.position.x + cx * TILE_SIZE + TILE_SIZE / 2;
      const worldCy = loc.position.y + cy * TILE_SIZE + TILE_SIZE / 2;
      const dx = agent.position.x - worldCx;
      const dy = agent.position.y - worldCy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestZone = zone;
      }
    }

    if (bestZone && bestDist <= MAX_SNAP_DISTANCE) {
      zoneOccupancy.enter(agent.id, occupancyKey(loc.type, agent.current_location), bestZone.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Zone capacity helpers
// ---------------------------------------------------------------------------

/**
 * Fallback zone map: when a primary zone is full, try these alternates.
 * Key format: "buildingType:zoneId"
 */
/**
 * Decision-engine action names -> the verb used in `ZoneDef.allowedActions`.
 * The two vocabularies drifted apart (gerund vs infinitive), which silently made
 * every `socializing` lookup — and the second sleeper in a home — resolve to no zone.
 */
const ACTION_ZONE_ALIASES: Record<string, string> = {
  socializing: 'socialize',
  sleeping: 'sleep',
  eating: 'eat',
  working: 'work',
  shopping: 'buy',
};

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
  locationId?: number,
  requesterId?: number,
): ZoneDef | null {
  const zones = INTERIOR_ZONES[buildingType] as ZoneDef[] | undefined;
  if (!zones || zones.length === 0) return null;

  // Occupancy is tracked per building INSTANCE when a location id is provided,
  // so two different homes never share the same "bed" bucket. Falls back to
  // type-level keys for callers that don't know the instance.
  const occKey = occupancyKey(buildingType, locationId);

  // Check ACTION_ZONE_REQUIREMENTS first for non-interaction actions
  const requirements = ACTION_ZONE_REQUIREMENTS[actionType];
  if (requirements) {
    const allowedZoneIds = requirements[buildingType];
    if (allowedZoneIds) {
      for (const zoneId of allowedZoneIds) {
        const zone = zones.find(z => z.id === zoneId);
        if (zone && !zoneOccupancy.isFull(occKey, zone.id, zone.maxOccupants, requesterId)) {
          return zone;
        }
      }
    }
  }

  // Zones that support the requested action. Zone data uses infinitive verbs
  // ('socialize', 'eat', 'sleep', 'work') while the decision engine speaks in
  // gerunds, so the two vocabularies have to be reconciled or nothing ever matches.
  const alias = ACTION_ZONE_ALIASES[actionType];
  const matching = zones.filter(
    z => z.allowedActions.includes(actionType) || (alias !== undefined && z.allowedActions.includes(alias)),
  );
  if (matching.length === 0) return null;

  // Try primary matches first (prefer non-full zones)
  for (const zone of matching) {
    if (!zoneOccupancy.isFull(occKey, zone.id, zone.maxOccupants, requesterId)) {
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
          !zoneOccupancy.isFull(occKey, fallbackZone.id, fallbackZone.maxOccupants, requesterId)
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
 * Build the occupancy bucket key for a building. Per-instance when a location
 * id is known ("home#12"), per-type otherwise ("home").
 */
export function occupancyKey(buildingType: string, locationId?: number | null): string {
  return locationId != null ? `${buildingType}#${locationId}` : buildingType;
}

/**
 * Deterministic sub-tile offset from a zone center, so the occupants of a
 * multi-occupant zone (tavern tables seat 4, the plaza 10) do not all land on
 * the single pixel that is the zone center and render as one sprite.
 *
 * Kept under half a tile: the offset never leaves the zone's own tile, so it
 * cannot push an agent through a wall or out of the zone it was assigned.
 */
export function zoneSlotOffset(agentId: number): { dx: number; dy: number } {
  const h = Math.imul(agentId, 2654435761) >>> 0;
  return {
    dx: ((h % 3) - 1) * 9,
    dy: ((Math.floor(h / 3) % 3) - 1) * 9,
  };
}

/**
 * A walkable interior tile to stand on when no zone matched the action.
 *
 * Without this the decision engine leaves the agent on the building's
 * `entry_point`, which sits one tile *outside* the south wall — so every action
 * with no zone mapping ('idle' in a shop, 'resting' anywhere) rendered as an
 * agent loitering on the doorstep, outside the building they are supposedly in.
 *
 * Picks a floor tile (never the door tile itself, so the doorway stays clear),
 * spread deterministically by agent id so a crowd does not pile onto one tile.
 * Returns null for open areas, which have no grid and no doorway to block.
 */
export function fallbackInteriorTile(
  buildingType: string,
  agentId: number,
): [number, number] | null {
  const info = getInteriorGrid(buildingType);
  if (!info) return null;
  const floors: [number, number][] = [];
  for (let row = 0; row < info.height; row++) {
    for (let col = 0; col < info.width; col++) {
      if (info.raw[row][col] === 0) floors.push([col, row]);
    }
  }
  if (floors.length === 0) return info.doorTile;
  return floors[(Math.imul(agentId, 2654435761) >>> 0) % floors.length];
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
