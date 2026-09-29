import * as PIXI from "pixi.js";
import { SHEET_FRAME_COUNT, SHEET_FRAME_SIZE } from "./agentFrames";

/**
 * Loads `/sprites/agents/<key>_sheet.png` and slices it into per-frame textures that
 * share the sheet's source. One promise per key: all sprites of the same agent (a world
 * reload rebuilds the pool) reuse the same frames.
 */
const cache = new Map<string, Promise<PIXI.Texture[]>>();

export function loadAgentSheet(spriteKey: string): Promise<PIXI.Texture[]> {
  const hit = cache.get(spriteKey);
  if (hit) return hit;
  const url = `/sprites/agents/${spriteKey}_sheet.png`;
  const p = PIXI.Assets.load<PIXI.Texture>(url).then(tex => {
    // Vite answers a missing public file with index.html, which may not reject — check
    // the shape so a bogus texture never gets sliced into garbage frames.
    if (tex.width !== SHEET_FRAME_SIZE * SHEET_FRAME_COUNT || tex.height !== SHEET_FRAME_SIZE) {
      throw new Error(`agent sheet ${url} is ${tex.width}x${tex.height}`);
    }
    tex.source.scaleMode = 'nearest';
    return Array.from({ length: SHEET_FRAME_COUNT }, (_, i) => new PIXI.Texture({
      source: tex.source,
      frame: new PIXI.Rectangle(i * SHEET_FRAME_SIZE, 0, SHEET_FRAME_SIZE, SHEET_FRAME_SIZE),
    }));
  }).catch(err => {
    // Drop the rejection so a later sprite can retry (e.g. the sheet was generated
    // while the page was open).
    cache.delete(spriteKey);
    throw err;
  });
  cache.set(spriteKey, p);
  return p;
}
