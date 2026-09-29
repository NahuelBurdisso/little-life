import { describe, expect, it } from "vitest";
import {
  HAIRS, SKINS, hashString, isPlaceholderSpriteKey, mulberry32, residentLook,
} from "../residentArt/look";

const NAMES = Array.from({ length: 80 }, (_, i) => `Resident ${i} ${String.fromCharCode(65 + (i % 26))}`);

describe("residentLook", () => {
  it("is a pure function of the name and hints", () => {
    const a = residentLook("Hector Ruiz", { gender: "male", age: 38 });
    const b = residentLook("Hector Ruiz", { gender: "male", age: 38 });
    expect(b).toEqual(a);
  });

  it("ignores case and surrounding whitespace in the name", () => {
    expect(residentLook("  hector ruiz ")).toEqual(residentLook("Hector Ruiz"));
  });

  it("gives different people different looks", () => {
    const looks = NAMES.map((n) => residentLook(n));
    const signature = (l: ReturnType<typeof residentLook>) =>
      [l.skin.mid, l.hair.mid, l.hairStyle, l.headwear, l.shirt.mid, l.pants.mid, l.top, l.lower].join();
    expect(new Set(looks.map(signature)).size).toBeGreaterThan(NAMES.length * 0.9);
    expect(new Set(looks.map((l) => l.skin)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(looks.map((l) => l.hairStyle)).size).toBeGreaterThanOrEqual(4);
  });

  it("keeps beards and receding hairlines off women and skirts off men", () => {
    for (const n of NAMES) {
      const f = residentLook(n, { gender: "female", age: 50 });
      expect(f.facial).toBe("none");
      expect(f.hairStyle).not.toBe("receding");
      expect(residentLook(n, { gender: "male", age: 50 }).lower).toBe("trousers");
    }
  });

  it("greys most residents past sixty and nobody young", () => {
    const grey = (age: number) =>
      NAMES.filter((n) => !HAIRS.includes(residentLook(n, { age }).hair)).length;
    expect(grey(25)).toBe(0);
    expect(grey(70)).toBeGreaterThan(NAMES.length * 0.75);
  });

  it("only uses skin ramps sampled from the hand-drawn art", () => {
    for (const n of NAMES) expect(SKINS).toContain(residentLook(n).skin);
  });
});

describe("seeding helpers", () => {
  it("hashString is stable (FNV-1a)", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
  });

  it("mulberry32 is deterministic and in [0, 1)", () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("recognises sprite keys with no art behind them", () => {
    expect(isPlaceholderSpriteKey("default")).toBe(true);
    expect(isPlaceholderSpriteKey("")).toBe(true);
    expect(isPlaceholderSpriteKey(undefined)).toBe(true);
    expect(isPlaceholderSpriteKey("rosa_chen")).toBe(false);
  });
});
