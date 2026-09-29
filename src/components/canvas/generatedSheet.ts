import * as PIXI from "pixi.js";
import { buildBodySheet } from "../../lib/residentArt/bodySheet";
import { residentLook, type LookHints } from "../../lib/residentArt/look";
import { SHEET_FRAME_COUNT, SHEET_FRAME_SIZE } from "./agentFrames";

/**
 * Animation frames for a resident with no hand-drawn sheet, drawn by the parametric generator
 * (src/lib/residentArt) into a canvas once per look and sliced exactly like a loaded
 * `<key>_sheet.png`, so AgentSprite animates it with the same `pickAgentFrame` table.
 *
 * Cached for the page's lifetime: a look is ~45 KB of texture and a world has a handful of
 * generated residents, and a world replace rebuilds the sprite pool but not these.
 */
const cache = new Map<string, PIXI.Texture[]>();

export function generatedAgentSheet(name: string, hints: LookHints = {}): PIXI.Texture[] {
  const key = `${name.trim().toLowerCase()}|${hints.gender ?? ""}|${hints.age ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const strip = buildBodySheet(residentLook(name, hints));
  const canvas = document.createElement("canvas");
  canvas.width = strip.w;
  canvas.height = strip.h;
  canvas.getContext("2d")!.putImageData(new ImageData(strip.data, strip.w, strip.h), 0, 0);
  const tex = PIXI.Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  const frames = Array.from({ length: SHEET_FRAME_COUNT }, (_, i) => new PIXI.Texture({
    source: tex.source,
    frame: new PIXI.Rectangle(i * SHEET_FRAME_SIZE, 0, SHEET_FRAME_SIZE, SHEET_FRAME_SIZE),
  }));
  cache.set(key, frames);
  return frames;
}
