import * as PIXI from 'pixi.js';
import type { ParticleShape } from './types';

/**
 * Loads Kenney particle textures (CC0 license) and maps them to particle shapes.
 *
 * The Kenney pack provides 5 soft-glow circle variants (512x512, white on transparent).
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
  '/particles/circle_05.png', // small tight glow
];

// Fallback: programmatic textures if images fail to load
const FALLBACK_SIZE = 16;

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
export async function createShapeTextures(renderer: PIXI.Renderer): Promise<Map<ParticleShape, PIXI.Texture>> {
  const textures = new Map<ParticleShape, PIXI.Texture>();

  // Load Kenney textures
  const kenneyTextures: PIXI.Texture[] = [];
  for (const path of KENNEY_TEXTURES) {
    try {
      const tex = await PIXI.Assets.load(path);
      kenneyTextures.push(tex);
    } catch {
      console.warn(`[Particles] Failed to load ${path}, using fallback`);
    }
  }

  // Map shapes to textures
  // Primary shapes use Kenney glow textures (beautiful soft rendering)
  textures.set('circle', kenneyTextures[0] ?? createCircleFallback(renderer));
  textures.set('spark', kenneyTextures[1] ?? createCircleFallback(renderer));    // harder edge = spark feel
  textures.set('raindrop', kenneyTextures[4] ?? createCircleFallback(renderer)); // tight = raindrop
  textures.set('leaf', kenneyTextures[3] ?? createCircleFallback(renderer));     // medium = leaf
  textures.set('square', kenneyTextures[2] ?? createCircleFallback(renderer));   // large soft = ambient

  // Specialty shapes: programmatic (heart, star, note need distinct silhouettes)
  textures.set('heart', createFallbackTexture(renderer, (g) => {
    const s = FALLBACK_SIZE;
    const cx = s / 2;
    g.circle(cx - 2, s * 0.35, 3);
    g.circle(cx + 2, s * 0.35, 3);
    g.fill({ color: 0xffffff });
    g.moveTo(cx - 5, s * 0.42);
    g.lineTo(cx, s * 0.85);
    g.lineTo(cx + 5, s * 0.42);
    g.fill({ color: 0xffffff });
  }));

  textures.set('star', createFallbackTexture(renderer, (g) => {
    const cx = FALLBACK_SIZE / 2;
    const cy = FALLBACK_SIZE / 2;
    const outer = FALLBACK_SIZE / 2 - 1;
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
  }));

  textures.set('note', createFallbackTexture(renderer, (g) => {
    const cx = FALLBACK_SIZE / 2;
    g.circle(cx - 1.5, FALLBACK_SIZE * 0.7, 2.5);
    g.fill({ color: 0xffffff });
    g.rect(cx + 0.8, FALLBACK_SIZE * 0.15, 1.2, FALLBACK_SIZE * 0.55);
    g.fill({ color: 0xffffff });
  }));

  return textures;
}

function createCircleFallback(renderer: PIXI.Renderer): PIXI.Texture {
  return createFallbackTexture(renderer, (g) => {
    g.circle(FALLBACK_SIZE / 2, FALLBACK_SIZE / 2, FALLBACK_SIZE / 2 - 1);
    g.fill({ color: 0xffffff });
  });
}
