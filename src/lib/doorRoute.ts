/**
 * Footpath routing from a building door to the nearest road tile.
 *
 * The renderer used to draw two straight legs (vertical then horizontal) from the door
 * to the closest road tile by Manhattan distance. In organic towns with tight blocks that
 * L regularly cut straight through a neighbouring house, so the "worn path" appeared to
 * run across a roof. This routes over the tile grid instead, never entering a blocked
 * tile, and gives up (no path at all) when there is no short clean route — a missing
 * footpath reads as "nobody walks here", a path through a wall reads as a bug.
 *
 * Pure and DOM/Pixi-free so it can be unit-tested; `TilemapRenderer.setDoorPaths` only
 * turns the resulting rects into Graphics.
 */

export interface TileXY { x: number; y: number }
export interface PxRect { x: number; y: number; w: number; h: number }
export type DoorSide = 'top' | 'bottom' | 'left' | 'right';

/** N, E, S, W — index is the direction id used for turn accounting. */
const DIRS: ReadonlyArray<readonly [number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** Integer costs (x4) so a bucket queue works: a step costs 4, a turn 1 more. The turn
 *  penalty is what stops a shortest route from staircasing when a straight one of equal
 *  length exists — footpaths should look trodden, not pixel-diagonal. */
const STEP_COST = 4;
const TURN_COST = 1;

export interface RouteOptions {
  /** Tile just outside the door. Always walkable, even if `isBlocked` says otherwise. */
  start: TileXY;
  isGoal: (x: number, y: number) => boolean;
  isBlocked: (x: number, y: number) => boolean;
  /** Longest route, in tiles beyond `start`. */
  maxSteps: number;
  /** Optional map size in tiles; tiles outside are never entered. */
  bounds?: { width: number; height: number };
}

/**
 * Cheapest 4-connected route from `start` to the nearest goal tile, as a tile list that
 * begins with `start` and ends on the goal. `null` when nothing is reachable within
 * `maxSteps` without entering a blocked tile.
 */
export function routeDoorPath(opts: RouteOptions): TileXY[] | null {
  const { start, isGoal, isBlocked, maxSteps, bounds } = opts;
  if (isGoal(start.x, start.y)) return [{ ...start }];

  // Search space is tiny (radius <= ~10), so a keyed map beats sizing an array to the world.
  interface Node { x: number; y: number; dir: number; steps: number; cost: number; prev: string | null }
  const key = (x: number, y: number, dir: number) => `${x},${y},${dir}`;
  const nodes = new Map<string, Node>();
  const buckets: string[][] = [];
  const push = (n: Node, k: string) => {
    (buckets[n.cost] ??= []).push(k);
    nodes.set(k, n);
  };

  // dir = -1 for the start so the first move never counts as a turn.
  push({ ...start, dir: -1, steps: 0, cost: 0, prev: null }, key(start.x, start.y, -1));
  const settled = new Set<string>();
  const maxCost = maxSteps * (STEP_COST + TURN_COST);

  for (let c = 0; c <= maxCost; c++) {
    const bucket = buckets[c];
    if (!bucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      const k = bucket[i];
      if (settled.has(k)) continue;
      const cur = nodes.get(k)!;
      // A later, cheaper push may have overwritten this entry's data; only act on the
      // bucket that matches the node's current cost.
      if (cur.cost !== c) continue;
      settled.add(k);

      if (cur.steps > 0 && isGoal(cur.x, cur.y)) {
        const out: TileXY[] = [];
        let n: Node | undefined = cur;
        while (n) {
          out.push({ x: n.x, y: n.y });
          n = n.prev ? nodes.get(n.prev) : undefined;
        }
        return out.reverse();
      }
      if (cur.steps >= maxSteps) continue;

      for (let d = 0; d < 4; d++) {
        const nx = cur.x + DIRS[d][0];
        const ny = cur.y + DIRS[d][1];
        if (bounds && (nx < 0 || ny < 0 || nx >= bounds.width || ny >= bounds.height)) continue;
        if (isBlocked(nx, ny)) continue;
        const cost = cur.cost + STEP_COST + (cur.dir !== -1 && cur.dir !== d ? TURN_COST : 0);
        const nk = key(nx, ny, d);
        const existing = nodes.get(nk);
        if (existing && existing.cost <= cost) continue;
        push({ x: nx, y: ny, dir: d, steps: cur.steps + 1, cost, prev: k }, nk);
      }
    }
  }
  return null;
}

/**
 * Which wall the door is on, from the door point and its building rect. Worldgen puts
 * doors on the bottom edge (`entry_point.y = y + height`); the others are handled so a
 * hand-authored or future layout still routes outward instead of into the wall.
 */
export function doorSide(
  ep: { x: number; y: number },
  pos: { x: number; y: number; width: number; height: number },
  edgeTol = 6,
): DoorSide {
  if (Math.abs(ep.y - (pos.y + pos.height)) < edgeTol) return 'bottom';
  if (Math.abs(ep.y - pos.y) < edgeTol) return 'top';
  if (Math.abs(ep.x - (pos.x + pos.width)) < edgeTol) return 'right';
  if (Math.abs(ep.x - pos.x) < edgeTol) return 'left';
  return 'bottom';
}

/** The tile just outside the door: nudge the door point 1px out of the wall, then floor. */
export function doorStartTile(
  ep: { x: number; y: number },
  side: DoorSide,
  tileSize: number,
): TileXY {
  const dx = side === 'right' ? 1 : side === 'left' ? -1 : 0;
  const dy = side === 'bottom' ? 1 : side === 'top' ? -1 : 0;
  return { x: Math.floor((ep.x + dx) / tileSize), y: Math.floor((ep.y + dy) / tileSize) };
}

/**
 * Turn a tile route into non-overlapping pixel rects: each tile contributes a centre
 * square plus an arm towards every neighbour on the route, so translucent fills never
 * stack (the old two-leg rects darkened wherever they crossed). The rect for a given
 * tile+arm is identical whichever route produced it, so the caller can dedupe across
 * doors with a plain key set.
 *
 * `door` adds the stub from the wall to the first tile: an arm on the door side of the
 * start tile, plus — when the door point is not on the tile's centre line (an even-width
 * building has its door on a tile boundary) — a strip along the wall that joins them
 * without overlapping the arm.
 */
export function pathRects(
  tiles: readonly TileXY[],
  tileSize: number,
  pathW: number,
  door?: { ep: { x: number; y: number }; side: DoorSide },
): PxRect[] {
  const rects: PxRect[] = [];
  if (tiles.length === 0) return rects;
  const half = pathW / 2;
  const armLen = (tileSize - pathW) / 2;

  /** Bit per direction (N,E,S,W) of the arms a tile needs. */
  const arms = new Map<string, number>();
  const armKey = (t: TileXY) => `${t.x},${t.y}`;
  const addArm = (t: TileXY, d: number) => arms.set(armKey(t), (arms.get(armKey(t)) ?? 0) | (1 << d));
  const dirOf = (a: TileXY, b: TileXY) => DIRS.findIndex(([dx, dy]) => a.x + dx === b.x && a.y + dy === b.y);

  for (let i = 0; i + 1 < tiles.length; i++) {
    const d = dirOf(tiles[i], tiles[i + 1]);
    if (d < 0) continue; // not adjacent: a caller bug, draw nothing rather than a diagonal
    addArm(tiles[i], d);
    addArm(tiles[i + 1], (d + 2) % 4);
  }
  if (door) {
    // The wall is in the opposite direction of "outward".
    const outward = door.side === 'bottom' ? 2 : door.side === 'top' ? 0 : door.side === 'right' ? 1 : 3;
    addArm(tiles[0], (outward + 2) % 4);
  }
  // A lone tile (start already on the road) still needs its centre square.
  if (!arms.has(armKey(tiles[0]))) arms.set(armKey(tiles[0]), 0);

  const seen = new Set<string>();
  for (const t of tiles) {
    const k = armKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    const mask = arms.get(k) ?? 0;
    const cx = t.x * tileSize + tileSize / 2;
    const cy = t.y * tileSize + tileSize / 2;
    rects.push({ x: cx - half, y: cy - half, w: pathW, h: pathW });
    if (mask & 1) rects.push({ x: cx - half, y: t.y * tileSize, w: pathW, h: armLen });
    if (mask & 4) rects.push({ x: cx - half, y: cy + half, w: pathW, h: armLen });
    if (mask & 2) rects.push({ x: cx + half, y: cy - half, w: armLen, h: pathW });
    if (mask & 8) rects.push({ x: t.x * tileSize, y: cy - half, w: armLen, h: pathW });
  }

  if (door) {
    const t = tiles[0];
    const cx = t.x * tileSize + tileSize / 2;
    const cy = t.y * tileSize + tileSize / 2;
    const vertical = door.side === 'top' || door.side === 'bottom';
    const off = vertical ? door.ep.x - cx : door.ep.y - cy;
    if (Math.abs(off) > half) {
      // Strip on the wall edge of the tile, from just past the arm to the door point.
      // Wall edge of the tile = the side facing the building.
      const wallEdge = door.side === 'bottom' ? t.y * tileSize
        : door.side === 'top' ? (t.y + 1) * tileSize - pathW
        : door.side === 'right' ? t.x * tileSize
        : (t.x + 1) * tileSize - pathW;
      const from = off > 0 ? (vertical ? cx : cy) + half : (vertical ? door.ep.x - half : door.ep.y - half);
      const to = off > 0 ? (vertical ? door.ep.x : door.ep.y) + half : (vertical ? cx : cy) - half;
      if (to > from) {
        rects.push(vertical
          ? { x: from, y: wallEdge, w: to - from, h: pathW }
          : { x: wallEdge, y: from, w: pathW, h: to - from });
      }
    }
  }
  return rects;
}
