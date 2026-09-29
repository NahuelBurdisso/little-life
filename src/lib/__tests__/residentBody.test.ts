import { describe, expect, it } from "vitest";
import { SHEET_FRAMES, SHEET_FRAME_COUNT, SHEET_FRAME_SIZE } from "../../components/canvas/agentFrames";
import {
  ANATOMY, OUTLINE, bob, bodyFrames, buildBodySheet, drawBack, drawFront, legRows, liftLeg, swingArm,
} from "../residentArt/bodySheet";
import { residentLook, type ResidentLook } from "../residentArt/look";
import { createImage, getPixel, hex, setPixel, type PixelImage } from "../residentArt/pixels";

const EYE_WHITE = hex("f0e2c8");

// A spread of looks that between them hit every hair style, hat, top and lower.
const LOOKS: ResidentLook[] = Array.from({ length: 60 }, (_, i) =>
  residentLook(`Townsfolk ${i}`, { gender: ["male", "female", "neutral"][i % 3], age: 20 + ((i * 7) % 60) }),
);

function rowDiff(a: PixelImage, b: PixelImage): Set<number> {
  const rows = new Set<number>();
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (getPixel(a, x, y) !== getPixel(b, x, y)) rows.add(y);
  return rows;
}

function bounds(img: PixelImage) {
  let minX = 99, maxX = -1, minY = 99, maxY = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if ((getPixel(img, x, y) & 255) === 0) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY };
}

describe("buildBodySheet", () => {
  it("has the <name>_sheet.png layout the loader slices", () => {
    const sheet = buildBodySheet(LOOKS[0]);
    expect(sheet.w).toBe(SHEET_FRAME_SIZE * SHEET_FRAME_COUNT);
    expect(sheet.h).toBe(SHEET_FRAME_SIZE);
    expect(bodyFrames(LOOKS[0])).toHaveLength(SHEET_FRAME_COUNT);
  });

  it("is deterministic", () => {
    expect(buildBodySheet(LOOKS[3]).data).toEqual(buildBodySheet(LOOKS[3]).data);
  });

  it("stays inside the hand-drawn sprites' footprint so anchors and held items line up", () => {
    for (const look of LOOKS) {
      for (const f of [drawFront(look), drawBack(look)]) {
        const b = bounds(f);
        // Widest hand-drawn sprite: Elena's hat brim (x 9..22), shadow ends on row 31.
        expect(b.minX).toBeGreaterThanOrEqual(9);
        expect(b.maxX).toBeLessThanOrEqual(22);
        expect(b.minY).toBeGreaterThanOrEqual(1);
        expect(b.maxY).toBe(31);
      }
    }
  });

  it("uses the universal outline and a translucent drop shadow", () => {
    const f = drawFront(LOOKS[0]);
    expect(getPixel(f, 12, 22)).toBe(OUTLINE);
    expect(getPixel(f, 15, 30) & 255).toBe(0x6e);
    expect(getPixel(f, 11, 30) & 255).toBe(0x3c);
  });

  it("blinks on the eye row only, and the front has eyes the back doesn't", () => {
    for (const look of LOOKS.slice(0, 12)) {
      const frames = bodyFrames(look);
      const idle = frames[SHEET_FRAMES.idleDown];
      expect([...rowDiff(idle, frames[SHEET_FRAMES.blinkDown])]).toEqual([ANATOMY.eyeRow]);
      const whites = (img: PixelImage) =>
        [14, 17].filter((x) => getPixel(img, x, ANATOMY.eyeRow) === EYE_WHITE).length;
      expect(whites(idle)).toBe(2);
      expect(whites(frames[SHEET_FRAMES.idleUp])).toBe(0);
    }
  });

  it("walks: every walk frame differs from the idle pose, both legs take a turn", () => {
    const look = LOOKS[1];
    const frames = bodyFrames(look);
    for (const cycle of [SHEET_FRAMES.walkDown, SHEET_FRAMES.walkUp]) {
      const idle = frames[cycle === SHEET_FRAMES.walkDown ? SHEET_FRAMES.idleDown : SHEET_FRAMES.idleUp];
      for (const i of cycle) expect(rowDiff(idle, frames[i]).size).toBeGreaterThan(0);
      expect(frames[cycle[0]].data).not.toEqual(frames[cycle[2]].data);
    }
  });

  it("puts skirts' legs under the hem", () => {
    expect(legRows({ lower: "skirt" })).toEqual({ legTop: 26, bottom: 28 });
    expect(legRows({ lower: "trousers" })).toEqual({ legTop: 24, bottom: 29 });
  });
});

describe("frame derivations (agent-sheets.lua ports)", () => {
  const marked = () => {
    const img = createImage(SHEET_FRAME_SIZE, SHEET_FRAME_SIZE);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(img, x, y, ((y + 1) << 8) | 255);
    return img;
  };

  it("liftLeg shifts one half's leg rows up and clears the foot row", () => {
    const out = liftLeg(marked(), 24, 29, "left");
    expect(getPixel(out, 10, 24)).toBe(getPixel(marked(), 10, 25));
    expect(getPixel(out, 10, 29)).toBe(0);
    expect(getPixel(out, 20, 24)).toBe(getPixel(marked(), 20, 24)); // right half untouched
    expect(getPixel(out, 10, 23)).toBe(getPixel(marked(), 10, 23)); // torso untouched
  });

  it("bob lowers everything above the legs by one row", () => {
    const out = bob(marked(), 24);
    expect(getPixel(out, 5, 24)).toBe(getPixel(marked(), 5, 23));
    expect(getPixel(out, 5, 10)).toBe(getPixel(marked(), 5, 9));
    expect(getPixel(out, 5, 0)).toBe(0);
    expect(getPixel(out, 5, 26)).toBe(getPixel(marked(), 5, 26));
  });

  it("swingArm drops only the arm columns", () => {
    const out = swingArm(marked(), "right");
    expect(getPixel(out, 21, ANATOMY.armBottom + 1)).toBe(getPixel(marked(), 21, ANATOMY.armBottom));
    expect(getPixel(out, 16, ANATOMY.armBottom + 1)).toBe(getPixel(marked(), 16, ANATOMY.armBottom + 1));
  });
});
