/**
 * What a generated resident looks like, picked deterministically from their name.
 *
 * The 13 founding residents have hand-drawn sprites; anyone else (a nudged "New Resident",
 * a wizard custom name) used to render as a grey circle because there was no PNG for their
 * sprite key. The body and portrait generators draw them from a `ResidentLook` instead, and
 * everything here is a pure function of (name, gender, age) so the same person looks the same on
 * the map, in the cast bar and in the side panel, on every client and after every reload —
 * nothing is stored.
 *
 * Every colour below is lifted from the hand-drawn art (dump a base PNG and you will find these
 * hexes), so generated residents sit in the same muted, ~1900 palette instead of looking like
 * visitors from another game.
 */
import { hex, type RGBA } from "./pixels";

export interface LookHints {
  gender?: string | null;
  age?: number | null;
}

/** shade (edges, neck) · mid · light · highlight (nose/cheek) · lips. */
export interface SkinRamp {
  shade: RGBA;
  mid: RGBA;
  light: RGBA;
  hi: RGBA;
  lip: RGBA;
  lipDark: RGBA;
}

export interface Ramp {
  dark: RGBA;
  mid: RGBA;
  light: RGBA;
}

export type HairStyle = "short" | "swept" | "receding" | "bun" | "long" | "bob";
export type Headwear = "none" | "cap" | "brim" | "kerchief";
export type Facial = "none" | "mustache" | "beard";
/** `tie` = shirt and tie, `open` = open collar, `blouse` = cream front panel. */
export type TopStyle = "tie" | "open" | "blouse";
export type LowerStyle = "trousers" | "skirt";

export interface ResidentLook {
  skin: SkinRamp;
  hair: Ramp;
  hairStyle: HairStyle;
  headwear: Headwear;
  hat: Ramp;
  facial: Facial;
  top: TopStyle;
  shirt: Ramp;
  /** Tie / scarf. */
  accent: Ramp;
  apron: boolean;
  lower: LowerStyle;
  pants: Ramp;
  shoes: Ramp;
  /** Portrait iris. */
  iris: RGBA;
}

const ramp = (dark: string, mid: string, light: string): Ramp => ({
  dark: hex(dark),
  mid: hex(mid),
  light: hex(light),
});
const skin = (s: string, m: string, l: string, h: string, lip: string, lipDark: string): SkinRamp => ({
  shade: hex(s),
  mid: hex(m),
  light: hex(l),
  hi: hex(h),
  lip: hex(lip),
  lipDark: hex(lipDark),
});

// Named after whose sprite each ramp was sampled from, so a palette tweak can be checked
// against the original.
export const SKINS: readonly SkinRamp[] = [
  skin("96664a", "c4926a", "dcac80", "eec498", "b46e5e", "8a4036"), // Elena
  skin("9a6e50", "c89872", "e0b890", "f0d4b0", "b87060", "8a4838"), // Thomas, Rosa
  skin("a88060", "d4ad8c", "e8ccb0", "fae4cc", "c47868", "9a5040"), // Sofia
  skin("6c5030", "a07848", "c8986c", "e0b88c", "a85848", "783828"), // Carlos
  skin("8a5038", "b87858", "d8a080", "f0c8a0", "c05848", "8a3828"), // Ray
  skin("4a3020", "754e36", "9a6d4c", "b88968", "784028", "5a2818"), // Priya, Omar
  skin("38241a", "5a3a28", "7a5238", "966a4c", "6a3020", "4a1c12"),
];

export const HAIRS: readonly Ramp[] = [
  ramp("140a06", "2a1810", "3a2418"), // black
  ramp("2a1a10", "4a3828", "5a4228"), // dark brown
  ramp("3f2816", "55391f", "6a4830"), // brown
  ramp("4a2010", "7a3a1c", "9a5028"), // chestnut
  ramp("5a2010", "8a3818", "b05a28"), // auburn
  ramp("8a6828", "d0b060", "f0d888"), // blonde
  ramp("6a5030", "9a7a48", "c0a068"), // sandy
];
const GREY_HAIR = ramp("6a6660", "9a9088", "b8b0a4");
const WHITE_HAIR = ramp("a8a098", "d8d4c8", "f0ece0");

const SHIRTS: readonly Ramp[] = [
  ramp("182848", "283858", "3a486a"), // navy
  ramp("2a4260", "3a5e88", "4a7ab0"), // blue
  ramp("1e3a58", "2a5078", "3e6c98"), // denim
  ramp("4a101c", "6a1a2a", "8a2a3a"), // maroon
  ramp("601818", "8a2420", "a8382c"), // red
  ramp("364624", "547238", "6c8e48"), // forest
  ramp("4a4a28", "6a6a38", "8a8a4c"), // olive
  ramp("2a1848", "4a2a68", "6a4088"), // purple
  ramp("3a1a10", "5e3020", "7e4434"), // brown
  ramp("6a5030", "8a6c44", "a88a58"), // tan
  ramp("9a7020", "c8a04a", "e8c848"), // mustard
  ramp("5a5850", "8a8880", "b0a898"), // grey
];

const ACCENTS: readonly Ramp[] = [
  ramp("501010", "a02828", "c83838"),
  ramp("283820", "4a6a38", "6c8e48"),
  ramp("0e2040", "2a4260", "3a5e88"),
  ramp("9a7020", "c8a04a", "e8c848"),
];

const PANTS: readonly Ramp[] = [
  ramp("0a1828", "1a2840", "2a3858"), // navy
  ramp("2a1a10", "4e3824", "6a5038"), // brown
  ramp("1a1816", "2e2c2a", "44403a"), // charcoal
  ramp("1a2838", "283e5a", "3a5a88"), // denim
  ramp("4a3a20", "6a5838", "8a7450"), // tan
  ramp("3a3a38", "5a5850", "7a7870"), // grey
];

const SKIRTS: readonly Ramp[] = [
  ramp("2a0810", "4a101c", "6a1a2a"),
  ramp("0a1828", "1a2840", "2a3858"),
  ramp("2a1a10", "4e3824", "6a5038"),
  ramp("283820", "364624", "547238"),
  ramp("1a1030", "2a1848", "4a2a68"),
  ramp("3a3a38", "5a5850", "7a7870"),
  ramp("1a2838", "283e5a", "3a5a88"),
];

const SHOES: readonly Ramp[] = [
  ramp("0a0604", "1a100a", "2a1810"),
  ramp("1e1208", "3e2814", "5a3c20"),
];

const CAPS: readonly Ramp[] = [
  ramp("283820", "3a5028", "4a6a38"),
  ramp("3a2818", "5a4228", "7a5a38"),
  ramp("2e2c2a", "44403a", "5a5850"),
  ramp("0e2040", "1a3050", "2a4260"),
];
const BRIMS: readonly Ramp[] = [
  ramp("6e522a", "c8a45c", "e8c478"), // straw
  ramp("140e0a", "2a1810", "3a2a20"), // black felt
  ramp("3f2816", "55391f", "6a4830"), // brown felt
];
const KERCHIEFS: readonly Ramp[] = [
  ramp("b0a898", "d8d0c0", "e8e0d0"),
  ramp("601818", "9a3020", "c05040"),
  ramp("2a4260", "3a5e88", "4a7ab0"),
];

const IRISES: readonly RGBA[] = [hex("6a4828"), hex("3a2818"), hex("2a4828"), hex("3a5a82"), hex("5a4a38")];

/**
 * Sprite keys that never have a PNG behind them: the nudge's "New Resident" is stored with
 * `sprite_sheet`/`portrait_sprite` = "default", and a row could in principle carry an empty one.
 * The client draws these straight from the generator instead of first waiting on two 404s.
 * (Wizard custom names get a real-looking slug, so they still try the network and fall back.)
 */
export function isPlaceholderSpriteKey(key: string | null | undefined): boolean {
  return !key || key === "default";
}

/** FNV-1a: stable across browsers and Node, unlike anything built on `Math.random`. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — a small, well-mixed 32-bit PRNG; returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, list: readonly T[]): T {
  return list[Math.floor(rnd() * list.length) % list.length];
}

/**
 * The look for a resident. `gender` and `age` only steer the odds (skirts and buns for women,
 * beards and receding hairlines for older men, grey hair with age); the dice come from the name.
 * Residents nudged in before server/lib/newResident.ts were stored as gender "neutral", age 25,
 * which draws from the full wardrobe; newer ones get a real gender and an age for their job.
 *
 * Every roll is taken unconditionally and in a fixed order, so changing one rule (say, the beard
 * odds) doesn't reshuffle everyone's shirt colour.
 */
export function residentLook(name: string, hints: LookHints = {}): ResidentLook {
  const rnd = mulberry32(hashString(name.trim().toLowerCase()));
  const g = (hints.gender ?? "").toLowerCase();
  const female = g === "female" || g === "woman" || g === "f";
  const male = g === "male" || g === "man" || g === "m";
  const age = hints.age ?? 30;

  const rSkin = rnd(), rHair = rnd(), rGrey = rnd(), rStyle = rnd(), rHead = rnd(), rHat = rnd();
  const rFacial = rnd(), rTop = rnd(), rShirt = rnd(), rAccent = rnd(), rApron = rnd();
  const rLower = rnd(), rPants = rnd(), rShoes = rnd(), rIris = rnd();
  const at = <T>(r: number, list: readonly T[]) => pick(() => r, list);

  const greyOdds = age >= 60 ? 0.9 : age >= 48 ? 0.4 : 0;
  const hair = rGrey < greyOdds ? (age >= 68 && rGrey < 0.45 ? WHITE_HAIR : GREY_HAIR) : at(rHair, HAIRS);

  const styles: readonly HairStyle[] = female
    ? ["bun", "long", "bob", "long", "bun"]
    : male
      ? age >= 45
        ? ["short", "swept", "receding", "receding"]
        : ["short", "swept", "short"]
      : ["short", "swept", "bob", "long", "bun"];
  const hairStyle = at(rStyle, styles);

  // Receding hairlines keep their bare crown on show more often than not.
  const hatChance = hairStyle === "receding" ? 0.25 : 0.35;
  const hats: readonly Headwear[] = female ? ["brim", "kerchief"] : male ? ["cap", "brim"] : ["cap", "brim", "kerchief"];
  const headwear: Headwear = rHead < hatChance ? at(rHead / hatChance, hats) : "none";
  const hat = headwear === "cap" ? at(rHat, CAPS) : headwear === "kerchief" ? at(rHat, KERCHIEFS) : at(rHat, BRIMS);

  const facial: Facial = male && age >= 22 && rFacial < 0.4 ? (rFacial < 0.18 ? "mustache" : "beard") : "none";

  const tops: readonly TopStyle[] = female ? ["blouse", "open", "blouse"] : male ? ["tie", "open", "tie"] : ["tie", "open", "blouse"];
  const lower: LowerStyle = (female ? rLower < 0.75 : !male && rLower < 0.25) ? "skirt" : "trousers";

  return {
    skin: at(rSkin, SKINS),
    hair,
    hairStyle,
    headwear,
    hat,
    facial,
    top: at(rTop, tops),
    shirt: at(rShirt, SHIRTS),
    accent: at(rAccent, ACCENTS),
    apron: rApron < 0.2,
    lower,
    pants: lower === "skirt" ? at(rPants, SKIRTS) : at(rPants, PANTS),
    shoes: at(rShoes, SHOES),
    iris: at(rIris, IRISES),
  };
}
