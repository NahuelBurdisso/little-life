import { getPublicBuildings, generateLocationsForAgentCount } from '../../../data/maps';
import type { LocationSeed } from '../../../data/maps';
import { FitError, type Stage } from '../types';

const TILE_SIZE = 32;

/** Phase 2 replaces this with a real building placement generator. Phase 1
 *  returns the hardcoded MAP_LOCATIONS public buildings verbatim. */
export const layoutStage: Stage<{ publicBuildings: LocationSeed[] }> = {
  name: 'layout',
  dependsOn: ['dimensions'],
  run(ctx) {
    if (!ctx.dimensions) {
      throw new Error('layout: dimensions not populated');
    }
    // generateLocationsForAgentCount(0) returns public buildings only (agentCount=0 → no homes).
    // Filter to type !== 'home' so only public buildings remain.
    const publicBuildings = generateLocationsForAgentCount(0, 0)
      .filter((l) => l.type !== 'home');

    // FitError if hardcoded positions don't fit the current dimensions.
    const mapPxW = ctx.dimensions.width * TILE_SIZE;
    const mapPxH = ctx.dimensions.height * TILE_SIZE;
    for (const loc of publicBuildings) {
      const rightEdge = loc.position.x + loc.position.width;
      const bottomEdge = loc.position.y + loc.position.height;
      if (rightEdge > mapPxW || bottomEdge > mapPxH) {
        throw new FitError('layout', `map too small for ${loc.name} (needs ${rightEdge}×${bottomEdge}px, have ${mapPxW}×${mapPxH}px)`);
      }
    }
    return { publicBuildings };
  },
};

// Confirm `getPublicBuildings` is exported; if not, reveal a helpful message.
void getPublicBuildings;
