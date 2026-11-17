import type * as PIXI from "pixi.js";
import type { SpritePool, AgentLite } from "../SpritePool";
import type { BubbleSystem } from "../BubbleSystem";
import type { ViewRect } from "./view";
import type { ActivityLite, ConversationLite, LocationLite, RelationshipLite, WorldEventLite, WorldLite } from '../../../lib/apiTypes';

/**
 * Pluggable canvas systems: self-contained visual features (ambient life, town event
 * decorations, story beats, held props...) that GameCanvas drives without knowing
 * about them. A system is registered with one line in `systems/index.ts`.
 *
 * Contract:
 * - Create display objects only inside the layers handed to the factory (or attach to
 *   an AgentSprite's `hand`/`behind` containers) and destroy them in `destroy()`.
 * - `update` runs every frame: no allocations in the steady state (reuse/pool), skip
 *   work for what isn't in `view`, and never throw.
 * - `onData` runs on each server poll (~1/s) with fresh data; do the diffing there.
 */

/** Containers systems draw into, in z-order from bottom to top. */
export interface CanvasLayers {
  /** Above terrain and buildings, below agents: ground decorations, critters on the ground. */
  ground: PIXI.Container;
  /** Above agents, below speech bubbles: beat effects, flying critters, confetti. */
  overAgents: PIXI.Container;
}

/** Shared subsystems a canvas system may call into. */
export interface CanvasServices {
  sprites: SpritePool;
  bubbles: BubbleSystem;
}

/** Fresh server data, handed over on every poll. */
export interface DataContext {
  agents: AgentLite[];
  /** The world row: day_phase, weather, time { hour, day, season }, map size... */
  world: WorldLite | null | undefined;
  /** Active world events (`world.getActiveEvents` rows). */
  events: WorldEventLite[];
  locations: LocationLite[];
  conversations: ConversationLite[];
  /** `relationships.getGraph` rows: agent_a, agent_b, status, tags, romance_ab... */
  relationships: RelationshipLite[];
  /**
   * Newest `activity_log` rows, newest first (limit 50): id, type, category,
   * initiator_id, target_id, agent_ids, template_data { description, ... },
   * timestamp (tick), real_timestamp (ms). Diff by `id` to find new rows.
   */
  activity: ActivityLite[];
  /**
   * `chronicle.getBrewing` rows (server/lib/brewing.ts): kind, agentIds, text, heat.
   * For `kind: "snap"` the heat is the resident's tension over their snap threshold.
   * Optional so a system's test fixture need not carry it.
   */
  brewing?: Array<{ id?: string; kind: string; agentIds: number[]; text?: string; heat: number }>;
}

export interface FrameContext {
  /** Pixi ticker delta, in 60fps frames (1 ≈ 16.7ms). */
  dt: number;
  /** Same delta in seconds. */
  seconds: number;
  /** `performance.now()` at the start of the frame. */
  now: number;
  view: ViewRect;
  /** Latest data, same object as the last `onData` call. */
  data: DataContext;
}

export interface CanvasSystem {
  update(frame: FrameContext): void;
  onData?(data: DataContext): void;
  destroy(): void;
}

export type SystemFactory = (layers: CanvasLayers, services: CanvasServices) => CanvasSystem;
