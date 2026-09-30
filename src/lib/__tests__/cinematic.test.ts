import { describe, expect, it } from "vitest";
import { CINEMATIC_KEY, readCinematic, writeCinematic } from "../cinematic";

function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const broken = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
};

describe("cinematic moments preference", () => {
  it("defaults to on", () => {
    expect(readCinematic(memory())).toBe(true);
  });

  it("remembers an off choice and an on choice", () => {
    const s = memory();
    writeCinematic(false, s);
    expect(s.getItem(CINEMATIC_KEY)).toBe("0");
    expect(readCinematic(s)).toBe(false);
    writeCinematic(true, s);
    expect(readCinematic(s)).toBe(true);
  });

  it("survives storage that throws", () => {
    expect(readCinematic(broken)).toBe(true);
    expect(() => writeCinematic(false, broken)).not.toThrow();
  });
});
