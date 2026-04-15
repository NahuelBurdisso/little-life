import { INTERIOR_GRIDS } from '../data/interiors';

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
