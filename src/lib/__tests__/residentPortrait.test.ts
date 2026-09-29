import { describe, expect, it } from "vitest";
import { PORTRAIT_MOODS } from "../../components/ui/portraitMood";
import { residentLook } from "../residentArt/look";
import { hex, getPixel } from "../residentArt/pixels";
import { PORTRAIT_SIZE, drawPortrait } from "../residentArt/portrait";

const PUPIL = hex("0a0604");
const LOOKS = Array.from({ length: 30 }, (_, i) =>
  residentLook(`Portrait ${i}`, { gender: ["male", "female", "neutral"][i % 3], age: 20 + i * 2 }),
);

describe("drawPortrait", () => {
  it("is 64x64 like the hand-drawn portraits and deterministic", () => {
    const p = drawPortrait(LOOKS[0], "neutral");
    expect(p.w).toBe(PORTRAIT_SIZE);
    expect(p.h).toBe(PORTRAIT_SIZE);
    expect(drawPortrait(LOOKS[0], "neutral").data).toEqual(p.data);
  });

  it("keeps the shared face template: pupils at (23,32) and (40,32)", () => {
    // portrait-moods.lua finds faces by these pupils; a generated portrait fits the same template.
    for (const look of LOOKS) {
      const p = drawPortrait(look, "neutral");
      expect(getPixel(p, 23, 32)).toBe(PUPIL);
      expect(getPixel(p, 40, 32)).toBe(PUPIL);
    }
  });

  it("draws a distinct face for every mood", () => {
    for (const look of LOOKS.slice(0, 6)) {
      const faces = PORTRAIT_MOODS.map((m) => Buffer.from(drawPortrait(look, m).data).toString("base64"));
      expect(new Set(faces).size).toBe(PORTRAIT_MOODS.length);
    }
  });

  it("fills the frame's bottom edge with shoulders", () => {
    const p = drawPortrait(LOOKS[0], "neutral");
    for (const x of [10, 32, 50]) expect(getPixel(p, x, 63) & 255).toBe(255);
  });
});
