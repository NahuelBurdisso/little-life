import * as PIXI from "pixi.js";

/**
 * A capped pool of sprites for the player-action effects. An effect borrows the few sprites
 * it needs when it starts and hands them back when it ends, so a burst of nudges never grows
 * the scene graph past `max` and the per-frame path never constructs anything.
 *
 * Two free lists, one per layer: a sprite stays in the container it was created in.
 */
export type FxLayer = "ground" | "over";

export class FxSpritePool {
  private readonly freeGround: PIXI.Sprite[] = [];
  private readonly freeOver: PIXI.Sprite[] = [];
  private readonly all: PIXI.Sprite[] = [];
  private readonly isGround = new WeakSet<PIXI.Sprite>();

  constructor(
    private readonly ground: PIXI.Container,
    private readonly over: PIXI.Container,
    private readonly max = 140,
  ) {}

  /** A reset, visible sprite showing `tex`, or null when the pool is exhausted. */
  acquire(tex: PIXI.Texture, layer: FxLayer = "over"): PIXI.Sprite | null {
    const free = layer === "ground" ? this.freeGround : this.freeOver;
    let s = free.pop() ?? null;
    if (!s) {
      if (this.all.length >= this.max) return null;
      s = new PIXI.Sprite(tex);
      s.eventMode = "none";
      (layer === "ground" ? this.ground : this.over).addChild(s);
      if (layer === "ground") this.isGround.add(s);
      this.all.push(s);
    }
    s.texture = tex;
    s.anchor.set(0.5);
    s.scale.set(1);
    s.rotation = 0;
    s.alpha = 1;
    s.tint = 0xffffff;
    s.visible = true;
    return s;
  }

  release(s: PIXI.Sprite | null | undefined): void {
    if (!s) return;
    s.visible = false;
    (this.isGround.has(s) ? this.freeGround : this.freeOver).push(s);
  }

  /** Sprites currently handed out (for tests and the live-effect cap). */
  get inUse(): number {
    return this.all.length - this.freeGround.length - this.freeOver.length;
  }

  destroy(): void {
    for (const s of this.all) {
      s.parent?.removeChild(s);
      s.destroy();
    }
    this.all.length = 0;
    this.freeGround.length = 0;
    this.freeOver.length = 0;
  }
}
