import * as PIXI from "pixi.js";
import { AgentSprite } from "./AgentSprite";
import { statePoseFor } from "./statePose";

export interface AgentData {
  id: number;
  name: string;
  position: { x: number; y: number };
  sprite_sheet?: string;
  current_action?: { type?: string; pose?: string } | string;
  current_location?: number | null;
  needs?: {
    mood?: number;
    hunger?: number;
    energy?: number;
    social?: number;
    comfort?: number;
    fun?: number;
    thresholds?: { critical?: number };
  } | null;
  activeStates?: Array<{ type: string; severity?: number; target_agent_id?: number | null; metadata?: any }>;
  /** Location id of the agent's workplace (look its `type` up in the locations list). */
  workplace?: number | null;
  home?: number | null;
  age?: number;
  gender?: string;
  /** Hobbies with level > 0. Kept in server memory, so levels reset on a server restart. */
  hobbies?: Array<{ hobby: string; level: number }>;
}

/** An agent whose sprite was dropped by the last `update` (died, removed, world reset). */
export interface RemovedAgent {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** `current_action` arrives as either a bare string or a `{ type }` object. */
export function actionTypeOf(agent: { current_action?: { type?: string } | string }): string {
  const a = agent.current_action;
  return (typeof a === "string" ? a : a?.type) ?? "idle";
}

/**
 * Server-stamped cosmetic pose hint, set when the action's target zone is
 * furniture you sit on. Absent for every action that isn't zone-bound.
 */
export function poseOf(agent: { current_action?: { pose?: string } | string }): string | null {
  const a = agent.current_action;
  return (typeof a === "string" ? null : a?.pose) ?? null;
}

/** Manages all AgentSprite instances, creating/removing as needed. */
export class SpritePool {
  private sprites: Map<string, AgentSprite> = new Map();
  private names: Map<string, string> = new Map();
  readonly container: PIXI.Container;
  /**
   * Agents removed by the most recent `update`, with where they last stood. Refilled on
   * every update, so read it right after (canvas systems' `onData` runs after it).
   */
  readonly recentlyRemoved: RemovedAgent[] = [];

  constructor(parentContainer: PIXI.Container) {
    this.container = new PIXI.Container();
    parentContainer.addChild(this.container);
  }

  /**
   * Sync the pool with the current list of agents.
   * Creates new sprites, updates existing ones, removes stale ones.
   */
  update(agents: AgentData[], selectedAgentId: string | null) {
    const activeIds = new Set<string>();

    for (const agent of agents) {
      const id = String(agent.id);
      activeIds.add(id);

      const px = agent.position?.x ?? 0;
      const py = agent.position?.y ?? 0;

      let sprite = this.sprites.get(id);
      if (!sprite) {
        sprite = new AgentSprite(agent.name ?? "Agent", agent.sprite_sheet, {
          gender: agent.gender,
          age: agent.age,
        });
        this.names.set(id, agent.name ?? "Agent");
        sprite.setPositionImmediate(px, py);
        this.sprites.set(id, sprite);
        this.container.addChild(sprite.container);
      }

      sprite.setActionType(actionTypeOf(agent));
      sprite.setSeated(poseOf(agent) === "sitting");
      sprite.setTarget(px, py);
      sprite.setSelected(id === selectedAgentId);
      sprite.updateStates(agent.activeStates ?? []);
      sprite.updateMood(agent.needs?.mood ?? 50);
      sprite.setStatePose(statePoseFor(agent));
      sprite.setInsideBuilding(agent.current_location != null);
    }

    // Remove sprites for agents no longer present
    this.recentlyRemoved.length = 0;
    for (const [id, sprite] of this.sprites) {
      if (!activeIds.has(id)) {
        this.recentlyRemoved.push({ id, name: this.names.get(id) ?? "Agent", x: sprite.x, y: sprite.y });
        this.names.delete(id);
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
  }

  /** Per-frame lerp — smoothly moves sprites toward their targets. */
  lerpAll(deltaTime: number) {
    for (const sprite of this.sprites.values()) {
      sprite.lerp(deltaTime);
    }
  }

  getSprite(agentId: string): AgentSprite | undefined {
    return this.sprites.get(agentId);
  }

  getAllIds(): string[] {
    return Array.from(this.sprites.keys());
  }

  destroy() {
    for (const [, sprite] of this.sprites) {
      sprite.destroy();
    }
    this.sprites.clear();
    this.container.destroy({ children: true });
  }
}
