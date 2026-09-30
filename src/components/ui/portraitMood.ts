// Which expression a resident's portrait wears. Pure so it can be unit-tested; the art comes from
// scripts/aseprite/portrait-moods.lua (`<portrait>_<mood>.png`, neutral being the original file).

import { styleOf } from "../../lib/stateStyle";

export type PortraitMood = "neutral" | "happy" | "sad" | "angry" | "shocked" | "smitten";

/** Every expression the art script produces. */
export const PORTRAIT_MOODS: readonly PortraitMood[] = ["neutral", "happy", "sad", "angry", "shocked", "smitten"];

// Thresholds sit outside the "fine" band of the 0..100 mood need so an ordinary day stays neutral.
const SAD_BELOW = 25;
const HAPPY_ABOVE = 75;

// Which expression each state wears lives in STATE_STYLE (src/lib/stateStyle.ts), next to its ring
// and emote. This list is only the tie-break when a resident has states pointing at different faces.
// Shocked is a sharp, rare event; smitten (infatuation, the morning after a tryst) sits above plain
// happy so a resident who is both euphoric and in love shows the blush, but under every heavier feeling.
const MOOD_PRECEDENCE: readonly PortraitMood[] = ["shocked", "angry", "sad", "smitten", "happy"];

/**
 * Precedence: shocked (a sharp, rare event) > angry > sad > smitten > happy > neutral. A state always beats
 * the mood number, so a grieving resident with a decent mood still looks sad, and sad beats happy
 * when both apply because the heavier feeling is the one you'd read on a face.
 */
export function portraitMood(
  mood: number | undefined,
  states: ReadonlyArray<{ type: string }> | undefined,
): PortraitMood {
  if (states && states.length > 0) {
    const wanted = new Set<PortraitMood>();
    for (const s of states) {
      const m = styleOf(s.type)?.portrait;
      if (m) wanted.add(m);
    }
    for (const m of MOOD_PRECEDENCE) if (wanted.has(m)) return m;
  }
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
