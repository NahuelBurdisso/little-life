import type { Stage, TerrainTile } from '../types';

/**
 * Scatter visual variety tiles (dirt patches, flowers, tall grass) across the
 * map grid. Purely cosmetic — no gameplay impact. The renderer draws default
 * grass for any tile without an entry here.
 *
 * Approximate coverage: flowers ~3%, tall_grass ~5%, dirt_patch ~5% = ~13% total.
 * Border tiles (row/col 0 and last) are excluded.
 */
export const terrainStage: Stage<{ terrainTiles: TerrainTile[] }> = {
  name: 'terrain',
  dependsOn: ['dimensions'],
  run(ctx, rng) {
    if (!ctx.dimensions) throw new Error('terrain: dimensions not populated');
    const { width, height } = ctx.dimensions;
    const tiles: TerrainTile[] = [];

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const r = rng.next();
        if (r < 0.03) {
          tiles.push({ x, y, kind: 'flowers' });
        } else if (r < 0.08) {
          tiles.push({ x, y, kind: 'tall_grass' });
        } else if (r < 0.13) {
          tiles.push({ x, y, kind: 'dirt_patch' });
        }
        // else: default grass (no entry needed)
      }
    }

    return { terrainTiles: tiles };
  },
};
