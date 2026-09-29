import * as PIXI from "pixi.js";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext } from "../types";
import { inView } from "../view";
import { fuseTargets } from "./fuseTargets";

/** Beside and above the head, clear of the emote/bubble that sits right over it. */
const OFFSET_X = 11;
const OFFSET_Y = -42;
/** Spark position on the fuse tip, in the bomb's own coordinates. */
const TIP_X = 4;
const TIP_Y = -10;

interface Slot {
  root: PIXI.Container;
  spark: PIXI.Graphics;
  /** Desynchronises the flicker so two fuses on screen do not blink in lockstep. */
  phase: number;
  /** -1 while the slot is free. */
  agentId: number;
}

/**
 * A lit fuse over each resident about to snap (>= 85% of their snap threshold),
 * so the spectator can see who is about to blow before the Brewing tab is even
 * opened. Purely client-side: the "who" comes from `data.brewing`, the fuse is a
 * few pooled Graphics drawn once (bomb + fuse) with only the spark's alpha/scale
 * changing per frame -- no allocation in the steady state.
 */
class FuseSystem implements CanvasSystem {
  private readonly slots: Slot[] = [];
  private readonly byAgent = new Map<number, Slot>();
  private readonly wanted = new Set<number>();
  private t = 0;
  private serial = 0;

  constructor(private readonly layers: CanvasLayers, private readonly services: CanvasServices) {}

  onData(data: DataContext): void {
    fuseTargets(data.brewing, this.wanted);
    // Release fuses whose resident cooled down (or snapped: tension drops to 20).
    for (const [id, slot] of this.byAgent) {
      if (this.wanted.has(id)) continue;
      slot.root.visible = false;
      slot.agentId = -1;
      this.byAgent.delete(id);
    }
    for (const id of this.wanted) {
      if (this.byAgent.has(id)) continue;
      const slot = this.acquire();
      slot.agentId = id;
      slot.root.visible = true;
      this.byAgent.set(id, slot);
    }
  }

  private acquire(): Slot {
    for (const s of this.slots) if (s.agentId === -1) return s;
    const root = new PIXI.Container();
    root.eventMode = "none";
    root.visible = false;

    // Bomb body and fuse are drawn once; the spark is its own Graphics so it can
    // flicker without redrawing anything.
    const body = new PIXI.Graphics();
    body.circle(0, 0, 4).fill(0x2b2620).stroke({ width: 1, color: 0x6b5c30 });
    body.moveTo(1, -3.5).lineTo(TIP_X, TIP_Y).stroke({ width: 1, color: 0xd4c9a8 });
    const spark = new PIXI.Graphics();
    spark.circle(0, 0, 2.6).fill({ color: 0xc07840, alpha: 0.9 });
    spark.circle(0, 0, 1.2).fill(0xf0d878);
    spark.position.set(TIP_X, TIP_Y);
    root.addChild(body, spark);
    this.layers.overAgents.addChild(root);

    const slot: Slot = { root, spark, phase: (this.serial++ * 1.7) % (Math.PI * 2), agentId: -1 };
    this.slots.push(slot);
    return slot;
  }

  update(frame: FrameContext): void {
    if (this.byAgent.size === 0) return;
    this.t += frame.seconds;
    for (const slot of this.byAgent.values()) {
      const sprite = this.services.sprites.getSprite(String(slot.agentId));
      if (!sprite || !inView(frame.view, sprite.x, sprite.y, 48)) {
        slot.root.visible = false;
        continue;
      }
      slot.root.visible = true;
      // A slight nervous bob so it reads as a live thing, not a sticker.
      slot.root.position.set(sprite.x + OFFSET_X, sprite.y + OFFSET_Y + Math.sin(this.t * 5 + slot.phase) * 0.8);
      slot.spark.alpha = 0.7 + 0.3 * Math.sin(this.t * 19 + slot.phase);
      slot.spark.scale.set(1 + 0.25 * Math.sin(this.t * 27 + slot.phase));
    }
  }

  destroy(): void {
    for (const slot of this.slots) slot.root.destroy({ children: true });
    this.slots.length = 0;
    this.byAgent.clear();
    this.wanted.clear();
  }
}

export function createFuseSystem(layers: CanvasLayers, services: CanvasServices): CanvasSystem {
  return new FuseSystem(layers, services);
}
