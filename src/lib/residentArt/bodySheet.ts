/**
 * Parametric 32×32 resident bodies and their 11-frame walk/idle sheet.
 *
 * The hand-drawn residents share one body template (dump any `public/sprites/agents/<name>.png`
 * as text and the rows line up): an 8-px face at x 12..19 with the eyes on row 9, a 10-px torso
 * from row 15, 1-px arms at x 10 and 21 (rows 17..20, the hand on row 20), legs split by an
 * outline seam at x 15/16, shoes, a closing outline row, then a translucent drop shadow. The
 * templates below reproduce those rows character for character — each string is one row of
 * pixels, each letter a palette slot — and swap in the resident's colours, hair and clothes.
 *
 * The animation is then derived exactly as `scripts/aseprite/agent-sheets.lua` derives the
 * hand-drawn sheets (lift a leg, bob the torso, swing an arm, close the eyes), so a generated
 * resident moves like everyone else. Because we drew the body we know its anatomy, and the
 * script's heuristics (`analyse`, `backView`) become constants and a drawn back view.
 *
 * Frame order is `SHEET_FRAMES` in src/components/canvas/agentFrames.ts.
 */
import { SHEET_FRAME_COUNT, SHEET_FRAME_SIZE } from "../../components/canvas/agentFrames";
import type { ResidentLook } from "./look";
import {
  blit, cloneImage, createImage, getPixel, hex, luma, paintRow, setPixel, shade, type PixelImage, type RGBA,
} from "./pixels";

const S = SHEET_FRAME_SIZE;

/** The art bible's universal outline (same constant as the Lua scripts). */
export const OUTLINE = hex("1a1510");
const EYE_WHITE = hex("f0e2c8");
const PUPIL = hex("1a100a");
const SHADOW_EDGE = hex("0a0806", 0x3c);
const SHADOW = hex("0a0806", 0x6e);
const APRON = hex("e8e4d8");
const APRON_SHADE = hex("c8c4b8");
/** Brim shadow on the cheeks, as on Elena's and James's hats. */
const BRIM_SHADOW = hex("282018", 0xc8);

/** Where the body parts are, for the frame derivations. Mirrors what `analyse` finds. */
export const ANATOMY = {
  eyeRow: 9,
  armTop: 17,
  armBottom: 20,
  /** Outline + arm columns swung by `swingArm`. */
  leftArm: [9, 10] as const,
  rightArm: [21, 22] as const,
  /** First column of the right half (the leg seam is 15 | 16). */
  mid: 16,
} as const;

/** Legs: trousers show long legs, a skirt only its hem-to-shoe stretch. */
export function legRows(look: Pick<ResidentLook, "lower">): { legTop: number; bottom: number } {
  return look.lower === "skirt" ? { legTop: 26, bottom: 28 } : { legTop: 24, bottom: 29 };
}

type Palette = Record<string, RGBA>;

function palette(look: ResidentLook): Palette {
  const { skin, hair, hat, shirt, accent, pants, shoes } = look;
  return {
    O: OUTLINE,
    // skin
    s: skin.shade, k: skin.mid, l: skin.light, h: skin.hi, p: skin.lip, q: skin.lipDark,
    w: EYE_WHITE, e: PUPIL,
    // Lower lashes/brows read as a dark brown on every sprite, even under blonde hair.
    b: luma(hair.dark) > 60 ? shade(hair.dark, 0.5) : hair.dark,
    // hair
    "1": hair.dark, "2": hair.mid, "3": hair.light,
    // hat (7 = the brim's underside)
    "4": hat.dark, "5": hat.mid, "6": hat.light, "7": shade(hat.dark, 0.55), "#": BRIM_SHADOW,
    // shirt, collar, tie
    D: shirt.dark, M: shirt.mid, L: shirt.light, c: EYE_WHITE, C: hex("c8c0b0"),
    T: accent.mid, t: accent.dark,
    // trousers / skirt (v = the inner-leg shadow)
    x: pants.dark, y: pants.mid, z: pants.light, v: shade(pants.dark, 0.55),
    // shoes
    f: shoes.mid, g: shoes.dark,
    a: APRON, A: APRON_SHADE,
    "-": SHADOW_EDGE, "~": SHADOW,
  };
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────
// [y, x0, row]. Rows are copied from the hand-drawn sprites (Thomas for the face and suit,
// Rosa/Yuki for the skirt) with their colours replaced by palette slots.

type Rows = ReadonlyArray<readonly [number, number, string]>;

const HEAD: Rows = [
  [5, 13, "OOOOOO"],
  [6, 12, "OkkllkkO"],
  [7, 12, "OkkkkkkO"],
  [8, 12, "skkkkkks"],
  [9, 12, "kkwekwek"],
  [10, 13, "bbllbb"],
  [11, 12, "sllhhlls"],
  [12, 12, "OklpqlkO"],
  [13, 13, "OkkkkO"],
  [14, 14, "OssO"],
];

/** The torso; `P`/`Q` are the two placket columns (x 15, 16), `R` the collar tips (x 14, 17). */
const TORSO: Rows = [
  [15, 11, "ODMRPQRMDO"],
  [16, 10, "OOMLDPQDLMOO"],
  [17, 9, "ODOMDLPQLDMODO"],
  [18, 9, "OMODMDPQDMDOMO"],
  [19, 9, "ODOMLLPQLLMODO"],
  [20, 9, "OkODDMPQMDDOkO"],
];

const TROUSERS: Rows = [
  [21, 10, "OOyzyyyyzyOO"],
  [22, 12, "OyzyyzyO"],
  [23, 12, "OxyxxyxO"],
  [24, 12, "OyxOOxyO"],
  [25, 12, "OxvOOvxO"],
  [26, 12, "OxvOOvxO"],
  [27, 12, "OfgOOgfO"],
  [28, 12, "OggOOggO"],
  [29, 12, "OOOOOOOO"],
  [30, 11, "-~~~~~~~~-"],
  [31, 12, "-.-.-.--"],
];

const SKIRT: Rows = [
  [21, 10, "OOyzyyyyzyOO"],
  [22, 11, "OyzyyyyzyO"],
  [23, 10, "OxyzyyyyzyxO"],
  [24, 10, "OxxyxxxxyxxO"],
  [25, 10, "OOOOOOOOOOOO"],
  [26, 12, "OfgOOgfO"],
  [27, 12, "OggOOggO"],
  [28, 12, "OOOOOOOO"],
  [30, 11, "-~~~~~~~~-"],
  [31, 12, "-.-.-.--"],
];

/** Placket fill per top style: collar tips (R), placket left (P) and right (Q) by row. */
function placket(look: ResidentLook, row: number): Palette {
  const pal = palette(look);
  switch (look.top) {
    case "tie":
      return { R: pal.c, P: pal.T, Q: pal.t };
    case "open":
      // Open collar: skin at the throat, then a button line down the front.
      return row === 15 ? { R: pal.c, P: pal.k, Q: pal.s } : { R: pal.L, P: row % 2 ? pal.c : pal.M, Q: pal.D };
    case "blouse":
      return row === 15 ? { R: pal.C, P: pal.c, Q: pal.c } : { R: row === 16 ? pal.D : pal.L, P: pal.c, Q: pal.C };
  }
}

function paintRows(img: PixelImage, rows: Rows, pal: Palette): void {
  for (const [y, x0, row] of rows) paintRow(img, y, x0, row, pal);
}

// ── Hair and hats ────────────────────────────────────────────────────────────────────────────

function paintHairFront(img: PixelImage, look: ResidentLook, pal: Palette): void {
  const rows: Record<ResidentLook["hairStyle"], Rows> = {
    short: [
      [5, 13, "OOOOOO"],
      [6, 12, "O223322O"],
      [7, 12, "O122221O"],
      [8, 12, "1......1"],
    ],
    swept: [
      [5, 13, "OOOOOO"],
      [6, 12, "O123322O"],
      [7, 11, "O22222232O"],
      [8, 11, "21......12"],
    ],
    receding: [
      [7, 12, "2......2"],
      [8, 12, "1......1"],
      [9, 12, "2......2"],
    ],
    bun: [
      [2, 14, "OOOO"],
      [3, 13, "O2332O"],
      [4, 13, "O1221O"],
      [5, 13, "O1111O"],
      [6, 12, "O223322O"],
      [7, 12, "21222212"],
      [8, 12, "1......1"],
    ],
    long: [
      [5, 13, "OOOOOO"],
      [6, 12, "O223322O"],
      [7, 11, "O21222212O"],
      [8, 10, "O12......21O"],
      [9, 10, "O12......21O"],
      [10, 10, "O12......21O"],
      [11, 10, "O12......21O"],
      [12, 10, "O12......21O"],
      [13, 10, "O12......21O"],
      [14, 11, "O11....11O"],
      [15, 12, "1......1"],
    ],
    bob: [
      [5, 13, "OOOOOO"],
      [6, 12, "O223322O"],
      [7, 11, "O21222212O"],
      [8, 10, "O12......21O"],
      [9, 10, "O12......21O"],
      [10, 10, "O12......21O"],
      [11, 10, "O11......11O"],
      [12, 11, "OO......OO"],
    ],
  };
  paintRows(img, rows[look.hairStyle], pal);
}

function paintHat(img: PixelImage, look: ResidentLook, pal: Palette, back: boolean): void {
  const rows: Record<Exclude<ResidentLook["headwear"], "none">, Rows> = {
    // Carlos's flat cap: crown, a dark brim underside, hair tufts below it.
    cap: [
      [3, 13, "OOOOOO"],
      [4, 12, "O666666O"],
      [5, 12, "O455554O"],
      [6, 11, "O47777774O"],
      [7, 11, "O74444447O"],
      [8, 11, "12......21"],
    ],
    // Elena's and James's brimmed hat: tall crown, band, a brim two columns past the head.
    brim: [
      [2, 13, "OOOOOO"],
      [3, 12, "O665566O"],
      [4, 12, "O555555O"],
      [5, 12, "O444444O"],
      [6, 9, "O455555555554O"],
      [7, 9, "O744444444447O"],
      [8, 10, "#.1......1.#"],
    ],
    kerchief: [
      [4, 13, "OOOOOO"],
      [5, 12, "O556655O"],
      [6, 11, "O45555554O"],
      [7, 11, "O44555544O"],
      [8, 11, "O4......4O"],
    ],
  };
  if (look.headwear === "none") return;
  paintRows(img, rows[look.headwear], pal);
  // Brims and caps shade the forehead (Carlos's is a full shade darker than his cheeks).
  if (!back && look.headwear !== "kerchief") paintRow(img, 8, 13, "ssssss", pal);
}

function paintFacial(img: PixelImage, look: ResidentLook, pal: Palette): void {
  if (look.facial === "mustache") paintRow(img, 12, 12, "Ok2112kO", pal);
  if (look.facial === "beard") {
    // James's beard: sideburns into the jaw, the mouth a single dark pixel.
    paintRow(img, 11, 12, "2......2", pal);
    paintRow(img, 12, 12, "O22q222O", pal);
    paintRow(img, 13, 13, "O2112O", pal);
    paintRow(img, 14, 14, "O22O", pal);
  }
}

function paintApron(img: PixelImage, look: ResidentLook, pal: Palette): void {
  // Bib and skirt of a work apron over the clothes (Priya, the bakers), hem above the leg split.
  paintRow(img, 16, 14, "aaaa", pal);
  for (let y = 17; y <= 19; y++) paintRow(img, y, 14, "aaaa", pal);
  paintRow(img, 20, 13, "aaaaaa", pal);
  const hem = look.lower === "skirt" ? 24 : 23;
  for (let y = 21; y < hem; y++) paintRow(img, y, 13, "Aaaaaa", pal);
  paintRow(img, hem, 13, "AAAAAA", pal);
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────

function paintBodyBelowHead(img: PixelImage, look: ResidentLook, pal: Palette): void {
  for (const [y, x0, row] of TORSO) paintRow(img, y, x0, row, { ...pal, ...placket(look, y) });
  paintRows(img, look.lower === "skirt" ? SKIRT : TROUSERS, pal);
}

/** Face to camera: the idle frame every other frame is derived from. */
export function drawFront(look: ResidentLook): PixelImage {
  const img = createImage(S, S);
  const pal = palette(look);
  paintRows(img, HEAD, pal);
  paintBodyBelowHead(img, look, pal);
  paintHairFront(img, look, pal);
  paintFacial(img, look, pal);
  paintHat(img, look, pal, false);
  if (look.apron) paintApron(img, look, pal);
  return img;
}

/**
 * Back to camera. Drawn rather than guessed: the head interior becomes hair (a skin crown for a
 * receding hairline), the nape shows under it, and the torso loses its collar, tie and apron —
 * only the apron strings tied at the waist show from behind (the thing C12 notes the Lua
 * `backView` can't do for Priya).
 */
export function drawBack(look: ResidentLook): PixelImage {
  const img = createImage(S, S);
  const pal = palette(look);
  paintRows(img, HEAD, pal);
  paintBodyBelowHead(img, look, pal);
  // Back of the shirt: plain cloth with the side shading of the front.
  paintRow(img, 15, 11, "ODMMMMMMDO", pal);
  for (let y = 16; y <= 19; y++) paintRow(img, y, 12, "MLMMMMLM", pal);
  paintRow(img, 20, 12, "DDMMMMDD", pal);
  if (look.apron) paintRow(img, 20, 12, "aaaAAaaa", pal);
  paintHairFront(img, look, pal);
  const bald = look.hairStyle === "receding";
  for (let y = 6; y <= 12; y++) {
    for (let x = 12; x <= 19; x++) {
      const p = getPixel(img, x, y);
      if (p === 0 || p === OUTLINE) continue;
      const crown = bald && y <= 7;
      setPixel(img, x, y, crown ? pal.k : y === 12 ? pal["1"] : y <= 7 && (x === 15 || x === 16) ? pal["3"] : pal["2"]);
    }
  }
  paintRow(img, 13, 13, "OkkkkO", pal);
  const longHair = look.hairStyle === "long" || look.hairStyle === "bob";
  if (longHair) paintRow(img, 13, 13, "O2222O", pal);
  if (look.hairStyle === "long") {
    paintRow(img, 14, 14, "O22O", pal);
    paintRow(img, 15, 13, "212212", pal);
    paintRow(img, 16, 14, "1111", pal);
  }
  if (look.hairStyle === "bun") paintRow(img, 5, 14, "2332", pal);
  paintHat(img, look, pal, true);
  return img;
}

// ── Frame derivations (ports of agent-sheets.lua) ───────────────────────────────────────────

/** Shift one leg's rows up by `dy`: the leg foreshortens, the vacated rows go transparent. */
export function liftLeg(img: PixelImage, legTop: number, bottom: number, side: "left" | "right", dy = 1): PixelImage {
  const out = cloneImage(img);
  const [x0, x1] = side === "left" ? [0, ANATOMY.mid - 1] : [ANATOMY.mid, S - 1];
  for (let y = legTop; y <= bottom; y++) {
    for (let x = x0; x <= x1; x++) {
      const src = y + dy;
      setPixel(out, x, y, src <= bottom ? getPixel(img, x, src) : 0);
    }
  }
  return out;
}

/** Contact frame: everything above `legTop` drops `dy` px, the torso covering the knees. */
export function bob(img: PixelImage, legTop: number, dy = 1): PixelImage {
  const out = cloneImage(img);
  for (let y = legTop - 1; y >= 0; y--) {
    for (let x = 0; x < S; x++) setPixel(out, x, y + dy, getPixel(img, x, y));
  }
  for (let y = 0; y < dy; y++) for (let x = 0; x < S; x++) setPixel(out, x, y, 0);
  return out;
}

/** Hand drops `dy` px = the arm swings toward the camera. */
export function swingArm(img: PixelImage, side: "left" | "right", dy = 1): PixelImage {
  const out = cloneImage(img);
  const [x0, x1] = side === "left" ? ANATOMY.leftArm : ANATOMY.rightArm;
  for (let y = ANATOMY.armBottom + dy; y >= ANATOMY.armTop + dy; y--) {
    for (let x = x0; x <= x1; x++) setPixel(out, x, y, getPixel(img, x, y - dy));
  }
  return out;
}

/** Closed lids: pupils become a dark skin line, eye whites become skin. */
export function blink(img: PixelImage, look: ResidentLook): PixelImage {
  const out = cloneImage(img);
  const y = ANATOMY.eyeRow;
  for (let x = 12; x <= 19; x++) {
    const p = getPixel(img, x, y);
    if (p === PUPIL) setPixel(out, x, y, look.skin.shade);
    else if (p === EYE_WHITE) setPixel(out, x, y, look.skin.mid);
  }
  return out;
}

function walkCycle(base: PixelImage, legTop: number, bottom: number): PixelImage[] {
  // lift L (right arm forward) · contact · lift R (left arm forward) · contact
  return [
    swingArm(liftLeg(base, legTop, bottom, "left"), "right"),
    bob(base, legTop),
    swingArm(liftLeg(base, legTop, bottom, "right"), "left"),
    bob(base, legTop),
  ];
}

/** The 11 frames, in `SHEET_FRAMES` order. */
export function bodyFrames(look: ResidentLook): PixelImage[] {
  const { legTop, bottom } = legRows(look);
  const front = drawFront(look);
  const back = drawBack(look);
  return [front, blink(front, look), ...walkCycle(front, legTop, bottom), back, ...walkCycle(back, legTop, bottom)];
}

/** A horizontal strip, the same layout as `<name>_sheet.png`. */
export function buildBodySheet(look: ResidentLook): PixelImage {
  const frames = bodyFrames(look);
  const strip = createImage(S * SHEET_FRAME_COUNT, S);
  frames.forEach((f, i) => blit(strip, f, i * S, 0));
  return strip;
}
