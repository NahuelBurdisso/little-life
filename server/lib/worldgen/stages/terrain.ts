import type { Stage, TerrainTile } from '../types';

/** Phase 3 replaces this with biome generation. Phase 1 returns empty array
 *  so the renderer uses its default grass background. */
export const terrainStage: Stage<{ terrainTiles: TerrainTile[] }> = {
  name: 'terrain',
  dependsOn: ['dimensions'],
  run() {
    return { terrainTiles: [] };
  },
};
