import * as PIXI from 'pixi.js';
import type { ParticleShape } from './types';

const TEXTURE_SIZE = 8; // pixels — small for particle scale

/**
 * Pre-renders particle shapes as reusable textures.
 * Called once at engine init. Each shape is an 8×8 white texture
 * that gets tinted per-particle via sprite.tint.
 */
export function createShapeTextures(renderer: PIXI.Renderer): Map<ParticleShape, PIXI.Texture> {
  const textures = new Map<ParticleShape, PIXI.Texture>();

  const shapes: Array<{ name: ParticleShape; draw: (g: PIXI.Graphics) => void }> = [
    {
      name: 'circle',
      draw: (g) => {
        g.circle(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2 - 1);
        g.fill({ color: 0xffffff });
      },
    },
    {
      name: 'square',
      draw: (g) => {
        g.rect(1, 1, TEXTURE_SIZE - 2, TEXTURE_SIZE - 2);
        g.fill({ color: 0xffffff });
      },
    },
    {
      name: 'heart',
      draw: (g) => {
        const s = TEXTURE_SIZE;
        const cx = s / 2;
        // Simple heart from two circles + triangle
        g.circle(cx - 1.5, s * 0.35, 2);
        g.circle(cx + 1.5, s * 0.35, 2);
        g.fill({ color: 0xffffff });
        g.moveTo(cx - 3.5, s * 0.4);
        g.lineTo(cx, s * 0.85);
        g.lineTo(cx + 3.5, s * 0.4);
        g.fill({ color: 0xffffff });
      },
    },
    {
      name: 'star',
      draw: (g) => {
        const cx = TEXTURE_SIZE / 2;
        const cy = TEXTURE_SIZE / 2;
        const outer = TEXTURE_SIZE / 2 - 1;
        const inner = outer * 0.4;
        const points: number[] = [];
        for (let i = 0; i < 5; i++) {
          const outerAngle = (i * 2 * Math.PI) / 5 - Math.PI / 2;
          const innerAngle = outerAngle + Math.PI / 5;
          points.push(cx + Math.cos(outerAngle) * outer, cy + Math.sin(outerAngle) * outer);
          points.push(cx + Math.cos(innerAngle) * inner, cy + Math.sin(innerAngle) * inner);
        }
        g.poly(points);
        g.fill({ color: 0xffffff });
      },
    },
    {
      name: 'raindrop',
      draw: (g) => {
        const cx = TEXTURE_SIZE / 2;
        g.circle(cx, TEXTURE_SIZE * 0.65, 2.5);
        g.fill({ color: 0xffffff });
        g.moveTo(cx, TEXTURE_SIZE * 0.15);
        g.lineTo(cx - 2.5, TEXTURE_SIZE * 0.55);
        g.lineTo(cx + 2.5, TEXTURE_SIZE * 0.55);
        g.fill({ color: 0xffffff });
      },
    },
    {
      name: 'leaf',
      draw: (g) => {
        const cx = TEXTURE_SIZE / 2;
        const cy = TEXTURE_SIZE / 2;
        g.ellipse(cx, cy, 3, 1.5);
        g.fill({ color: 0xffffff });
      },
    },
    {
      name: 'spark',
      draw: (g) => {
        const cx = TEXTURE_SIZE / 2;
        const cy = TEXTURE_SIZE / 2;
        // Cross/plus shape
        g.rect(cx - 0.5, cy - 3, 1, 6);
        g.rect(cx - 3, cy - 0.5, 6, 1);
        g.fill({ color: 0xffffff });
      },
    },
    {
      name: 'note',
      draw: (g) => {
        const cx = TEXTURE_SIZE / 2;
        // Musical note: circle + stem
        g.circle(cx - 1, TEXTURE_SIZE * 0.7, 1.5);
        g.fill({ color: 0xffffff });
        g.rect(cx + 0.3, TEXTURE_SIZE * 0.15, 0.8, TEXTURE_SIZE * 0.55);
        g.fill({ color: 0xffffff });
      },
    },
  ];

  for (const { name, draw } of shapes) {
    const g = new PIXI.Graphics();
    draw(g);

    const renderTexture = PIXI.RenderTexture.create({
      width: TEXTURE_SIZE,
      height: TEXTURE_SIZE,
    });
    renderer.render({ container: g, target: renderTexture });
    g.destroy();

    textures.set(name, renderTexture);
  }

  return textures;
}
