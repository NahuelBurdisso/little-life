import { forkRng, makeRng, randomBase62 } from './rng';
import { MAX_WIDTH, MAX_HEIGHT, type WorldGenConfig } from './config';
import {
  FitError,
  type WorldContext,
  type Stage,
  type StageExtras,
  type GenResult,
  type GenerateOptions,
} from './types';
import { dimensionsStage } from './stages/dimensions';
import { terrainStage } from './stages/terrain';
import { roadsStage } from './stages/roads';
import { layoutStage } from './stages/layout';
import { homesStage } from './stages/homes';
import { interiorsStage } from './stages/interiors';
import { namesStage } from './stages/names';
import { generateCollisionGridForLocations } from '../../data/maps';
import type { LocationSeed } from '../../data/maps';

const MAX_EXPAND_ATTEMPTS = 3;
const EXPAND_FACTOR = 1.2;

/** Ordered pipeline — source of truth for stage order. */
const PIPELINE: Array<Stage<any>> = [
  dimensionsStage,
  terrainStage,
  roadsStage,
  layoutStage,
  homesStage,
  interiorsStage,
  namesStage,
];

// Pipeline-boot sanity check: every dependsOn must reference a field populated
// by an earlier stage. This catches misconfiguration at module init, not mid-run.
(function validatePipelineAtBoot() {
  const populated = new Set<keyof WorldContext>();
  const STAGE_OUTPUTS: Record<string, (keyof WorldContext)[]> = {
    dimensions: ['dimensions'],
    terrain: ['terrainTiles'],
    roads: ['roads'],
    layout: ['publicBuildings'],
    homes: ['homes'],
    interiors: ['interiors'],
    names: ['names'],
  };
  for (const stage of PIPELINE) {
    for (const dep of stage.dependsOn) {
      if (!populated.has(dep)) {
        throw new Error(
          `[worldgen] stage '${stage.name}' depends on '${String(dep)}' which no earlier stage produces`,
        );
      }
    }
    for (const out of STAGE_OUTPUTS[stage.name] ?? []) populated.add(out);
  }
})();

function emptyCtx(): WorldContext {
  return {
    dimensions: null, terrainTiles: null, roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null,
  };
}

/** Evaluate the dimensions stage priority chain without an expand pin.
 *  Relies on dimensions-stage invariants (no ctx, no rng). */
function peekBaseDimensions(cfg: WorldGenConfig, agentCount: number) {
  return dimensionsStage.run(emptyCtx(), makeRng(0), cfg, agentCount, {}).dimensions!;
}

/** Grow both axes by factor, clamp to MAX. Equal result to input means cap hit. */
function expandDimensions(
  dims: { width: number; height: number },
  factor: number,
): { width: number; height: number } {
  return {
    width:  Math.min(Math.ceil(dims.width  * factor), MAX_WIDTH),
    height: Math.min(Math.ceil(dims.height * factor), MAX_HEIGHT),
  };
}

function runStages(
  cfg: WorldGenConfig,
  agentCount: number,
  opts: GenerateOptions,
  expandPin: { width: number; height: number } | null,
): GenResult {
  const ctx = emptyCtx();
  const seed = cfg.seed!; // pipeline caller guarantees a seed

  for (const stage of PIPELINE) {
    const rng = forkRng(seed, stage.name);
    const extras: StageExtras = {};
    if (stage.needsAgents && opts.agents) extras.agents = opts.agents;
    if (stage.name === 'dimensions' && expandPin) extras.expandPin = expandPin;

    const partial = stage.run(ctx, rng, cfg, agentCount, extras);
    Object.assign(ctx, partial);
  }

  const publicBuildings = ctx.publicBuildings!;
  const homes = ctx.homes!;
  const locations: LocationSeed[] = [...publicBuildings, ...homes];

  const rawLocs = locations.map((l) => ({
    name: l.name,
    type: l.type,
    x: l.position.x,
    y: l.position.y,
    width: l.position.width,
    height: l.position.height,
    entryX: l.entry_point.x,
    entryY: l.entry_point.y,
    capacity: l.capacity,
    description: l.description,
  }));
  const collisionGrid = generateCollisionGridForLocations(
    rawLocs as any,
    ctx.dimensions!.width,
    ctx.dimensions!.height,
  );

  return {
    seed,
    dimensions: ctx.dimensions!,
    locations,
    collisionGrid,
    roads: ctx.roads?.tiles ?? [],
  };
}

export function generateWorld(
  cfg: WorldGenConfig,
  agentCount: number,
  opts: GenerateOptions = {},
): GenResult {
  const seed = cfg.seed ?? randomBase62(8);
  let expandPin: { width: number; height: number } | null = null;

  for (let attempt = 0; attempt < MAX_EXPAND_ATTEMPTS; attempt++) {
    try {
      const started = Date.now();
      const result = runStages({ ...cfg, seed }, agentCount, opts, expandPin);
      console.log(
        `[worldgen] done seed=${seed} dims=${result.dimensions.width}×${result.dimensions.height} ` +
        `locations=${result.locations.length} attempts=${attempt + 1} elapsed=${Date.now() - started}ms`,
      );
      return result;
    } catch (e) {
      if (!(e instanceof FitError)) throw e;
      if (cfg.sizeTier === 'custom') throw e;

      const currentDims = expandPin ?? peekBaseDimensions(cfg, agentCount);
      const grown = expandDimensions(currentDims, EXPAND_FACTOR);
      if (grown.width === currentDims.width && grown.height === currentDims.height) {
        throw new Error('worldgen: dimensions cap reached, cannot fit content');
      }
      expandPin = grown;
      console.warn(
        `[worldgen] expand attempt ${attempt + 1}: ${e.message} → ${grown.width}×${grown.height}`,
      );
    }
  }
  throw new Error('worldgen: dimensions cap reached, cannot fit content');
}
