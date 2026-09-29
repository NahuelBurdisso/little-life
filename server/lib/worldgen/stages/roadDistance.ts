/** Pure distance-to-road field shared by the road, layout and homes stages. */

/**
 * Manhattan distance from every tile to the nearest road tile, by multi-source
 * BFS. Obstacles are deliberately ignored: this measures how close a doorway is
 * to the street network, not how far an agent would have to walk around a
 * building to reach it.
 *
 * Lives in its own module rather than in a stage because `layout` and `homes`
 * order their candidate positions by it and `organicRoads` steers lanes by it,
 * and copies would be free to drift. It used to live in `roads.ts`, which made
 * `roads.ts` and `organicRoads.ts` import each other.
 *
 * Tiles unreachable from any road (only possible when `roadTiles` is empty) keep
 * the initial sentinel, which sorts last.
 */
export function buildRoadDistance(
  width: number,
  height: number,
  roadTiles: Array<{ x: number; y: number }>,
): Int32Array {
  const dist = new Int32Array(width * height).fill(0x7fffffff);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  for (const t of roadTiles) {
    if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height) continue;
    const i = t.y * width + t.x;
    if (dist[i] === 0) continue;
    dist[i] = 0;
    queue[tail++] = i;
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width, y = (i - x) / width;
    const d = dist[i] + 1;
    if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < width - 1 && dist[i + 1] > d) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - width] > d) { dist[i - width] = d; queue[tail++] = i - width; }
    if (y < height - 1 && dist[i + width] > d) { dist[i + width] = d; queue[tail++] = i + width; }
  }
  return dist;
}
