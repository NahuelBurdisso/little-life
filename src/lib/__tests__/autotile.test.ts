import { describe, it, expect } from 'vitest';
import {
  N, NE, E, SE, S, SW, W, NW,
  buildTileSet, hasTile, tileKey, neighbourMask,
  exposedEdges, outerCorners, innerCorners, diagonalSteps,
  runLengths, classifyRoadTile, connectedComponents, hash2,
  rasterizeBlobs, bucketCellRects, isInsideCell, isOffMap, uniqueTiles,
  CELL_OUT, CELL_BODY, CELL_EDGE, CELL_RING, CELL_HALO,
  type BlobRaster, type BlobStyle, type TileXY,
} from '../autotile';

const C = 16;
const ROAD: BlobStyle = { cellsPerTile: C, outerProfile: [2, 1], filletSize: 2, bridgeSize: 5 };

/** Tiles from an ASCII picture: '#' = tile, anything else = empty. */
function pic(rows: string[], ox = 0, oy = 0): TileXY[] {
  const out: TileXY[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => { if (ch === '#') out.push({ x: x + ox, y: y + oy }); });
  });
  return out;
}

function cellAt(r: BlobRaster, cx: number, cy: number): number {
  const lx = cx - r.x0, ly = cy - r.y0;
  if (lx < 0 || ly < 0 || lx >= r.width || ly >= r.height) return CELL_OUT;
  return r.cells[ly * r.width + lx];
}
const inside = (r: BlobRaster, cx: number, cy: number) => isInsideCell(cellAt(r, cx, cy));

/** Number of 4-connected components among cells matching `pred`. */
function cellComponents(r: BlobRaster, pred: (cls: number) => boolean): number {
  const seen = new Uint8Array(r.cells.length);
  let count = 0;
  for (let i = 0; i < r.cells.length; i++) {
    if (seen[i] || !pred(r.cells[i])) continue;
    count++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % r.width, y = Math.floor(j / r.width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= r.width || ny >= r.height) continue;
        const k = ny * r.width + nx;
        if (!seen[k] && pred(r.cells[k])) { seen[k] = 1; stack.push(k); }
      }
    }
  }
  return count;
}

describe('tile sets and masks', () => {
  it('uses numeric keys that survive negative neighbours', () => {
    const set = buildTileSet([{ x: 0, y: 0 }, { x: 3, y: 7 }]);
    expect(hasTile(set, 0, 0)).toBe(true);
    expect(hasTile(set, 3, 7)).toBe(true);
    expect(hasTile(set, -1, 0)).toBe(false);
    expect(hasTile(set, 0, -1)).toBe(false);
    expect(tileKey(-1, 0)).not.toBe(tileKey(0, -1));
    expect(typeof [...set][0]).toBe('number');
  });

  it('isolated tile has an empty mask and four exposed edges / outer corners', () => {
    const set = buildTileSet([{ x: 5, y: 5 }]);
    const m = neighbourMask(set, 5, 5);
    expect(m).toBe(0);
    expect(exposedEdges(m)).toEqual({ n: true, e: true, s: true, w: true });
    expect(outerCorners(m)).toEqual({ nw: true, ne: true, se: true, sw: true });
    expect(innerCorners(m)).toEqual({ nw: false, ne: false, se: false, sw: false });
    expect(diagonalSteps(m)).toEqual({ nw: false, ne: false, se: false, sw: false });
  });

  it('sets each bit for its own direction', () => {
    const dirs: Array<[number, number, number]> = [
      [N, 0, -1], [NE, 1, -1], [E, 1, 0], [SE, 1, 1], [S, 0, 1], [SW, -1, 1], [W, -1, 0], [NW, -1, -1],
    ];
    for (const [bit, dx, dy] of dirs) {
      expect(neighbourMask(buildTileSet([{ x: dx, y: dy }]), 0, 0)).toBe(bit);
    }
    const full = pic(['###', '###', '###']);
    expect(neighbourMask(buildTileSet(full), 1, 1)).toBe(255);
  });

  it('2-wide straight road: only the outer side is exposed, no corners mid-run', () => {
    const set = buildTileSet(pic(['######', '######']));
    const top = neighbourMask(set, 2, 0);
    const bottom = neighbourMask(set, 2, 1);
    expect(exposedEdges(top)).toEqual({ n: true, e: false, s: false, w: false });
    expect(exposedEdges(bottom)).toEqual({ n: false, e: false, s: true, w: false });
    for (const m of [top, bottom]) {
      expect(Object.values(outerCorners(m)).some(Boolean)).toBe(false);
      expect(Object.values(innerCorners(m)).some(Boolean)).toBe(false);
    }
    // The run ends are convex on their outer corners only.
    expect(outerCorners(neighbourMask(set, 0, 0))).toEqual({ nw: true, ne: false, se: false, sw: false });
    expect(outerCorners(neighbourMask(set, 5, 1))).toEqual({ nw: false, ne: false, se: true, sw: false });
  });

  it('L shape: the elbow tile has one concave corner, the arm tips convex ones', () => {
    // ##
    // #.
    const set = buildTileSet(pic(['##', '#.']));
    const elbow = neighbourMask(set, 0, 0);
    expect(innerCorners(elbow)).toEqual({ nw: false, ne: false, se: true, sw: false });
    expect(outerCorners(elbow)).toEqual({ nw: true, ne: false, se: false, sw: false });
    expect(outerCorners(neighbourMask(set, 1, 0))).toEqual({ nw: false, ne: true, se: true, sw: false });
  });

  it('cross: centre has no exposed edges; every concave corner lands on it', () => {
    const set = buildTileSet(pic(['.#.', '###', '.#.']));
    const centre = neighbourMask(set, 1, 1);
    expect(exposedEdges(centre)).toEqual({ n: false, e: false, s: false, w: false });
    expect(innerCorners(centre)).toEqual({ nw: true, ne: true, se: true, sw: true });
  });

  it('T: the junction tile has concave corners toward the stem only', () => {
    const set = buildTileSet(pic(['###', '.#.']));
    const m = neighbourMask(set, 1, 0);
    expect(exposedEdges(m)).toEqual({ n: true, e: false, s: false, w: false });
    expect(innerCorners(m)).toEqual({ nw: false, ne: false, se: true, sw: true });
  });

  it('staircase: diagonal contact is a diagonal step, not an outer corner to round', () => {
    const set = buildTileSet(pic(['#..', '.#.', '..#']));
    expect(diagonalSteps(neighbourMask(set, 0, 0))).toEqual({ nw: false, ne: false, se: true, sw: false });
    expect(diagonalSteps(neighbourMask(set, 1, 1))).toEqual({ nw: true, ne: false, se: true, sw: false });
    // Still an outer corner by definition — the renderer checks diagonalSteps first.
    expect(outerCorners(neighbourMask(set, 1, 1)).se).toBe(true);
  });
});

describe('road tile classification', () => {
  it('2-wide straight roads are h / v', () => {
    const hset = buildTileSet(pic(['######', '######']));
    for (let x = 0; x < 6; x++) {
      expect(classifyRoadTile(hset, x, 0)).toBe('h');
      expect(classifyRoadTile(hset, x, 1)).toBe('h');
    }
    const vset = buildTileSet(pic(['##', '##', '##', '##']));
    expect(classifyRoadTile(vset, 0, 1)).toBe('v');
    expect(classifyRoadTile(vset, 1, 3)).toBe('v');
  });

  it('crossing of 2-wide roads: the shared 2x2 is a junction, arms stay straight', () => {
    const set = buildTileSet(pic([
      '..##..',
      '..##..',
      '######',
      '######',
      '..##..',
      '..##..',
    ]));
    for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) expect(classifyRoadTile(set, x, y)).toBe('junction');
    expect(classifyRoadTile(set, 0, 2)).toBe('h');
    expect(classifyRoadTile(set, 5, 3)).toBe('h');
    expect(classifyRoadTile(set, 2, 0)).toBe('v');
    expect(classifyRoadTile(set, 3, 5)).toBe('v');
  });

  it('L bend of a 2-wide road: the corner block is junction, ruts stop before it', () => {
    const set = buildTileSet(pic([
      '######',
      '######',
      '....##',
      '....##',
    ]));
    for (const [x, y] of [[4, 0], [5, 0], [4, 1], [5, 1]]) expect(classifyRoadTile(set, x, y)).toBe('junction');
    expect(classifyRoadTile(set, 3, 0)).toBe('h');
    expect(classifyRoadTile(set, 4, 3)).toBe('v');
  });

  it('2-wide diagonal staircase is all junction — no rut fragments', () => {
    // A 4-connected staircase path dilated with a 2x2 brush.
    const tiles = pic([
      '###.....',
      '####....',
      '.####...',
      '..####..',
      '...####.',
      '....####',
      '.....###',
    ]);
    const set = buildTileSet(tiles);
    // The first/last columns are where straight roads would join the staircase
    // (row run 3-4, column run 2), so they may legitimately read as 'h'.
    for (const t of tiles.filter((t) => t.x > 0 && t.x < 7)) {
      expect(classifyRoadTile(set, t.x, t.y)).toBe('junction');
    }
  });

  it('runLengths counts the tile itself', () => {
    const set = buildTileSet(pic(['###', '.#.']));
    expect(runLengths(set, 1, 0)).toEqual({ h: 3, v: 2 });
    expect(runLengths(buildTileSet([{ x: 0, y: 0 }]), 0, 0)).toEqual({ h: 1, v: 1 });
    expect(classifyRoadTile(buildTileSet([{ x: 0, y: 0 }]), 0, 0)).toBe('stub');
  });
});

describe('connectedComponents', () => {
  it('splits on gaps and diagonal-only contact, dedupes, sorts inside', () => {
    const tiles = [
      { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 },
      { x: 6, y: 6 }, // diagonal to (5,5) → separate
    ];
    const comps = connectedComponents(tiles);
    expect(comps.map((c) => c.length)).toEqual([1, 3, 1]);
    expect(comps[1]).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
  });

  it('finds the same components whatever the input order', () => {
    const tiles = pic(['##..#', '#..##', '...#.', '#....']);
    // Components as a canonical set of sets, independent of listing order.
    const canon = (comps: TileXY[][]) =>
      comps.map((c) => c.map((t) => `${t.x},${t.y}`).sort().join(' ')).sort();
    const base = canon(connectedComponents(tiles));
    expect(base).toEqual(['0,0 0,1 1,0', '0,3', '3,1 3,2 4,0 4,1']);
    // Seeded Fisher-Yates so the shuffles are reproducible.
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let n = 0; n < 10; n++) {
      const shuffled = [...tiles];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(canon(connectedComponents(shuffled))).toEqual(base);
    }
    // Same input → identical output, order included.
    expect(connectedComponents(tiles)).toEqual(connectedComponents([...tiles]));
    expect(connectedComponents([])).toEqual([]);
  });
});

describe('hash2', () => {
  it('is deterministic, salted and spreads adjacent cells', () => {
    expect(hash2(3, 4)).toBe(hash2(3, 4));
    expect(hash2(3, 4, 1)).not.toBe(hash2(3, 4));
    const buckets = new Set<number>();
    for (let x = 0; x < 8; x++) buckets.add(hash2(x, 0) & 3);
    expect(buckets.size).toBeGreaterThan(1);
    expect(hash2(-1, -1)).toBeGreaterThanOrEqual(0);
  });
});

describe('rasterizeBlobs (road style)', () => {
  it('returns an empty raster for no tiles', () => {
    const r = rasterizeBlobs([], ROAD);
    expect(r.width).toBe(0);
    expect(r.cells.length).toBe(0);
  });

  it('isolated tile: rounded corners, closed lip, dither ring, halo outside', () => {
    const r = rasterizeBlobs([{ x: 2, y: 3 }], ROAD);
    const ox = 2 * C, oy = 3 * C;
    // Corner steps [2,1]: row 0 loses 2 cells, row 1 loses 1.
    expect(inside(r, ox, oy)).toBe(false);
    expect(inside(r, ox + 1, oy)).toBe(false);
    expect(inside(r, ox + 2, oy)).toBe(true);
    expect(inside(r, ox, oy + 1)).toBe(false);
    expect(inside(r, ox + 1, oy + 1)).toBe(true);
    expect(inside(r, ox + C - 1, oy + C - 1)).toBe(false);
    // Nothing leaks outside the tile (no bridges/fillets for an isolated tile).
    expect(inside(r, ox - 1, oy + 8)).toBe(false);
    expect(inside(r, ox + C, oy + 8)).toBe(false);
    // Outline classes.
    expect(cellAt(r, ox + 8, oy)).toBe(CELL_EDGE);
    expect(cellAt(r, ox + 8, oy + 1)).toBe(CELL_RING);
    expect(cellAt(r, ox + 8, oy + 8)).toBe(CELL_BODY);
    expect(cellAt(r, ox + 8, oy - 1)).toBe(CELL_HALO);
    expect(cellComponents(r, (c) => c === CELL_EDGE)).toBe(1);
    expect(cellComponents(r, isInsideCell)).toBe(1);
  });

  it('2-wide straight: tile seams are seamless, lip only on the outer sides', () => {
    const r = rasterizeBlobs(pic(['#####', '#####']), ROAD);
    // Seam between (1,0) and (2,0), and between the two rows.
    for (let cy = 1; cy < 2 * C - 1; cy++) expect(inside(r, 2 * C, cy)).toBe(true);
    for (let cx = 1; cx < 5 * C - 1; cx++) expect(inside(r, cx, C)).toBe(true);
    expect(cellAt(r, 2 * C, C)).toBe(CELL_BODY);
    expect(cellAt(r, 2 * C, 0)).toBe(CELL_EDGE);
    expect(cellAt(r, 2 * C, 2 * C - 1)).toBe(CELL_EDGE);
    expect(cellComponents(r, (c) => c === CELL_EDGE)).toBe(1);
  });

  it('L bend: concave corner is chamfered into the empty tile and the lip stays closed', () => {
    // ##
    // #.
    const r = rasterizeBlobs(pic(['##', '#.']), ROAD);
    // Concave vertex at cell (C, C); fillet [2] adds 3 cells into tile (1,1).
    expect(inside(r, C, C)).toBe(true);
    expect(inside(r, C + 1, C)).toBe(true);
    expect(inside(r, C, C + 1)).toBe(true);
    expect(inside(r, C + 1, C + 1)).toBe(false);
    expect(inside(r, C + 2, C)).toBe(false);
    // The fillet sits on the outline: it's lip, and the lip is one closed loop.
    expect(cellAt(r, C, C)).toBe(CELL_EDGE);
    expect(cellComponents(r, (c) => c === CELL_EDGE)).toBe(1);
    expect(cellComponents(r, isInsideCell)).toBe(1);
  });

  it('1-wide staircase: diagonal steps are bridged into one connected shape', () => {
    const tiles = pic(['#...', '.#..', '..#.', '...#']);
    const r = rasterizeBlobs(tiles, ROAD);
    expect(cellComponents(r, isInsideCell)).toBe(1);
    // The pinch corners stay square (not rounded)...
    expect(inside(r, C - 1, C - 1)).toBe(true);
    expect(inside(r, C, C)).toBe(true);
    // ...and the notch tiles (1,0) and (0,1) get bridge cells at the pinch.
    expect(inside(r, C, C - 1)).toBe(true);
    expect(inside(r, C - 1, C)).toBe(true);
    // The staircase's free ends are still rounded.
    expect(inside(r, 0, 0)).toBe(false);
    expect(inside(r, 4 * C - 1, 4 * C - 1)).toBe(false);
    // Without bridges the same tiles fall apart into four beads.
    const beads = rasterizeBlobs(tiles, { ...ROAD, bridgeSize: 0 });
    expect(cellComponents(beads, isInsideCell)).toBe(4);
  });

  it('2-wide staircase lip is a single closed outline', () => {
    const r = rasterizeBlobs(pic(['###...', '####..', '.####.', '..####', '...###']), ROAD);
    expect(cellComponents(r, isInsideCell)).toBe(1);
    expect(cellComponents(r, (c) => c === CELL_EDGE)).toBe(1);
  });

  it('T and cross junctions produce one connected surface', () => {
    for (const shape of [['###', '.#.', '.#.'], ['.#.', '###', '.#.']]) {
      const r = rasterizeBlobs(pic(shape), ROAD);
      expect(cellComponents(r, isInsideCell)).toBe(1);
      expect(cellComponents(r, (c) => c === CELL_EDGE)).toBe(1);
    }
  });

  it('is deterministic and independent of input order / duplicates', () => {
    const tiles = pic(['.##.', '####', '#..#', '#.##'], 3, 2);
    const a = rasterizeBlobs(tiles, ROAD);
    const b = rasterizeBlobs([...tiles].reverse().concat(tiles.slice(0, 2)), ROAD);
    expect(b.x0).toBe(a.x0);
    expect(b.y0).toBe(a.y0);
    expect(Array.from(b.cells)).toEqual(Array.from(a.cells));
  });
});

describe('rasterizeBlobs (inset style, dirt)', () => {
  const DIRT: BlobStyle = {
    cellsPerTile: C,
    inset: (x, y, side) => 2 + ((x * 3 + y * 5 + side.charCodeAt(0)) & 1),
    outerProfile: [3, 2, 1],
    filletSize: 2,
    bridgeSize: 0,
  };

  it('adjacent tiles merge across the seam; exposed sides are inset', () => {
    const r = rasterizeBlobs(pic(['###']), DIRT);
    expect(inside(r, C, 8)).toBe(true);
    expect(inside(r, 2 * C, 8)).toBe(true);
    expect(inside(r, C, 0)).toBe(false); // top inset ≥ 2
    expect(inside(r, C, 1)).toBe(false);
    expect(inside(r, 0, 8)).toBe(false); // left inset ≥ 2
    expect(cellComponents(r, isInsideCell)).toBe(1);
  });

  it('concave corner is cut back to the neighbours\' inset lines, then chamfered', () => {
    // ##
    // #.
    const r = rasterizeBlobs(pic(['##', '#.']), DIRT);
    const cutX = DIRT.inset!(0, 1, 'e'); // tile below's right inset
    const cutY = DIRT.inset!(1, 0, 's'); // tile to the right's bottom inset
    // Outermost cell of the cut square stays empty; the vertex-adjacent cell is filled.
    expect(inside(r, C - 1, C - 1)).toBe(false);
    expect(inside(r, C - cutX, C - cutY)).toBe(true);
    expect(inside(r, C - cutX - 1, C - cutY - 1)).toBe(true);
    expect(cellComponents(r, isInsideCell)).toBe(1);
    expect(cellComponents(r, (c) => c === CELL_EDGE)).toBe(1);
  });

  it('diagonal-only contact does not bridge when bridgeSize is 0', () => {
    const r = rasterizeBlobs(pic(['#.', '.#']), DIRT);
    expect(cellComponents(r, isInsideCell)).toBe(2);
  });
});

describe('bucketCellRects', () => {
  // Class → bucket: 1 lip, 2 ring, 3 halo (body skipped), plus a checker split
  // of the ring so buckets interleave within a run.
  const bucketOf = (c: number, cx: number, cy: number) =>
    c === CELL_EDGE ? 1 : c === CELL_RING ? (((cx + cy) & 1) === 0 ? 2 : 4) : c === CELL_HALO ? 3 : 0;

  it('covers exactly each bucket\'s cells with non-overlapping rects', () => {
    const r = rasterizeBlobs(pic(['##..', '####', '.#.#']), ROAD);
    const buckets = bucketCellRects(r, bucketOf, 4);
    expect(buckets).toHaveLength(4);
    const covered = new Map<string, number>();
    buckets.forEach((rects, bi) => {
      for (const q of rects) {
        for (let y = q.y; y < q.y + q.h; y++) {
          for (let x = q.x; x < q.x + q.w; x++) {
            const k = `${x},${y}`;
            covered.set(k, (covered.get(k) ?? 0) + 1);
            expect(bucketOf(cellAt(r, x, y), x, y)).toBe(bi + 1);
          }
        }
      }
    });
    expect([...covered.values()].every((n) => n === 1)).toBe(true);
    let expected = 0;
    for (let ly = 0; ly < r.height; ly++) {
      for (let lx = 0; lx < r.width; lx++) {
        if (bucketOf(r.cells[ly * r.width + lx], r.x0 + lx, r.y0 + ly) !== 0) expected++;
      }
    }
    expect(covered.size).toBe(expected);
  });

  it('merges a straight road body into few rects', () => {
    const r = rasterizeBlobs(pic(['##########', '##########']), ROAD);
    const [rects] = bucketCellRects(r, (c) => (isInsideCell(c) ? 1 : 0), 1);
    // Rounded ends make a few distinct rows; the long middle is one tall rect.
    expect(rects.length).toBeLessThanOrEqual(5);
  });

  it('passes absolute cell coordinates and never OUT cells', () => {
    const r = rasterizeBlobs([{ x: 4, y: 4 }], ROAD);
    const seen: Array<[number, number]> = [];
    bucketCellRects(r, (c, cx, cy) => {
      expect(c).not.toBe(CELL_OUT);
      if (c === CELL_BODY && seen.length === 0) seen.push([cx, cy]);
      return 0;
    }, 1);
    expect(seen[0][0]).toBeGreaterThanOrEqual(4 * C);
    expect(seen[0][1]).toBeGreaterThanOrEqual(4 * C);
  });

  it('handles an empty raster', () => {
    expect(bucketCellRects(rasterizeBlobs([], ROAD), () => 1, 2)).toEqual([[], []]);
  });
});

describe('map bounds', () => {
  const bounds = { width: 6, height: 4 };

  it('neighbourMask counts off-map neighbours as present', () => {
    const set = buildTileSet([{ x: 0, y: 1 }]);
    expect(neighbourMask(set, 0, 1)).toBe(0);
    expect(neighbourMask(set, 0, 1, bounds)).toBe(W | NW | SW);
    expect(isOffMap(bounds, -1, 0)).toBe(true);
    expect(isOffMap(bounds, 5, 3)).toBe(false);
    expect(isOffMap(bounds, 6, 3)).toBe(true);
  });

  it('a road running off the map edge gets no cap, lip or halo along the border', () => {
    const tiles = pic(['......', '###...', '###...', '......']);
    const capped = rasterizeBlobs(tiles, ROAD);
    const open = rasterizeBlobs(tiles, { ...ROAD, bounds });
    // Without bounds the west end is a rounded, lipped cap with halo beyond it.
    expect(inside(capped, 0, C)).toBe(false);
    expect(cellAt(capped, 0, C + 8)).toBe(CELL_EDGE);
    expect(cellAt(capped, -1, C + 8)).toBe(CELL_HALO);
    // With bounds the road is square and unlipped at x = 0, and nothing is off-map.
    expect(inside(open, 0, C)).toBe(true);
    expect(cellAt(open, 0, C + 8)).toBe(CELL_BODY);
    expect(cellAt(open, -1, C + 8)).toBe(CELL_OUT);
    // The on-map sides are still outlined.
    expect(cellAt(open, 8, C)).toBe(CELL_EDGE);
    expect(cellAt(open, 8, C - 1)).toBe(CELL_HALO);
    expect(inside(open, 3 * C - 1, C)).toBe(false); // east cap still rounded
  });
});

describe('uniqueTiles', () => {
  it('drops repeats and keeps first-seen order', () => {
    const a = { x: 1, y: 1, tag: 'a' };
    const b = { x: 2, y: 1, tag: 'b' };
    expect(uniqueTiles([a, b, { x: 1, y: 1, tag: 'dup' }, b])).toEqual([a, b]);
  });
});
