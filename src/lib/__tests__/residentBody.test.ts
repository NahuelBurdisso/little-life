import { describe, expect, it } from "vitest";
import { SHEET_FRAMES, SHEET_FRAME_COUNT, SHEET_FRAME_SIZE } from "../../components/canvas/agentFrames";
import {
  ANATOMY, OUTLINE, bob, bodyFrames, buildBodySheet, drawBack, drawFront, legRows, liftLeg, sideFrames, swingArm,
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

describe("side view (agent-sheets.lua sideFrames port)", () => {
  const APRON = hex("e8e4d8");
  const sideOf = (look: ResidentLook) => bodyFrames(look).slice(SHEET_FRAMES.idleSide);

  it("appends an idle profile and a four-frame side walk after the back view", () => {
    expect(SHEET_FRAMES.idleSide).toBe(SHEET_FRAMES.walkUp[3] + 1);
    expect(sideOf(LOOKS[0])).toHaveLength(1 + SHEET_FRAMES.walkSide.length);
    expect(sideFrames(LOOKS[0])).toHaveLength(1 + SHEET_FRAMES.walkSide.length);
  });

  it("faces right: one eye near the brow, the nose one pixel past the face", () => {
    for (const look of LOOKS.slice(0, 12)) {
      const idle = sideOf(look)[0];
      const eye = ANATOMY.eyeRow;
      expect(getPixel(idle, 17, eye)).toBe(EYE_WHITE);
      expect([14, 15, 16].filter((x) => getPixel(idle, x, eye) === EYE_WHITE)).toEqual([]);
      expect(getPixel(idle, 20, eye + 1)).toBe(look.skin.mid);
      expect(getPixel(idle, 11, eye + 1)).toBe(OUTLINE); // back of the head
    }
  });

  it("stays inside the hand-drawn footprint so anchors and held items line up", () => {
    for (const look of LOOKS) {
      for (const f of sideOf(look)) {
        const b = bounds(f);
        expect(b.minX).toBeGreaterThanOrEqual(9);
        expect(b.maxX).toBeLessThanOrEqual(22);
        expect(b.maxY).toBe(31);
      }
    }
  });

  it("strides: every walk frame differs from idle and the two contacts differ", () => {
    for (const look of LOOKS.slice(0, 6)) {
      const frames = sideOf(look);
      const [idle, contactA, passA, contactB] = frames;
      for (const f of frames.slice(1)) expect(rowDiff(idle, f).size).toBeGreaterThan(0);
      expect(contactA.data).not.toEqual(contactB.data);
      expect(passA.data).not.toEqual(contactA.data);
    }
  });

  it("shows an apron only on the front edge from the side, and not at all from behind", () => {
    const aproned = LOOKS.filter((l) => l.apron);
    expect(aproned.length).toBeGreaterThan(0);
    const xs = [...Array(SHEET_FRAME_SIZE).keys()];
    for (const look of aproned) {
      const side = sideOf(look)[0];
      const back = bodyFrames(look)[SHEET_FRAMES.idleUp];
      // The bib (x 14..17) is too narrow to reach the side; the skirt (x 13..18) shows as the
      // front column or two (the hips are narrower than the chest, so "front" starts at 16).
      for (let y = 16; y <= 23; y++) {
        const cols = xs.filter((x) => getPixel(side, x, y) === APRON);
        expect(cols.length).toBeLessThanOrEqual(2);
        expect(cols.every((x) => x >= 16)).toBe(true);
        if (y === 21 || y === 22) expect(cols.length).toBeGreaterThan(0);
        if (y <= 19) expect(xs.some((x) => getPixel(back, x, y) === APRON)).toBe(false);
      }
    }
  });
});
