import { residentLook } from "../../lib/residentArt/look";
import { drawPortrait } from "../../lib/residentArt/portrait";
import type { PortraitMood } from "./portraitMood";

/** The fields of an agent row the generated look depends on (same as the map sprite's). */
interface PortraitAgent {
  name: string;
  gender?: string | null;
  age?: number | null;
}

// Data URLs are ~1-2 KB each; five moods × a handful of generated residents per session.
const cache = new Map<string, string>();

/**
 * A PNG data URL of the generated portrait for residents without a hand-drawn
 * `<key>_portrait.png` — so MiniPortrait / AgentPortrait show a face (in the right mood)
 * instead of a coloured initial. Null where there is no 2D canvas, and the caller keeps its
 * letter tile.
 */
export function generatedPortraitSrc(agent: PortraitAgent, mood: PortraitMood): string | null {
  const key = `${agent.name.trim().toLowerCase()}|${agent.gender ?? ""}|${agent.age ?? ""}|${mood}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (typeof document === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const img = drawPortrait(residentLook(agent.name, { gender: agent.gender, age: agent.age }), mood);
  ctx.canvas.width = img.w;
  ctx.canvas.height = img.h;
  ctx.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  const url = ctx.canvas.toDataURL("image/png");
  cache.set(key, url);
  return url;
}
