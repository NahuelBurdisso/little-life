import { describe, expect, it } from "vitest";
import { doorSide, doorStartTile, pathRects, routeDoorPath } from "../doorRoute";

const TS = 32;

/** Build predicates from an ASCII map: '#' blocked, 'R' road, 'S' start, anything else open. */
function parse(rows: string[]) {
  let start = { x: 0, y: 0 };
  const cells = rows.map((r) => [...r]);
  cells.forEach((r, y) => r.forEach((c, x) => { if (c === "S") start = { x, y }; }));
  const at = (x: number, y: number) => cells[y]?.[x];
  return {
    start,
    isGoal: (x: number, y: number) => at(x, y) === "R",
    isBlocked: (x: number, y: number) => at(x, y) === "#",
    bounds: { width: cells[0].length, height: cells.length },
  };
}

describe("routeDoorPath", () => {
  it("walks around a building instead of through it", () => {
    // The old L (vertical leg, then horizontal) from S to the nearest road would have gone
    // straight through the block in the middle column.
    const m = parse([
      "S..#R",
      "...#R",
      "...#R",
      "....R",
    ]);
    const route = routeDoorPath({ ...m, maxSteps: 10 })!;
    expect(route).not.toBeNull();
    for (const t of route) expect(m.isBlocked(t.x, t.y)).toBe(false);
    expect(route[0]).toEqual(m.start);
    expect(m.isGoal(route.at(-1)!.x, route.at(-1)!.y)).toBe(true);
    // Consecutive tiles are 4-adjacent.
    for (let i = 1; i < route.length; i++) {
      expect(Math.abs(route[i].x - route[i - 1].x) + Math.abs(route[i].y - route[i - 1].y)).toBe(1);
    }
  });

  it("returns null rather than crossing a building when the road is walled off", () => {
    const m = parse([
      "S.#R",
      "..#R",
      "###R",
    ]);
    expect(routeDoorPath({ ...m, maxSteps: 10 })).toBeNull();
  });

  it("returns null past the step cap", () => {
    const m = parse(["S.......R"]);
    expect(routeDoorPath({ ...m, maxSteps: 5 })).toBeNull();
    expect(routeDoorPath({ ...m, maxSteps: 8 })).toHaveLength(9);
  });

  it("prefers the straight route over an equally short staircase", () => {
    const m = parse([
      "S...R",
      ".....",
      ".....",
    ]);
    const route = routeDoorPath({ ...m, maxSteps: 10 })!;
    expect(route.every((t) => t.y === 0)).toBe(true);
  });

  it("stays inside the map bounds", () => {
    const m = parse(["S.R"]);
    const route = routeDoorPath({ ...m, maxSteps: 10 })!;
    expect(route.every((t) => t.x >= 0 && t.x < 3 && t.y === 0)).toBe(true);
  });

  it("lets the start tile sit on the road", () => {
    const route = routeDoorPath({ start: { x: 2, y: 2 }, isGoal: () => true, isBlocked: () => false, maxSteps: 3 });
    expect(route).toEqual([{ x: 2, y: 2 }]);
  });

  it("never enters a blocked tile even when it is the only way", () => {
    const m = parse(["S#R"]);
    expect(routeDoorPath({ ...m, maxSteps: 10 })).toBeNull();
  });
});

describe("door geometry", () => {
  const pos = { x: 64, y: 64, width: 96, height: 64 };

  it("finds the wall a door sits on", () => {
    expect(doorSide({ x: 112, y: 128 }, pos)).toBe("bottom");
    expect(doorSide({ x: 112, y: 64 }, pos)).toBe("top");
    expect(doorSide({ x: 160, y: 96 }, pos)).toBe("right");
    expect(doorSide({ x: 64, y: 96 }, pos)).toBe("left");
  });

  it("starts on the tile just outside the wall", () => {
    // y = 128 is a tile boundary: floor(128/32) is the row below the footprint (rows 2-3).
    expect(doorStartTile({ x: 112, y: 128 }, "bottom", TS)).toEqual({ x: 3, y: 4 });
    expect(doorStartTile({ x: 112, y: 64 }, "top", TS)).toEqual({ x: 3, y: 1 });
    expect(doorStartTile({ x: 160, y: 96 }, "right", TS)).toEqual({ x: 5, y: 3 });
    expect(doorStartTile({ x: 64, y: 96 }, "left", TS)).toEqual({ x: 1, y: 3 });
  });
});

describe("pathRects", () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("draws non-overlapping rects for an L route with a door stub", () => {
    const tiles = [{ x: 3, y: 4 }, { x: 3, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 5 }];
    // Door on a tile boundary (x = 128) so the wall strip is exercised too.
    const rects = pathRects(tiles, TS, 10, { ep: { x: 128, y: 128 }, side: "bottom" });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    }
    // Every rect has positive area and stays within the route's tile bounding box.
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(3 * TS);
      expect(r.x + r.w).toBeLessThanOrEqual(6 * TS + 10);
      expect(r.y).toBeGreaterThanOrEqual(4 * TS);
      expect(r.y + r.h).toBeLessThanOrEqual(6 * TS);
    }
  });

  it("gives identical rects for the same tile whichever door produced it", () => {
    const a = pathRects([{ x: 1, y: 1 }, { x: 2, y: 1 }], TS, 10);
    const b = pathRects([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }], TS, 10);
    const key = (r: { x: number; y: number; w: number; h: number }) => `${r.x},${r.y},${r.w},${r.h}`;
    const bKeys = new Set(b.map(key));
    // Tile (1,1) is identical in both; tile (2,1) gains an east arm in b, so only (1,1)'s rects are shared.
    for (const r of a.filter((r) => r.x < 2 * TS)) expect(bKeys.has(key(r))).toBe(true);
  });

  it("draws a lone centre square for a door that opens straight onto the road", () => {
    expect(pathRects([{ x: 2, y: 2 }], TS, 10)).toEqual([{ x: 2 * TS + 11, y: 2 * TS + 11, w: 10, h: 10 }]);
  });
});
