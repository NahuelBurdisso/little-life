import * as PIXI from "pixi.js";
import { AgentSprite } from "./AgentSprite";
import { getCharacterAssignment } from "../../lib/spriteConfig";

export interface AgentData {
  id: number;
  name: string;
  position: { x: number; y: number };
  current_action?: { type?: string } | string;
  needs?: {
    mood?: number;
    hunger?: number;
    energy?: number;
    social?: number;
    comfort?: number;
    fun?: number;
    thresholds?: { critical?: number };
  } | null;
}

/** Manages all AgentSprite instances, creating/removing as needed. */
export class SpritePool {
  private sprites: Map<string, AgentSprite> = new Map();
  private agentIndexMap: Map<string, number> = new Map();
  private nextIndex = 0;
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

      // Agent positions are pixel coordinates (top-left of the agent's tile)
      const px = agent.position?.x ?? 0;
      const py = agent.position?.y ?? 0;

      let sprite = this.sprites.get(id);
      if (!sprite) {
        // Assign a stable sprite-sheet index
        if (!this.agentIndexMap.has(id)) {
          this.agentIndexMap.set(id, this.nextIndex++);
        }
        const idx = this.agentIndexMap.get(id)!;
        const { base, hueShift } = getCharacterAssignment(idx % 12);

        sprite = new AgentSprite(base, hueShift, agent.name ?? "Agent");
        sprite.setPositionImmediate(px, py);
        this.sprites.set(id, sprite);
        this.container.addChild(sprite.container);
      }

      sprite.updatePosition(px, py, deltaTime);
      sprite.setSelected(id === selectedAgentId);

      // Update action
      const actionType =
        typeof agent.current_action === "string"
          ? agent.current_action
          : agent.current_action?.type ?? "idle";
      sprite.setAction(actionType);

    }

    // Remove sprites for agents no longer present
    for (const [id, sprite] of this.sprites) {
      if (!activeIds.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
  }

  /** Per-frame lerp — call from ticker without needing fresh agent data. */
  lerpAll(deltaTime: number) {
    for (const sprite of this.sprites.values()) {
      sprite.lerpToTarget(deltaTime);
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

