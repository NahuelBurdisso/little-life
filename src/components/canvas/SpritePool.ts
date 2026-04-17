import * as PIXI from "pixi.js";
import { AgentSprite } from "./AgentSprite";

export interface AgentData {
  id: number;
  name: string;
  position: { x: number; y: number };
  sprite_sheet?: string;
  current_action?: { type?: string } | string;
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
}

/** Manages all AgentSprite instances, creating/removing as needed. */
export class SpritePool {
  private sprites: Map<string, AgentSprite> = new Map();
  readonly container: PIXI.Container;

  constructor(parentContainer: PIXI.Container) {
    this.container = new PIXI.Container();
    parentContainer.addChild(this.container);
  }

  /**
   * Sync the pool with the current list of agents.
   * Creates new sprites, updates existing ones, removes stale ones.
   */
  update(agents: AgentData[], deltaTime: number, selectedAgentId: string | null) {
    const activeIds = new Set<string>();

    for (const agent of agents) {
      const id = String(agent.id);
      activeIds.add(id);

      const px = agent.position?.x ?? 0;
      const py = agent.position?.y ?? 0;

      let sprite = this.sprites.get(id);
      if (!sprite) {
        sprite = new AgentSprite(agent.name ?? "Agent", agent.sprite_sheet);
        sprite.setPositionImmediate(px, py);
        this.sprites.set(id, sprite);
        this.container.addChild(sprite.container);
      }

      sprite.update(px, py, deltaTime);
      sprite.setSelected(id === selectedAgentId);
      sprite.updateStates(agent.activeStates ?? []);
      sprite.updateMood(agent.needs?.mood ?? 50);
      sprite.setInsideBuilding(agent.current_location != null);
    }

    // Remove sprites for agents no longer present
    for (const [id, sprite] of this.sprites) {
      if (!activeIds.has(id)) {
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
