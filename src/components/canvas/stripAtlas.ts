import * as PIXI from "pixi.js";

/**
 * Loads a horizontal strip of square frames (the layout every Aseprite script in
 * `scripts/aseprite/` exports) and slices it into textures sharing one source.
 * One promise per URL; a failed load is dropped so a later call can retry.
 */
const cache = new Map<string, Promise<PIXI.Texture[]>>();

export function loadStrip(url: string, frameCount: number, frameSize = 32): Promise<PIXI.Texture[]> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = PIXI.Assets.load<PIXI.Texture>(url).then(tex => {
    // Vite answers a missing public file with index.html, which may not reject — check
    // the shape so a bogus texture never gets sliced into garbage frames.
    if (tex.width !== frameSize * frameCount || tex.height !== frameSize) {
      throw new Error(`strip ${url} is ${tex.width}x${tex.height}`);
    }
    tex.source.scaleMode = 'nearest';
    return Array.from({ length: frameCount }, (_, i) => new PIXI.Texture({
      source: tex.source,
      frame: new PIXI.Rectangle(i * frameSize, 0, frameSize, frameSize),
    }));
  }).catch(err => {
    cache.delete(url);
    throw err;
  });
  cache.set(url, p);
  return p;
}
