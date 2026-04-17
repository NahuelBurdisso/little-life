import { useEffect, useRef } from 'react';

interface GenLocation {
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
}

interface GenResultLite {
  seed: string;
  dimensions: { width: number; height: number };
  locations: GenLocation[];
  roads?: Array<{ x: number; y: number }>;
  terrainTiles?: Array<{ x: number; y: number; kind: string }>;
}

interface WorldPreviewProps {
  result: GenResultLite | null;
  /** Canvas display size in CSS pixels. */
  size?: { width: number; height: number };
}

const BG = '#2d2a24';
const HOME_COLOR = '#6b5b45';
const HOME_LABEL = '#a09070';
const DOOR_COLOR = '#c8a84b';
const BUILDING_COLORS: Record<string, string> = {
  shop: '#5a5040',
  tavern: '#7a4f35',
  clinic: '#d8e8e0',
  town_hall: '#7a6a4a',
  bakery: '#6B5B4A',
  workshop: '#4a4a42',
  prison: '#6A6A6A',
  farm: '#6b7c3a',
  park: '#4a6b3a',
  town_square: '#8a7a5a',
};

export function WorldPreview({ result, size = { width: 320, height: 240 } }: WorldPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size.width, size.height);

    if (!result) {
      ctx.fillStyle = '#8a7f65';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Finish setup to preview world', size.width / 2, size.height / 2);
      return;
    }

    // Scale world px → canvas px. World is dimensions.width * 32 px wide.
    const worldW = result.dimensions.width * 32;
    const worldH = result.dimensions.height * 32;
    const scale = Math.min(size.width / worldW, size.height / worldH);
    const offsetX = (size.width - worldW * scale) / 2;
    const offsetY = (size.height - worldH * scale) / 2;

    const toCanvasX = (x: number) => offsetX + x * scale;
    const toCanvasY = (y: number) => offsetY + y * scale;

    // Map frame.
    ctx.strokeStyle = '#3d3a2e';
    ctx.strokeRect(offsetX, offsetY, worldW * scale, worldH * scale);

    // Terrain scatter
    if (result.terrainTiles) {
      for (const tile of result.terrainTiles) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = tile.kind === 'flowers' ? '#c75a8a' : tile.kind === 'tall_grass' ? '#3a5a2a' : '#5a4a2e';
        ctx.fillRect(toCanvasX(tile.x * 32), toCanvasY(tile.y * 32), 32 * scale, 32 * scale);
      }
      ctx.globalAlpha = 1.0;
    }

    // Roads
    if (result.roads) {
      ctx.fillStyle = '#6b5a3e';
      for (const tile of result.roads) {
        ctx.fillRect(
          toCanvasX(tile.x * 32),
          toCanvasY(tile.y * 32),
          32 * scale,
          32 * scale,
        );
      }
    }

    // Buildings.
    for (const loc of result.locations) {
      const isHome = loc.type === 'home';
      ctx.fillStyle = isHome ? HOME_COLOR : (BUILDING_COLORS[loc.type] ?? '#4a3f2e');
      ctx.fillRect(
        toCanvasX(loc.position.x),
        toCanvasY(loc.position.y),
        loc.position.width * scale,
        loc.position.height * scale,
      );

      // Home number label
      if (isHome) {
        const match = loc.name.match(/Home (\d+)/);
        if (match) {
          ctx.fillStyle = HOME_LABEL;
          ctx.font = '6px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            match[1],
            toCanvasX(loc.position.x + loc.position.width / 2),
            toCanvasY(loc.position.y + loc.position.height / 2),
          );
        }
      }

      // Entry point dot
      ctx.fillStyle = DOOR_COLOR;
      ctx.beginPath();
      ctx.arc(toCanvasX(loc.entry_point.x), toCanvasY(loc.entry_point.y), 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [result, size.width, size.height]);

  return (
    <canvas
      ref={canvasRef}
      width={size.width}
      height={size.height}
      style={{ border: '1px solid #3d3a2e', imageRendering: 'pixelated' }}
    />
  );
}
