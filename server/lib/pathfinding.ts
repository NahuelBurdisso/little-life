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
): number[][] {
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

  // If end tile is blocked, return direct line as fallback
  if (collisionGrid[endY * mapWidth + endX] === "1") {
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
    return costMap ? costMap[y * mapWidth + x] : 1.0;
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

  // No path found — return direct line as fallback
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
