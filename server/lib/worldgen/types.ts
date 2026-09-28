import type { AgentConfig } from '../../../src/components/setup/types';
import type { RNG } from './rng';
import type { SocialEdge } from './social';

export interface LocationSeed {
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
  capacity: number;
  current_occupants: number[];
  operating_hours: { open: number; close: number } | null;
  services: Array<{
    needSatisfied: string;
    amount: number;
    cost: number;
    itemRequired: string | null;
  }>;
  description: string;
  owner: null;
}

/** Phase 3 may extend. Placeholder for Phase 1. */
export interface TerrainTile {
  x: number;
  y: number;
  kind: string;
}

export interface Zone {
  id: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  affinity: Record<string, number>;
}

export interface RoadsOutput {
  tiles: Array<{ x: number; y: number }>;
  zones: Zone[];
}

/** Phase 4 may extend. Placeholder for Phase 1. */
export interface InteriorData {
  /** Cell codes per INTERIOR_GRIDS convention (1=wall, 2=furniture, 3=door, 0=floor),
   *  or null for buildings without an interior grid (homes, open areas). */
  grid: number[][] | null;
}

/** Mutable during pipeline execution; fields are filled in by each stage. */
export interface WorldContext {
  dimensions: { width: number; height: number } | null;
  terrainTiles: TerrainTile[] | null;
  roads: RoadsOutput | null;
  publicBuildings: LocationSeed[] | null;
  homes: LocationSeed[] | null;
  interiors: Record<number, InteriorData> | null;
  names: Record<string, string> | null;
  /** Non-fatal notes about content the generator could not fit. Surfaced to the
   *  wizard so the user can reroll; never a reason to fail generation. */
  warnings: string[] | null;
}

/** Data passed to stages beyond ctx/rng/cfg/agentCount. The framework owns
 *  what goes in here; stages opt in via Stage.needsAgents etc. */
export interface StageExtras {
  /** Agent configs from the wizard. The homes stage (§7.4 of spec) only
   *  reads .homeName, so a narrowed Array<{ homeName: string }> is acceptable. */
  agents?: Array<{ homeName: string } & Partial<AgentConfig>>;
  /** Relationship edges for social home placement. Injected alongside `agents`
   *  (only for `needsAgents` stages): the homes stage maps edge endpoints to
   *  homes through `agents[].name` → `homeName`, so one is useless without the
   *  other. */
  social?: { edges: SocialEdge[] };
  /** Framework-internal auto-expand pin. Injected by runStages ONLY when
   *  forwarding to the `dimensions` stage. Overrides all priority rules. */
  expandPin?: { width: number; height: number };
}

export interface Stage<Output extends Partial<WorldContext>> {
  name: string;
  /** Sanity check at pipeline boot: listed fields must be populated by earlier stages. */
  dependsOn: (keyof WorldContext)[];
  /** When true, runStages injects extras.agents from GenerateOptions.agents. */
  needsAgents?: boolean;
  run(
    ctx: Readonly<WorldContext>,
    rng: RNG,
    cfg: import('./config').WorldGenConfig,
    agentCount: number,
    extras: StageExtras,
  ): Output;
}

/** Thrown when spatial constraints cannot be met. Pipeline catches this
 *  to trigger expand-on-fail. Any other error propagates as a bug. */
export class FitError extends Error {
  constructor(public stage: string, public reason: string) {
    super(`[${stage}] ${reason}`);
    this.name = 'FitError';
  }
}

export interface GenResult {
  /** Master seed used (user-provided or framework-generated). */
  seed: string;
  dimensions: { width: number; height: number };
  /** publicBuildings ∪ homes, in that order. */
  locations: LocationSeed[];
  /** Row-major '0'/'1' string computed post-pipeline from `locations`. */
  collisionGrid: string;
  roads: Array<{ x: number; y: number }>;
  terrainTiles: TerrainTile[];
  /** Optional content that could not be placed. Empty on a complete world. */
  warnings: string[];
}

export interface GenerateOptions {
  agents?: StageExtras['agents'];
  /** Who should live near whom — see `social.ts`. Absent or empty edges leave
   *  home labels in selection order, byte-identical to a world without it. */
  social?: StageExtras['social'];
}
