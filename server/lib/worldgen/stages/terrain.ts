import type { LocationSeed, Stage, TerrainTile } from '../types';
import { TILE } from '../config';

/**
 * Scatter visual variety tiles (dirt patches, flowers, tall grass) across the
 * map grid. Purely cosmetic — no gameplay impact. The renderer draws default
 * grass for any tile without an entry here.
 *
 * Approximate coverage of eligible ground: flowers ~3%, tall_grass ~5%,
 * dirt_patch ~5%. Border tiles, road tiles and building footprints are skipped —
 * this stage used to run before roads and layout existed, so it had no way to
 * know about them and drew flowers down the middle of Main Street.
 */
export const terrainStage: Stage<{ terrainTiles: TerrainTile[] }> = {
  name: 'terrain',
  dependsOn: ['dimensions', 'roads', 'publicBuildings', 'homes'],
  run(ctx, rng) {
    if (!ctx.dimensions) throw new Error('terrain: dimensions not populated');
    if (!ctx.roads) throw new Error('terrain: roads not populated');
    const { width, height } = ctx.dimensions;

    const occupied = new Uint8Array(width * height);
    for (const t of ctx.roads.tiles) {
      if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height) continue;
      occupied[t.y * width + t.x] = 1;
    }

    const footprints: LocationSeed[] = [
      ...(ctx.publicBuildings ?? []),
      ...(ctx.homes ?? []),
    ];
    for (const loc of footprints) {
      // Main Street's "footprint" is the road itself, already covered above.
      if (loc.type === 'mainstreet') continue;
      // Note this reserves *every* other footprint, including the open-ground
      // ones — park, farm, town_square, market_square, alley, farmyard. Measured:
      // 0 decorations across 91,200 such tiles over 480 worlds, i.e. the park
      // never gets a flower from this stage. That is deliberate:
      // `TilemapRenderer.setOpenAreas` paints those areas from their own zone
      // textures, and a scatter decoration on top would fight it.
      const tx = Math.floor(loc.position.x / TILE);
      const ty = Math.floor(loc.position.y / TILE);
      const tw = Math.ceil(loc.position.width / TILE);
      const th = Math.ceil(loc.position.height / TILE);
      for (let y = ty; y < ty + th; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = tx; x < tx + tw; x++) {
          if (x < 0 || x >= width) continue;
          occupied[y * width + x] = 1;
        }
      }
      // The door sits one row *below* the footprint (entry_point.y = y + height),
      // so the loop above never covered it and ~3 decorations per world were
      // drawn under a doorway.
      const ex = Math.floor(loc.entry_point.x / TILE);
      const ey = Math.floor(loc.entry_point.y / TILE);
      if (ex >= 0 && ex < width && ey >= 0 && ey < height) {
        occupied[ey * width + ex] = 1;
      }
    }

    const tiles: TerrainTile[] = [];
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (occupied[y * width + x]) continue;
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
