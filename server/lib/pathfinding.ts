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
  /**
   * 'snapped-destination' is not a straight line: the destination tile was
   * blocked, so the route ends on the nearest walkable tile and only the last
   * partial step goes onto the blocked one. Reported so the rate stays visible.
   */
  kind: 'unroutable-destination' | 'no-route' | 'snapped-destination' | 'snapped-start';
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

/**
 * How far (in tiles, Chebyshev) to look for a walkable stand-in when the
 * destination tile itself is blocked. A zone point on a furniture tile or a
 * riverbank spot on the park's impassable river is always within a tile or two
 * of floor; a destination buried deeper than this is a caller bug and keeps the
 * loud straight-line fallback.
 */
const SNAP_RADIUS = 3;

/**
 * Nearest tile to (x, y), within SNAP_RADIUS, that is walkable with a finite
 * cost. Ties go to the closer tile by Euclidean distance, then scan order, so
 * the choice is deterministic.
 */
function nearestRoutableTile(
  x: number, y: number,
  collisionGrid: string, mapWidth: number, mapHeight: number,
  costs: Float32Array | undefined,
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let r = 1; r <= SNAP_RADIUS && !best; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= mapWidth || ny >= mapHeight) continue;
        const i = ny * mapWidth + nx;
        if (collisionGrid[i] === '1') continue;
        if (costs && !Number.isFinite(costs[i])) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = [nx, ny]; }
      }
    }
  }
  return best;
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

  // Unroutable destination. `Infinity` is checked too — `getTileCost` skips
  // those tiles, so the open set would just drain into the no-route fallback.
  //
  // First choice: route to the nearest walkable tile and take the last partial
  // step onto the target from there. Every such target seen in soaks is a spot
  // one tile off the floor (the park's riverside zone sits on the river the
  // cost map makes impassable; a conversation partner standing at a counter),
  // and a straight line from wherever the walker is instead cut through every
  // building in between. The final exact point is kept so arrival (which
  // measures distance to the destination) still fires.
  const endCost = grid ? grid[endY * mapWidth + endX] : 1;
  if (collisionGrid[endY * mapWidth + endX] === "1" || !Number.isFinite(endCost)) {
    const snap = nearestRoutableTile(endX, endY, collisionGrid, mapWidth, mapHeight, grid);
    if (snap) {
      fallbackObserver?.({
        kind: 'snapped-destination', start: [startX, startY], end: [endX, endY],
        gridWidth: mapWidth, gridHeight: mapHeight, context,
      });
      const [snapPx, snapPy] = tileCenterToPixel(snap[0], snap[1], tileSize);
      const toSnap = computeAStarPath(
        startPixel, { x: snapPx, y: snapPy },
        collisionGrid, mapWidth, mapHeight, tileSize, grid, context,
      );
      return [...toSnap, [endPixel.x, endPixel.y]];
    }
    // Nothing walkable nearby: straight line, which walks through walls. Kept as
    // a fallback rather than an error because callers have no recovery path,
    // but it is logged — this used to be completely silent.
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

  // A walker standing on a solid tile (the last partial step of a snapped route
  // leaves it on the furniture or wall row it was sent to) cannot leave it if
  // every neighbour is solid too: A* never checks the start tile, but a corner
  // cell's diagonals need both orthogonals open. Step to the nearest open tile
  // first rather than falling back to a straight line out through the wall.
  if (collisionGrid[startY * mapWidth + startX] === '1') {
    const snap = nearestRoutableTile(startX, startY, collisionGrid, mapWidth, mapHeight, grid);
    if (snap && (snap[0] !== endX || snap[1] !== endY)) {
      fallbackObserver?.({
        kind: 'snapped-start', start: [startX, startY], end: [endX, endY],
        gridWidth: mapWidth, gridHeight: mapHeight, context,
      });
      const [px, py] = tileCenterToPixel(snap[0], snap[1], tileSize);
      return [[px, py], ...computeAStarPath(
        { x: px, y: py }, endPixel, collisionGrid, mapWidth, mapHeight, tileSize, grid, context,
      )];
    }
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
