/**
 * Parametric 64×64 head-and-shoulders portraits for generated residents, in every expression
 * `portraitMood` can ask for.
 *
 * The 13 hand-drawn portraits share one face template ("All 13 portraits share one face template,
 * only hair/hats/beards differ" — scripts/aseprite/portrait-moods.lua): pupils at (23,32) and
 * (40,32), 5×3 eyes under a dark lid line, brows two rows above, the mouth 8..11 rows under the
 * pupils across x 26..37, a neck with the collar either side, then the shoulders filling the
 * bottom 11 rows. The face rows below are Thomas Park's, letter for letter, with his colours
 * swapped for palette slots; hair, hats, beards and clothes are drawn around it from the
 * resident's `ResidentLook`, the same look the map sprite uses.
 *
 * Expressions follow the Lua script's recipe (grin + squint, frown + drooping outer lids + a
 * tear, glare + tight mouth + furrow, wide eyes + open mouth, the grin plus rosy cheeks for
 * `smitten`) but are drawn directly, since the
 * generator knows exactly where every feature is.
 */
import type { PortraitMood } from "../../components/ui/portraitMood";
import type { ResidentLook } from "./look";
import { createImage, getPixel, hex, luma, mix, paintRow, setPixel, shade, type PixelImage, type RGBA } from "./pixels";

export const PORTRAIT_SIZE = 64;

const OUTLINE = hex("1a1510");
const SCLERA = hex("f0e2c8");
const GLINT = hex("ffffff");
const PUPIL = hex("0a0604");
const TEAR = hex("9cc8e8");
const TEAR_HI = hex("d8eeff");
const ROSE = hex("e85a78");
const COLLAR = hex("e8e4d8");
const COLLAR_SHADE = hex("c8c0b0");
const APRON = hex("e8e4d8");
const APRON_SHADE = hex("c8c4b8");

type Palette = Record<string, RGBA>;

function palette(look: ResidentLook): Palette {
  const { skin, hair } = look;
  const brow = luma(hair.dark) > 60 ? shade(hair.dark, 0.5) : hair.dark;
  return {
    A: OUTLINE,
    F: skin.shade, P: skin.mid, H: skin.light, J: skin.hi, I: shade(skin.shade, 0.7),
    G: brow, B: shade(brow, 1.25),
    K: SCLERA, L: GLINT, M: look.iris, N: shade(look.iris, 0.6), O: PUPIL,
    Q: shade(skin.lipDark, 0.6), R: skin.lipDark, S: skin.lip,
    T: COLLAR, t: COLLAR_SHADE,
    "1": hair.dark, "2": hair.mid, "3": hair.light,
  };
}

// Thomas Park's face, rows 28..52, x 16..47.
const FACE_X = 16;
const FACE: readonly string[] = [
  "A...GGGGGGGHHHHHHHHHHGGGGGGG...A", // 28 brows
  "A.IFBBBBBGGHHHHHHHHHHGGBBBBBFI.A",
  "A.IFAAAAAAAHHHHJJHHHHAAAAAAAFI.A", // 30 lid lines
  "..IAFKLMNKFHHHHJJHHHHFKLMNKFAI..",
  "..IFFKMOMKFHHHJJJJHHHFKMOMKFFI..", // 32 pupils
  "..APFKNMNKFHHHHJJHHHHFKNMNKFPA..",
  ".AAFFFFFFFFHHHHJJHHHHFFFFFFFFAA.",
  ".AIFPHHHHHHHHFPJJPFHHHHHHHHPFIA.",
  ".AIFPHHHHHHHHHPJJPHHHHHHHHHPFIA.",
  ".AIFPHHHHHHHHHFHHFHHHHHHHHHPFIA.",
  ".AIFPHHHHHHHHIFPPFIHHHHHHHHPFIA.",
  ".AIFPHHHHHHHHHHJJHHHHHHHHHHPFIA.",
  ".AAFPHHHHHQQQQRQQRQQQQHHHHHPFAA.", // 40 mouth
  "..AFPHHHHHQRRRRRRRRRRQHHHHHPFA..",
  "..IAPHHHHHHSSSSSSSSSSHHHHHHPAI..",
  "..IAAHHHHHHHRRRRRRRRHHHHHHHAAI..",
  "..IFAAHHFPHHHHHHHHHHHHPFHHAAFI..",
  "..IFPAAHFPHHHHHHHHHHHHPFHAAPFI..",
  "..IFP.AAFPHHHHHJJHHHHHPFAA.PFI..",
  "........FPHHHHHHHHHHHHPF........",
  ".........AFTPPPPPPPPTFA.........", // 48 neck
  ".........AFTFFFFFFFFTFA.........",
  ".........AFTPPPPPPPPTFA.........",
  ".........ATFPPPPPPPPFTA.........",
  ".........ATFPPPPPPPPFTA.........",
];
const FACE_Y = 28;

// ── Hair and hats ───────────────────────────────────────────────────────────────────────────

/** Fill a dome (the skull) with a strand texture like the hand-drawn hair: mid with dark flecks. */
function hairDome(img: PixelImage, pal: Palette, top: number, bottom: number, x0: number, x1: number): void {
  for (let y = top; y <= bottom; y++) {
    // Rounded crown: the first rows are inset like the portraits' outline corners.
    const inset = y === top ? 4 : y === top + 1 ? 2 : y === top + 2 ? 1 : 0;
    const l = x0 + inset, r = x1 - inset;
    for (let x = l; x <= r; x++) {
      const edge = x === l || x === r || y === top;
      const fleck = (x * 2 + y * 3) % 7 === 0;
      const shine = y >= top + 2 && y <= top + 4 && x > l + 5 && x < (l + r) / 2;
      setPixel(img, x, y, edge ? OUTLINE : shine ? pal["3"] : fleck ? pal["1"] : pal["2"]);
    }
  }
}

function fillRect(img: PixelImage, x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPixel(img, x, y, c);
}

/** Curtain of hair beside the face, `x0..x1`, rows `y0..y1`, outlined on the outside. */
function hairSide(img: PixelImage, pal: Palette, x0: number, x1: number, y0: number, y1: number, outerLeft: boolean): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const outer = outerLeft ? x === x0 : x === x1;
      const inner = outerLeft ? x === x1 : x === x0;
      const c = outer || y === y1 ? OUTLINE : inner ? pal["1"] : (x + y) % 4 === 0 ? pal["1"] : pal["2"];
      setPixel(img, x, y, c);
    }
  }
}

function paintHair(img: PixelImage, look: ResidentLook, pal: Palette): void {
  switch (look.hairStyle) {
    case "short":
      hairDome(img, pal, 9, 27, 16, 47);
      fillRect(img, 17, 28, 19, 34, pal["1"]);
      fillRect(img, 44, 28, 46, 34, pal["1"]);
      break;
    case "swept":
      hairDome(img, pal, 7, 27, 15, 48);
      // The side part: a light sweep across the crown.
      for (let x = 20; x <= 34; x++) setPixel(img, x, 11 + Math.floor((x - 20) / 5), pal["3"]);
      fillRect(img, 17, 28, 19, 35, pal["1"]);
      fillRect(img, 44, 28, 46, 35, pal["1"]);
      break;
    case "receding": {
      // Bare crown: a skin dome, hair only over the ears.
      for (let y = 12; y <= 27; y++) {
        const inset = y === 12 ? 4 : y === 13 ? 2 : y === 14 ? 1 : 0;
        for (let x = 16 + inset; x <= 47 - inset; x++) {
          const edge = x === 16 + inset || x === 47 - inset || y === 12;
          setPixel(img, x, y, edge ? OUTLINE : y < 16 && x > 24 && x < 32 ? pal.J : x < 22 || x > 41 ? pal.P : pal.H);
        }
      }
      hairSide(img, pal, 15, 20, 18, 36, true);
      hairSide(img, pal, 43, 48, 18, 36, false);
      break;
    }
    case "bun":
      hairDome(img, pal, 9, 27, 16, 47);
      hairDome(img, pal, 1, 9, 26, 37);
      fillRect(img, 17, 28, 19, 33, pal["1"]);
      fillRect(img, 44, 28, 46, 33, pal["1"]);
      break;
    case "long":
      hairDome(img, pal, 8, 27, 15, 48);
      hairSide(img, pal, 10, 19, 20, 55, true);
      hairSide(img, pal, 44, 53, 20, 55, false);
      break;
    case "bob":
      hairDome(img, pal, 8, 27, 15, 48);
      hairSide(img, pal, 12, 19, 20, 44, true);
      hairSide(img, pal, 44, 51, 20, 44, false);
      break;
  }
  // Fringe shadow just above the brows.
  if (look.hairStyle !== "receding") for (let x = 18; x <= 45; x++) setPixel(img, x, 27, pal["1"]);
}

function paintHat(img: PixelImage, look: ResidentLook, pal: Palette): void {
  const { hat } = look;
  const underside = shade(hat.dark, 0.55);
  const crown = (y0: number, y1: number, x0: number, x1: number) => {
    for (let y = y0; y <= y1; y++) {
      const inset = y === y0 ? 2 : y === y0 + 1 ? 1 : 0;
      for (let x = x0 + inset; x <= x1 - inset; x++) {
        const edge = x === x0 + inset || x === x1 - inset || y === y0;
        const weave = (x + y * 2) % 5 === 0;
        setPixel(img, x, y, edge ? OUTLINE : y <= y0 + 2 ? hat.light : weave ? hat.dark : hat.mid);
      }
    }
  };
  switch (look.headwear) {
    case "none":
      return;
    case "cap":
      crown(10, 22, 16, 47);
      fillRect(img, 14, 23, 49, 23, OUTLINE);
      fillRect(img, 15, 24, 48, 25, underside);
      fillRect(img, 14, 26, 49, 26, OUTLINE);
      fillRect(img, 18, 27, 45, 27, shade(pal.F, 0.8));
      break;
    case "brim":
      crown(3, 20, 19, 44);
      fillRect(img, 20, 17, 43, 19, hat.dark);
      fillRect(img, 7, 21, 56, 21, OUTLINE);
      fillRect(img, 8, 22, 55, 23, hat.mid);
      fillRect(img, 8, 24, 55, 24, underside);
      fillRect(img, 7, 25, 56, 25, OUTLINE);
      fillRect(img, 18, 26, 45, 27, shade(pal.F, 0.8));
      break;
    case "kerchief":
      crown(8, 27, 14, 49);
      // Tails of the scarf hanging by the jaw.
      hairSideCloth(img, look, 13, 18, 28, 40);
      hairSideCloth(img, look, 45, 50, 28, 40);
      break;
  }
}

function hairSideCloth(img: PixelImage, look: ResidentLook, x0: number, x1: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1 || y === y1;
      setPixel(img, x, y, edge ? OUTLINE : (x + y) % 5 === 0 ? look.hat.dark : look.hat.mid);
    }
  }
}

function paintFacial(img: PixelImage, look: ResidentLook, pal: Palette): void {
  if (look.facial === "none") return;
  const hairy = (x: number, y: number) => setPixel(img, x, y, (x + y) % 3 === 0 ? pal["1"] : pal["2"]);
  if (look.facial === "beard") {
    // Every skin pixel of the jaw and chin, the mouth box left for `paintMouth`.
    for (let y = 36; y <= 48; y++) {
      for (let x = 18; x <= 45; x++) {
        const p = getPixel(img, x, y);
        const skinPx = p === pal.H || p === pal.P || p === pal.F || p === pal.J || p === pal.I;
        const mouthBox = y >= 39 && y <= 43 && x >= 26 && x <= 37;
        const cheek = y < 39 && (x > 22 && x < 41);
        if (skinPx && !mouthBox && !cheek) hairy(x, y);
      }
    }
    fillRect(img, 26, 48, 37, 48, OUTLINE);
    for (let x = 27; x <= 36; x++) hairy(x, 47);
  }
  // Mustache (the beard grows one too).
  for (let x = 26; x <= 37; x++) {
    setPixel(img, x, 38, x < 28 || x > 35 ? getPixel(img, x, 38) : pal["2"]);
    hairy(x, 39);
  }
}

// ── Expressions ───────────────────────────────────────────────────────────────────────────

/** Mouth box rows 39..43, x 26..37. `.` = face skin. */
const MOUTHS: Record<PortraitMood, readonly string[]> = {
  neutral: ["............", "QQQQRQQRQQQQ", "QRRRRRRRRRRQ", ".SSSSSSSSSS.", "..RRRRRRRR.."],
  happy: ["Q..........Q", ".QQQQQQQQQQ.", ".QKKKKKKKKQ.", "..QRRRRRRQ..", "...SSSSSS..."],
  // Same smile as happy; the blush lives in `paintEyes`.
  smitten: ["Q..........Q", ".QQQQQQQQQQ.", ".QKKKKKKKKQ.", "..QRRRRRRQ..", "...SSSSSS..."],
  sad: ["............", "...QQQQQQ...", "..QRRRRRRQ..", ".Q........Q.", "............"],
  angry: ["............", "............", ".QQQQQQQQQQ.", "..SSSSSSSS..", "............"],
  shocked: ["....QQQQ....", "...QOOOOQ...", "...QOOOOQ...", "....QSSQ....", "............"],
};

function paintMouth(img: PixelImage, look: ResidentLook, pal: Palette, mood: PortraitMood): void {
  const bearded = look.facial !== "none";
  MOUTHS[mood].forEach((row, i) => {
    const y = 39 + i;
    // A mustache covers the top row of the mouth box; don't paint skin over it.
    if (bearded && y === 39 && mood !== "shocked") return;
    for (let j = 0; j < row.length; j++) {
      const ch = row[j];
      const x = 26 + j;
      if (ch === ".") {
        if (!bearded) setPixel(img, x, y, pal.H);
      } else setPixel(img, x, y, pal[ch]);
    }
  });
}

/**
 * Rosy cheeks: { dx from the pupil (+ towards the nose), dy under the pupil row, blend strength }.
 * Mirrors portrait-moods.lua's CHEEK table, so a generated face blushes like the hand-drawn ones.
 */
const CHEEK: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 3, 0.3], [0, 3, 0.5], [1, 3, 0.5], [2, 3, 0.3],
  [-2, 4, 0.3], [-1, 4, 0.55], [0, 4, 0.6], [1, 4, 0.55], [2, 4, 0.3],
  [-1, 5, 0.3], [0, 5, 0.45], [1, 5, 0.3],
];

/** Tint the skin under each eye toward rose. Only skin is tinted, so a beard or outline is never smudged. */
function paintBlush(img: PixelImage, pal: Palette): void {
  const skin = new Set<RGBA>([pal.H, pal.P, pal.F, pal.J, pal.I]);
  for (const { cx, dir } of [{ cx: 23, dir: 1 }, { cx: 40, dir: -1 }]) {
    for (const [dx, dy, k] of CHEEK) {
      const x = cx + dir * dx, y = 32 + dy;
      const p = getPixel(img, x, y);
      if (skin.has(p)) setPixel(img, x, y, mix(p, ROSE, k));
    }
  }
}

/** Eyes are 7 px wide boxes at x 20..26 and 37..43 (lid line row 30, lower lid row 34). */
function paintEyes(img: PixelImage, pal: Palette, mood: PortraitMood): void {
  const eyes = [
    { x0: 20, x1: 26, outer: 20, inner: 26, dir: -1 },
    { x0: 37, x1: 43, outer: 43, inner: 37, dir: 1 },
  ];
  for (const e of eyes) {
    switch (mood) {
      case "happy":
      case "smitten":
        // Squint: the lower lid rises over the bottom eye row.
        for (let x = e.x0 + 1; x <= e.x1 - 1; x++) setPixel(img, x, 33, pal.F);
        break;
      case "sad":
        // Outer corners of the upper lid drop; inner brow ends lift.
        setPixel(img, e.outer, 31, OUTLINE);
        setPixel(img, e.outer - e.dir, 31, OUTLINE);
        for (let k = 0; k < 3; k++) {
          const x = e.inner - e.dir * k;
          setPixel(img, x, 27, pal.G);
          setPixel(img, x, 29, pal.H);
        }
        break;
      case "angry":
        // Glare: inner corners of the lid drop, brows pull down toward the nose.
        setPixel(img, e.inner, 31, OUTLINE);
        setPixel(img, e.inner + e.dir, 31, OUTLINE);
        for (let k = 0; k < 3; k++) setPixel(img, e.inner - e.dir * k, 30, pal.G);
        break;
      case "shocked":
        // Eyes open upward: sclera where the lid line was, the lid a row higher, brows raised.
        for (let x = e.x0 + 1; x <= e.x1 - 1; x++) {
          setPixel(img, x, 30, SCLERA);
          setPixel(img, x, 29, OUTLINE);
          setPixel(img, x, 28, pal.H);
          setPixel(img, x, 27, pal.G);
        }
        break;
      case "neutral":
        break;
    }
  }
  if (mood === "smitten") paintBlush(img, pal);
  if (mood === "angry") {
    setPixel(img, 31, 29, pal.F);
    setPixel(img, 32, 30, pal.F);
  }
  if (mood === "sad") {
    setPixel(img, 21, 35, TEAR_HI);
    setPixel(img, 21, 36, TEAR);
    setPixel(img, 21, 37, TEAR);
  }
}

// ── Clothes ─────────────────────────────────────────────────────────────────────────────────

function paintShoulders(img: PixelImage, look: ResidentLook, pal: Palette): void {
  const { shirt, accent } = look;
  fillRect(img, 4, 53, 59, 53, OUTLINE);
  for (let y = 54; y < PORTRAIT_SIZE; y++) {
    for (let x = 3; x <= 60; x++) {
      const c = x === 3 || x === 60 ? OUTLINE
        : x === 4 || x === 59 ? shade(shirt.dark, 0.6)
          : x === 5 || x === 58 ? shirt.dark
            : y === 54 && ((x > 7 && x < 21) || (x > 42 && x < 56)) ? shirt.light
              : shirt.mid;
      setPixel(img, x, y, c);
    }
  }
  // Front opening x 26..37, lapel lines either side.
  for (let y = 53; y < PORTRAIT_SIZE; y++) {
    setPixel(img, 25, y, OUTLINE);
    setPixel(img, 38, y, OUTLINE);
    for (let x = 26; x <= 37; x++) {
      let c: RGBA = x === 26 || x === 37 ? COLLAR_SHADE : COLLAR;
      if (look.top === "tie" && x >= 30 && x <= 33) c = x === 30 || x === 33 ? accent.dark : y <= 55 ? accent.light : accent.mid;
      if (look.top === "open") {
        if (y <= 56 && x >= 29 && x <= 34 && Math.abs(x - 31.5) < 58 - y) c = y === 56 ? pal.F : pal.P;
        else if (x === 31 && (y === 59 || y === 62)) c = shirt.dark;
      }
      if (look.top === "blouse" && y === 53) c = x % 2 ? COLLAR_SHADE : COLLAR;
      setPixel(img, x, y, c);
    }
  }
  if (look.apron) {
    for (let y = 57; y < PORTRAIT_SIZE; y++) {
      for (let x = 20; x <= 43; x++) {
        setPixel(img, x, y, x === 20 || x === 43 || y === 57 ? OUTLINE : x === 21 || x === 42 ? APRON_SHADE : APRON);
      }
    }
    for (let y = 53; y < 57; y++) {
      setPixel(img, 22, y, APRON);
      setPixel(img, 41, y, APRON);
    }
  }
}

/** One portrait. Neutral is the resting face; the others are what `portraitMood` picks. */
export function drawPortrait(look: ResidentLook, mood: PortraitMood): PixelImage {
  const img = createImage(PORTRAIT_SIZE, PORTRAIT_SIZE);
  const pal = palette(look);
  paintShoulders(img, look, pal);
  FACE.forEach((row, i) => paintRow(img, FACE_Y + i, FACE_X, row, pal));
  paintHair(img, look, pal);
  paintHat(img, look, pal);
  paintFacial(img, look, pal);
  paintEyes(img, pal, mood);
  paintMouth(img, look, pal, mood);
  return img;
}
