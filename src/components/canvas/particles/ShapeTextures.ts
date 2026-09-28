import * as PIXI from 'pixi.js';
import type { ParticleShape } from './types';

/**
 * Loads Kenney particle textures (CC0 license) and maps them to particle shapes.
 *
 * The Kenney pack provides 5 soft-glow circle variants (512x512, white on transparent);
 * the first four are used.
 * These are the industry standard for particle effects — they look beautiful when
 * tinted, scaled, and layered. Different shapes reuse the same glow textures at
 * different scales and with programmatic overlays for variety.
 *
 * Textures loaded from /particles/*.png (Vite serves from public/).
 */

const KENNEY_TEXTURES = [
  '/particles/circle_01.png', // soft round glow
  '/particles/circle_02.png', // harder edge glow
  '/particles/circle_03.png', // large soft glow
  '/particles/circle_04.png', // medium sharp glow
  // circle_05 (small tight glow) was only ever the 'raindrop' shape, which went
  // with the duplicate rain profile — WeatherEffects draws all precipitation.
];

// Fallback: programmatic textures if images fail to load
// Match Kenney texture size (512x512) so scale values produce consistent visual sizes
const FALLBACK_SIZE = 128;

function createFallbackTexture(renderer: PIXI.Renderer, drawFn: (g: PIXI.Graphics) => void): PIXI.Texture {
  const g = new PIXI.Graphics();
  drawFn(g);
  const rt = PIXI.RenderTexture.create({ width: FALLBACK_SIZE, height: FALLBACK_SIZE });
  renderer.render({ container: g, target: rt });
  g.destroy();
  return rt;
}

/**
 * Create shape textures. Uses Kenney PNGs for primary shapes,
 * programmatic fallbacks for specialty shapes (heart, star, note).
 */
export async function createShapeTextures(
  renderer: PIXI.Renderer,
): Promise<{ textures: Map<ParticleShape, PIXI.Texture>; owned: PIXI.Texture[] }> {
  const textures = new Map<ParticleShape, PIXI.Texture>();
  // Only the RenderTextures built here may be destroyed by the engine. The
  // Kenney textures belong to the global `Assets` cache, and destroying those
  // leaves the cache handing out dead textures on the next mount.
  const owned: PIXI.Texture[] = [];
  const own = <T extends PIXI.Texture>(t: T): T => {
    owned.push(t);
    return t;
  };

  // Load Kenney textures. Assigned by index, never pushed: the shape mapping
  // below is positional, so a single failed PNG used to shift every later shape
  // onto the wrong texture instead of leaving a hole for `?? fallback` to fill.
  // `allSettled` keeps that index alignment while loading in parallel — awaiting
  // each one in turn serialised five network round-trips before the first
  // particle could render.
  const results = await Promise.allSettled(
    KENNEY_TEXTURES.map((path) => PIXI.Assets.load(path) as Promise<PIXI.Texture>),
  );
  const kenneyTextures: Array<PIXI.Texture | undefined> = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      kenneyTextures[i] = result.value;
    } else {
      console.warn(`[Particles] Failed to load ${KENNEY_TEXTURES[i]}, using fallback`);
    }
  }

  // Map shapes to textures
  // Primary shapes use Kenney glow textures (beautiful soft rendering)
  textures.set('circle', kenneyTextures[0] ?? own(createCircleFallback(renderer)));
  textures.set('spark', kenneyTextures[1] ?? own(createCircleFallback(renderer)));    // harder edge = spark feel
  textures.set('leaf', kenneyTextures[3] ?? own(createCircleFallback(renderer)));     // medium = leaf
  textures.set('square', kenneyTextures[2] ?? own(createCircleFallback(renderer)));   // large soft = ambient

  // Specialty shapes: programmatic at FALLBACK_SIZE resolution
  // These need to match the visual weight of Kenney 512px textures when scaled
  textures.set('heart', own(createFallbackTexture(renderer, (g) => {
    const s = FALLBACK_SIZE;
    const cx = s / 2;
    const r = s * 0.22;
    g.circle(cx - r * 0.7, s * 0.35, r);
    g.circle(cx + r * 0.7, s * 0.35, r);
    g.fill({ color: 0xffffff });
    g.moveTo(cx - s * 0.35, s * 0.42);
    g.lineTo(cx, s * 0.82);
    g.lineTo(cx + s * 0.35, s * 0.42);
    g.fill({ color: 0xffffff });
  })));

  textures.set('star', own(createFallbackTexture(renderer, (g) => {
    const cx = FALLBACK_SIZE / 2;
    const cy = FALLBACK_SIZE / 2;
    const outer = FALLBACK_SIZE * 0.42;
    const inner = outer * 0.4;
    const points: number[] = [];
    for (let i = 0; i < 5; i++) {
      const oa = (i * 2 * Math.PI) / 5 - Math.PI / 2;
      const ia = oa + Math.PI / 5;
      points.push(cx + Math.cos(oa) * outer, cy + Math.sin(oa) * outer);
      points.push(cx + Math.cos(ia) * inner, cy + Math.sin(ia) * inner);
    }
    g.poly(points);
    g.fill({ color: 0xffffff });
  })));

  textures.set('note', own(createFallbackTexture(renderer, (g) => {
    const cx = FALLBACK_SIZE / 2;
    const r = FALLBACK_SIZE * 0.15;
    g.circle(cx - r * 0.5, FALLBACK_SIZE * 0.68, r);
    g.fill({ color: 0xffffff });
    g.rect(cx + r * 0.3, FALLBACK_SIZE * 0.18, r * 0.5, FALLBACK_SIZE * 0.52);
    g.fill({ color: 0xffffff });
  })));

  return { textures, owned };
}

function createCircleFallback(renderer: PIXI.Renderer): PIXI.Texture {
  return createFallbackTexture(renderer, (g) => {
    // Soft glow circle with gradient-like falloff
    const cx = FALLBACK_SIZE / 2;
    const r = FALLBACK_SIZE * 0.4;
    g.circle(cx, cx, r);
    g.fill({ color: 0xffffff });
  });
}
