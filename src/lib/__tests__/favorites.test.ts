import { describe, it, expect } from "vitest";
import {
  worldSeedOf,
  favoritesKey,
  parseFavorites,
  toggleFavorite,
  orderCast,
  cycleAgentId,
} from "../favorites";

describe("worldSeedOf", () => {
  it("prefers the resolved worldgen seed", () => {
    expect(worldSeedOf({ worldgen: { seed: "abc" }, scenario: { seed: "zzz" } })).toBe("abc");
  });
  it("falls back to the scenario seed, then to a fixed key", () => {
    expect(worldSeedOf({ scenario: { seed: "zzz" } })).toBe("zzz");
    expect(worldSeedOf({ worldgen: { seed: "  " } })).toBe("default");
    expect(worldSeedOf(null)).toBe("default");
    expect(worldSeedOf("nope")).toBe("default");
  });
  it("keeps each world's favourites apart", () => {
    expect(favoritesKey("a")).not.toBe(favoritesKey("b"));
  });
});

describe("parseFavorites", () => {
  it("reads a list of ids and drops duplicates", () => {
    expect(parseFavorites('["1","2","1"]')).toEqual(["1", "2"]);
  });
  it("treats anything else as empty", () => {
    expect(parseFavorites(null)).toEqual([]);
    expect(parseFavorites("")).toEqual([]);
    expect(parseFavorites("{oops")).toEqual([]);
    expect(parseFavorites('{"a":1}')).toEqual([]);
    expect(parseFavorites('[1,"2",null]')).toEqual(["2"]);
  });
});

describe("toggleFavorite", () => {
  it("adds and removes without mutating the input", () => {
    const base = new Set(["1"]);
    const added = toggleFavorite(base, "2");
    expect([...added]).toEqual(["1", "2"]);
    expect([...base]).toEqual(["1"]);
    expect([...toggleFavorite(added, "1")]).toEqual(["2"]);
  });
});

describe("orderCast", () => {
  const agents = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  it("puts favourites first and keeps each group in server order", () => {
    expect(orderCast(agents, new Set(["4", "2"])).map((a) => a.id)).toEqual([2, 4, 1, 3]);
  });
  it("is the identity with no favourites, and ignores unknown ids", () => {
    expect(orderCast(agents, new Set()).map((a) => a.id)).toEqual([1, 2, 3, 4]);
    expect(orderCast(agents, new Set(["99"])).map((a) => a.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("cycleAgentId", () => {
  const order = ["a", "b", "c"];
  it("steps forward and back, wrapping", () => {
    expect(cycleAgentId(order, "a", 1)).toBe("b");
    expect(cycleAgentId(order, "c", 1)).toBe("a");
    expect(cycleAgentId(order, "a", -1)).toBe("c");
    expect(cycleAgentId(order, "b", -1)).toBe("a");
  });
  it("starts at an end when nothing valid is selected", () => {
    expect(cycleAgentId(order, null, 1)).toBe("a");
    expect(cycleAgentId(order, null, -1)).toBe("c");
    expect(cycleAgentId(order, "gone", 1)).toBe("a");
  });
  it("returns null for an empty cast", () => {
    expect(cycleAgentId([], "a", 1)).toBeNull();
  });
});
