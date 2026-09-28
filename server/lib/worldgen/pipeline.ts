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
import { generateCollisionGridForLocations } from './collisionGrid';
import type { LocationSeed } from './types';

/** How many times the map may be grown after the base size fails. Renamed from
 *  MAX_EXPAND_ATTEMPTS, which read as a run count and was used as one. */
const MAX_EXPANSIONS = 3;
const EXPAND_FACTOR = 1.2;

/** Ordered pipeline — source of truth for stage order. */
const PIPELINE: Array<Stage<any>> = [
  dimensionsStage,
  roadsStage,
  layoutStage,
  homesStage,
  // Terrain runs last of the spatial stages so it can skip roads and building
  // footprints. It used to run second, which put ~39% of the decoration on top
  // of roads or inside buildings.
  terrainStage,
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
    layout: ['publicBuildings', 'warnings'],
    homes: ['homes'],
    interiors: ['interiors'],
    names: ['names'],
  };
  for (const stage of PIPELINE) {
    // Every stage must be registered. `STAGE_OUTPUTS[stage.name] ?? []` used to
    // let an unregistered stage validate clean and contribute nothing, so its
    // outputs were invisible here — a downstream `dependsOn` on one of them then
    // failed at boot with a message blaming the *consumer*, and if nothing
    // happened to depend on it the omission never surfaced at all.
    const outputs = STAGE_OUTPUTS[stage.name];
    if (!outputs) {
      throw new Error(
        `[worldgen] stage '${stage.name}' has no STAGE_OUTPUTS entry — add one listing the WorldContext fields it populates`,
      );
    }
    for (const dep of stage.dependsOn) {
      if (!populated.has(dep)) {
        throw new Error(
          `[worldgen] stage '${stage.name}' depends on '${String(dep)}' which no earlier stage produces`,
        );
      }
    }
    for (const out of outputs) populated.add(out);
  }
})();

function emptyCtx(): WorldContext {
  return {
    dimensions: null, terrainTiles: null, roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null,
    warnings: null,
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
    terrainTiles: ctx.terrainTiles ?? [],
    warnings: ctx.warnings ?? [],
  };
}

export function generateWorld(
  cfg: WorldGenConfig,
  agentCount: number,
  opts: GenerateOptions = {},
): GenResult {
  const seed = cfg.seed ?? randomBase62(8);
  let expandPin: { width: number; height: number } | null = null;
  // Both give-up paths used to throw a bare 'dimensions cap reached', discarding
  // the FitError that actually explains what did not fit. A 20×20 request read as
  // "cap reached" even though MAX is 90×70.
  let lastFit: FitError | null = null;
  // The size actually fed to `runStages`, not the one pinned on the way out. The
  // give-up message used to name `expandPin`, which on the final iteration is a
  // size that was computed, pinned, and then never run — so a base-56×43 failure
  // reported "cannot fit at 90×70" while the largest map actually attempted was
  // 82×63.
  let lastRun: { width: number; height: number } | null = null;
  const giveUp = (dims: { width: number; height: number }): never => {
    throw new Error(
      `worldgen: cannot fit content at ${dims.width}×${dims.height} ` +
      `(max ${MAX_WIDTH}×${MAX_HEIGHT})` +
      (lastFit ? `: ${lastFit.message}` : ''),
    );
  };

  // `<=` because the bound counts *expansions*, not runs: attempt 0 is the base
  // size, so `<` only ever ran 3 sizes and stopped one rung short of the cap.
  // From a 56×43 base that left 82×63 as the biggest map ever tried — 69 home
  // spots against the 91 that 90×70 fits, forfeiting a third of the configured
  // capacity on worlds that would have generated fine.
  for (let attempt = 0; attempt <= MAX_EXPANSIONS; attempt++) {
    try {
      const started = Date.now();
      lastRun = expandPin ?? peekBaseDimensions(cfg, agentCount);
      const result = runStages({ ...cfg, seed }, agentCount, opts, expandPin);
      console.log(
        `[worldgen] done seed=${seed} dims=${result.dimensions.width}×${result.dimensions.height} ` +
        `locations=${result.locations.length} attempts=${attempt + 1} elapsed=${Date.now() - started}ms`,
      );
      return result;
    } catch (e) {
      if (!(e instanceof FitError)) throw e;
      if (cfg.sizeTier === 'custom') throw e;
      lastFit = e;

      const currentDims = lastRun!;
      const grown = expandDimensions(currentDims, EXPAND_FACTOR);
      if (grown.width === currentDims.width && grown.height === currentDims.height) {
        giveUp(currentDims);
      }
      expandPin = grown;
      console.warn(
        `[worldgen] expand attempt ${attempt + 1}: ${e.message} → ${grown.width}×${grown.height}`,
      );
    }
  }
  return giveUp(lastRun!);
}
