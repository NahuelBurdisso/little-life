/**
 * A* pathfinding on a tile grid.
 * Grid is small (40x30 tiles), so performance is not a concern.
 */

export function pixelToTile(
  x: number,
  y: number,
  tileSize: number
): [number, number] {
  return [Math.floor(x / tileSize), Math.floor(y / tileSize)];
}

export function tileCenterToPixel(
  tileX: number,
  tileY: number,
  tileSize: number
): [number, number] {
  return [tileX * tileSize + tileSize / 2, tileY * tileSize + tileSize / 2];
}

interface AStarNode {
  x: number;
  y: number;
  g: number; // cost from start
  h: number; // heuristic to end
  f: number; // g + h
  parent: AStarNode | null;
}

// `computeAStarPath` runs several times per agent per tick, so an agent walled
// off in the world emits its warning on every one of those calls, forever.
// Collapse the flood into one line per interval plus a suppressed count.
const WARN_INTERVAL_MS = 10_000;

/**
 * Throttle state per warning kind. A single shared counter meant a burst of
 * "unroutable destination" warnings was reported as suppressed on the next
 * "cost map size" line — and was never reported at all if that kind stopped
 * firing. The key set is closed: exactly the three WarnKind values below.
 */
type WarnKind = 'cost-map-size' | 'unroutable-destination' | 'no-route';

const warnState = new Map<WarnKind, { lastWarnAt: number; suppressed: number }>();

function warnThrottled(kind: WarnKind, message: string): void {
  const now = Date.now();
  let state = warnState.get(kind);
  if (!state) {
    state = { lastWarnAt: 0, suppressed: 0 };
    warnState.set(kind, state);
  }
  if (now - state.lastWarnAt < WARN_INTERVAL_MS) {
    state.suppressed++;
    return;
  }
  const suffix = state.suppressed > 0 ? ` (+${state.suppressed} suppressed)` : '';
  state.lastWarnAt = now;
  state.suppressed = 0;
  console.warn(message + suffix);
}

/**
 * One straight-line fallback, reported to the observer below. The warnings are
 * throttled to one line per 10 s, which hides the rate — and the rate is the
 * whole question (P1: "~20 a game day" vs "278 in a playtest"). The soak report
 * tallies these by reason and destination; tests assert on them directly.
 */
export interface PathFallback {
  kind: 'unroutable-destination' | 'no-route';
  /** Tile coords on the grid that was searched. */
  start: [number, number];
  end: [number, number];
  gridWidth: number;
  gridHeight: number;
  /** Which grid: 'world', or the building type for an interior grid. */
  context: string;
}

let fallbackObserver: ((f: PathFallback) => void) | null = null;

/** Observe every straight-line fallback (null to stop). One observer at a time. */
export function setPathFallbackObserver(fn: ((f: PathFallback) => void) | null): void {
  fallbackObserver = fn;
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (1.414 - 1) * Math.min(dx, dy);
}

const DIRECTIONS: [number, number, number][] = [
  [0, -1, 1],      // up
  [0, 1, 1],       // down
  [-1, 0, 1],      // left
  [1, 0, 1],       // right
  [-1, -1, 1.414], // up-left
  [1, -1, 1.414],  // up-right
  [-1, 1, 1.414],  // down-left
  [1, 1, 1.414],   // down-right
];

export function computeAStarPath(
  startPixel: { x: number; y: number },
  endPixel: { x: number; y: number },
  collisionGrid: string,
  mapWidth: number,
  mapHeight: number,
  tileSize: number,
  costMap?: Float32Array,
  context = 'world',
): number[][] {
  // A cost map sized for a different world reads `undefined` past its end, and
  // `undefined === Infinity` is false — so the unroutable guard below passed and
  // `getTileCost` fed `undefined` into `g + cost`, giving NaN scores and silently
  // corrupt routes. Reject the whole map rather than trusting it per-tile.
  let grid: Float32Array | undefined = costMap;
  if (grid && grid.length !== mapWidth * mapHeight) {
    warnThrottled(
      'cost-map-size',
      `[pathfinding] cost map has ${grid.length} entries but the map is ` +
      `${mapWidth}x${mapHeight} (${mapWidth * mapHeight}) — ignoring terrain costs`,
    );
    grid = undefined;
  }

  const [sx, sy] = pixelToTile(startPixel.x, startPixel.y, tileSize);
  const [ex, ey] = pixelToTile(endPixel.x, endPixel.y, tileSize);

  // Clamp to map bounds
  const startX = Math.max(0, Math.min(sx, mapWidth - 1));
  const startY = Math.max(0, Math.min(sy, mapHeight - 1));
  const endX = Math.max(0, Math.min(ex, mapWidth - 1));
  const endY = Math.max(0, Math.min(ey, mapHeight - 1));

  // If start === end, just return the exact end pixel
  if (startX === endX && startY === endY) {
    return [[endPixel.x, endPixel.y]];
  }

  // Unroutable destination — straight line, which walks through walls. Kept as a
  // fallback rather than an error because callers have no recovery path, but it
  // is logged: this used to be completely silent, so a blocked or
  // infinite-cost entry point looked like a working route.
  // `Infinity` is checked too — `getTileCost` skips those tiles, so the open set
  // just drains and execution reaches the identical fallback at the end of the
  // function, indistinguishable from a real path.
  const endCost = grid ? grid[endY * mapWidth + endX] : 1;
  if (collisionGrid[endY * mapWidth + endX] === "1" || !Number.isFinite(endCost)) {
    warnThrottled(
      'unroutable-destination',
      `[pathfinding] destination tile (${endX},${endY}) is unroutable ` +
      `(blocked=${collisionGrid[endY * mapWidth + endX] === '1'}, cost=${endCost}) — ` +
      `falling back to a straight line through obstacles`,
    );
    fallbackObserver?.({
      kind: 'unroutable-destination', start: [startX, startY], end: [endX, endY],
      gridWidth: mapWidth, gridHeight: mapHeight, context,
    });
    return [
      [startPixel.x, startPixel.y],
      [endPixel.x, endPixel.y],
    ];
  }

  function isBlocked(x: number, y: number): boolean {
    if (x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) return true;
    return collisionGrid[y * mapWidth + x] === "1";
  }

  function getTileCost(x: number, y: number): number {
    if (x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) return Infinity;
    if (collisionGrid[y * mapWidth + x] === '1') return Infinity;
    if (!grid) return 1.0;
    const cost = grid[y * mapWidth + x];
    // Never let a non-finite cost reach `g + cost * tileCost`.
    return Number.isFinite(cost) ? cost : Infinity;
  }

  // A* search
  const openSet: AStarNode[] = [];
  const closedSet = new Set<string>();

  const key = (x: number, y: number) => `${x},${y}`;

  const startNode: AStarNode = {
    x: startX,
    y: startY,
    g: 0,
    h: heuristic(startX, startY, endX, endY),
    f: heuristic(startX, startY, endX, endY),
    parent: null,
  };
  openSet.push(startNode);

  // Track best g-score per tile for faster lookups
  const bestG = new Map<string, number>();
  bestG.set(key(startX, startY), 0);

  while (openSet.length > 0) {
    // Find node with lowest f score
    let lowestIdx = 0;
    for (let i = 1; i < openSet.length; i++) {
      if (
        openSet[i].f < openSet[lowestIdx].f ||
        (openSet[i].f === openSet[lowestIdx].f &&
          openSet[i].h < openSet[lowestIdx].h)
      ) {
        lowestIdx = i;
      }
    }
    const current = openSet[lowestIdx];
    openSet.splice(lowestIdx, 1);

    // Reached the goal
    if (current.x === endX && current.y === endY) {
      return reconstructPath(current, tileSize, endPixel);
    }

    const ck = key(current.x, current.y);
    if (closedSet.has(ck)) continue;
    closedSet.add(ck);

    for (const [dx, dy, cost] of DIRECTIONS) {
      const nx = current.x + dx;
      const ny = current.y + dy;

      const tileCost = getTileCost(nx, ny);
      if (tileCost === Infinity) continue;

      // Diagonal constraint: both adjacent orthogonal tiles must be free
      const isDiagonal = dx !== 0 && dy !== 0;
      if (isDiagonal) {
        if (isBlocked(current.x + dx, current.y)) continue;
        if (isBlocked(current.x, current.y + dy)) continue;
      }

      const nk = key(nx, ny);
      if (closedSet.has(nk)) continue;

      const tentativeG = current.g + cost * tileCost;
      const existingG = bestG.get(nk);

      if (existingG !== undefined && tentativeG >= existingG) continue;

      bestG.set(nk, tentativeG);

      const h = heuristic(nx, ny, endX, endY);
      openSet.push({
        x: nx,
        y: ny,
        g: tentativeG,
        h,
        f: tentativeG + h,
        parent: current,
      });
    }
  }

  // Open set exhausted: the destination is walkable but unreachable (walled off).
  // Same straight-line fallback, same reason it is logged.
  warnThrottled(
    'no-route',
    `[pathfinding] no route from (${startX},${startY}) to (${endX},${endY}) — ` +
    `falling back to a straight line through obstacles`,
  );
  fallbackObserver?.({
    kind: 'no-route', start: [startX, startY], end: [endX, endY],
    gridWidth: mapWidth, gridHeight: mapHeight, context,
  });
  return [
    [startPixel.x, startPixel.y],
    [endPixel.x, endPixel.y],
  ];
}

function reconstructPath(
  node: AStarNode,
  tileSize: number,
  endPixel: { x: number; y: number },
): number[][] {
  const tilePath: AStarNode[] = [];
  let current: AStarNode | null = node;

  while (current !== null) {
    tilePath.push(current);
    current = current.parent;
  }

  tilePath.reverse();

  // Convert to pixel waypoints, skipping the start tile (agent is already there).
  // Intermediate waypoints use tile centers for smooth movement.
  // The last waypoint uses the exact destination pixel so agents arrive precisely.
  const waypoints: number[][] = [];
  for (let i = 1; i < tilePath.length; i++) {
    if (i === tilePath.length - 1) {
      // Last waypoint: use exact destination, not tile center
      waypoints.push([endPixel.x, endPixel.y]);
    } else {
      const [px, py] = tileCenterToPixel(tilePath[i].x, tilePath[i].y, tileSize);
      waypoints.push([px, py]);
    }
  }

  return waypoints;
}
