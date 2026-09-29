import { useEffect, useRef } from 'react';
import {
  BUILDING_COLORS as TEMPLATE_COLORS,
  DERIVED_LOCATION_TYPES,
} from '../../../server/lib/worldgen/buildingTemplates';

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
/** Terrain kinds as flat swatches, echoing the game renderer's hues. Props that
 *  read as solid objects in game (trees, rocks) get more alpha than ground cover;
 *  grass tufts stay faint since in game they're barely-there texture.
 *  `tall_grass` is legacy (pre-worldgen-v2 saves); unknown kinds fall back to dirt. */
const PREVIEW_TERRAIN: Record<string, { color: string; alpha: number }> = {
  flowers: { color: '#c75a8a', alpha: 0.3 },
  grass_tuft: { color: '#4d6b35', alpha: 0.2 },
  dirt_patch: { color: '#5a4a2e', alpha: 0.3 },
  tall_grass: { color: '#3a5a2a', alpha: 0.3 },
  tree: { color: '#24391b', alpha: 0.6 },
  bush: { color: '#3d6029', alpha: 0.45 },
  rock: { color: '#7a746a', alpha: 0.45 },
};
/** Locations drawn as a faint dashed outline instead of a solid block.
 *
 *  This is `DERIVED_LOCATION_TYPES` (mainstreet, alley, farmyard, market_square),
 *  NOT the renderer's `OUTDOOR_TYPES`. It was named `OUTDOOR_TYPES` here, which
 *  read as if the preview and the live canvas shared a definition; they do not.
 *  The difference is `OPEN_AREA_TYPES` — park, farm, town_square. Those are
 *  outdoors and the canvas treats them as such, but at 320px an outline is
 *  unreadable, so the preview keeps their template color and fills them. */
const DERIVED_TYPES = DERIVED_LOCATION_TYPES;

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
        const style = PREVIEW_TERRAIN[tile.kind] ?? PREVIEW_TERRAIN.dirt_patch;
        ctx.globalAlpha = style.alpha;
        ctx.fillStyle = style.color;
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

    // Buildings + outdoor locations.
    for (const loc of result.locations) {
      const isHome = loc.type === 'home';
      const isDerived = DERIVED_TYPES.has(loc.type);

      if (isDerived) {
        // Derived plots: subtle dashed outline, no solid fill
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = '#8a7a5a';
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(
          toCanvasX(loc.position.x),
          toCanvasY(loc.position.y),
          loc.position.width * scale,
          loc.position.height * scale,
        );
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
        continue;
      }

      ctx.fillStyle = isHome ? HOME_COLOR : (TEMPLATE_COLORS[loc.type] ?? '#4a3f2e');
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
