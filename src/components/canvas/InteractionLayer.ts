import * as PIXI from "pixi.js";
import { SpritePool } from "./SpritePool";

interface InteractionCallbacks {
  onAgentSelect: (agentId: string) => void;
  onAgentHover: (agentId: string | null, screenPos?: { x: number; y: number }) => void;
  onAgentContextMenu: (agentId: string, screenPos: { x: number; y: number }) => void;
}

/**
 * Manages click/hover/right-click detection on agent sprites.
 * Binds PixiJS pointer events on each agent's container.
 */
export class InteractionLayer {
  private spritePool: SpritePool;
  private callbacks: InteractionCallbacks;
  private boundIds: Set<string> = new Set();

  constructor(spritePool: SpritePool, callbacks: InteractionCallbacks) {
    this.spritePool = spritePool;
    this.callbacks = callbacks;
  }

  /** Set up the background click (deselect) handler on the app stage. */
  setup(app: PIXI.Application) {
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;

    // Deselect when clicking on empty background
    app.stage.on("pointerdown", (e: PIXI.FederatedPointerEvent) => {
      // If the target is the stage itself (not an agent container), deselect
      if (e.target === app.stage) {
        this.callbacks.onAgentSelect("");
      }
    });

    // Keep hitArea in sync with renderer size
    app.renderer.on("resize", () => {
      app.stage.hitArea = app.screen;
    });
  }

  /**
   * Re-bind pointer events for the given agent IDs.
   * Call this after SpritePool.update() to attach events to new sprites.
   */
  updateBindings(agentIds: string[]) {
    for (const id of agentIds) {
      const sprite = this.spritePool.getSprite(id);
      if (!sprite) continue;

      const c = sprite.container;

      // Always force interaction state — PixiJS v8 can lose eventMode
      // after container children are modified (clear/redraw cycles)
      c.eventMode = "static";
      c.cursor = "pointer";
      c.interactiveChildren = false;
      c.hitArea = new PIXI.Circle(0, 0, 16);

      if (!this.boundIds.has(id)) {
        c.on("pointertap", (e: PIXI.FederatedPointerEvent) => {
          e.stopPropagation();
          this.callbacks.onAgentSelect(id);
        });

        c.on("pointerover", (e: PIXI.FederatedPointerEvent) => {
          this.callbacks.onAgentHover(id, { x: e.global.x, y: e.global.y });
        });

        c.on("pointerout", () => {
          this.callbacks.onAgentHover(null);
        });

        c.on("rightclick", (e: PIXI.FederatedPointerEvent) => {
          e.stopPropagation();
          (e as any).preventDefault?.();
          this.callbacks.onAgentContextMenu(id, { x: e.global.x, y: e.global.y });
        });

        this.boundIds.add(id);
      }
    }

    // Clean up bindings for agents that no longer exist
    const activeSet = new Set(agentIds);
    for (const id of this.boundIds) {
      if (!activeSet.has(id)) {
        this.boundIds.delete(id);
      }
    }
  }

  destroy() {
    this.boundIds.clear();
  }
}
