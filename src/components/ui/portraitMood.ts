// Which expression a resident's portrait wears. Pure so it can be unit-tested; the art comes from
// scripts/aseprite/portrait-moods.lua (`<portrait>_<mood>.png`, neutral being the original file).

export type PortraitMood = "neutral" | "happy" | "sad" | "angry" | "shocked";

/** Every expression the art script produces. */
export const PORTRAIT_MOODS: readonly PortraitMood[] = ["neutral", "happy", "sad", "angry", "shocked"];

// Thresholds sit outside the "fine" band of the 0..100 mood need so an ordinary day stays neutral.
const SAD_BELOW = 25;
const HAPPY_ABOVE = 75;

const ANGRY_STATES = new Set(["angry", "jealous"]);
const SAD_STATES = new Set(["heartbroken", "grieving", "depressed", "guilty"]);
const HAPPY_STATES = new Set(["euphoric", "infatuated", "afterglow"]);
const SHOCKED_STATES = new Set(["arrested"]);

/**
 * Precedence: shocked (a sharp, rare event) > angry > sad > happy > neutral. A state always beats
 * the mood number, so a grieving resident with a decent mood still looks sad, and sad beats happy
 * when both apply because the heavier feeling is the one you'd read on a face.
 */
export function portraitMood(
  mood: number | undefined,
  states: ReadonlyArray<{ type: string }> | undefined,
): PortraitMood {
  const types = new Set((states ?? []).map((s) => s.type));
  const has = (set: Set<string>) => {
    for (const t of types) if (set.has(t)) return true;
    return false;
  };
  if (has(SHOCKED_STATES)) return "shocked";
  if (has(ANGRY_STATES)) return "angry";
  if (has(SAD_STATES)) return "sad";
  if (has(HAPPY_STATES)) return "happy";
  if (mood !== undefined) {
    if (mood < SAD_BELOW) return "sad";
    if (mood > HAPPY_ABOVE) return "happy";
  }
  return "neutral";
}

/** URL of the portrait for a mood; `spriteKey` is `agent.portrait_sprite` (e.g. `rosa_chen_portrait`). */
export function portraitSrc(spriteKey: string, mood: PortraitMood): string {
  return `/sprites/agents/${spriteKey}${mood === "neutral" ? "" : `_${mood}`}.png`;
}
