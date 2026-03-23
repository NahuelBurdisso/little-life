import * as PIXI from "pixi.js";
import { SPRITE_CONFIG, getAgentSpriteSheet } from "../../lib/spriteConfig";

const LERP_SPEED = 0.3;
const FRAME_DURATION = 1 / SPRITE_CONFIG.WALK_SPEED; // ticks per frame

/** Represents a single agent's visual on the canvas. */
export class AgentSprite {
  container: PIXI.Container;

  private sprite: PIXI.Sprite | null = null;
  private fallbackBody: PIXI.Graphics | null = null;
  private nameLabel: PIXI.Text;
  private highlightRing: PIXI.Graphics;

  private targetPos = { x: 0, y: 0 };
  private currentDirection = 0; // 0=down,1=left,2=right,3=up
  private frameIndex = 0;
  private frameTimer = 0;
  private isMoving = false;
  private action: string = "idle";

  private frames: PIXI.Texture[] = []; // 16 frames: 4 dirs x 4 walk
  private usingSpriteSheet = false;

  readonly agentIndex: number;

  constructor(agentIndex: number, name: string, hue: number) {
    this.agentIndex = agentIndex;
    this.container = new PIXI.Container();

    // Hit area for click detection — covers the sprite plus name label below
    const size = SPRITE_CONFIG.AGENT_SIZE;
    this.container.hitArea = new PIXI.Rectangle(0, 0, size, size + 16);

    // Selection highlight ring (hidden by default)
    this.highlightRing = new PIXI.Graphics();
    const half = SPRITE_CONFIG.AGENT_SIZE / 2;
    this.highlightRing
      .circle(half, half, half + 4)
      .stroke({ color: 0xffdd44, width: 2, alpha: 0.8 });
    this.highlightRing.visible = false;
    this.container.addChild(this.highlightRing);

    // Colored-circle fallback
    this.fallbackBody = new PIXI.Graphics();
    const bodyColor = hslToHex(hue, 0.6, 0.5);
    this.fallbackBody
      .circle(half, half, half - 2)
      .fill(bodyColor);
    this.fallbackBody
      .circle(half, half, half - 2)
      .stroke({ color: 0x000000, width: 1, alpha: 0.3 });
    this.container.addChild(this.fallbackBody);

    // Name label
    this.nameLabel = new PIXI.Text({
      text: name,
      style: {
        fontFamily: "monospace",
        fontSize: 9,
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 2 },
        align: "center",
      },
    });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.x = half;
    this.nameLabel.y = SPRITE_CONFIG.AGENT_SIZE + 2;
    this.container.addChild(this.nameLabel);

    // Attempt to load sprite sheet (non-blocking)
    this.loadSpriteSheet();
  }

  private async loadSpriteSheet() {
    try {
      const path = getAgentSpriteSheet(this.agentIndex);
      const texture = await PIXI.Assets.load(path);
      if (!texture?.source) return;

      const size = SPRITE_CONFIG.AGENT_SIZE;
      this.frames = [];
      for (let dir = 0; dir < 4; dir++) {
        for (let f = 0; f < SPRITE_CONFIG.WALK_FRAMES; f++) {
          const frame = new PIXI.Rectangle(f * size, dir * size, size, size);
          this.frames.push(new PIXI.Texture({ source: texture.source, frame }));
        }
      }

      // Replace fallback with sprite
      this.sprite = new PIXI.Sprite(this.frames[0]);
      if (this.fallbackBody) {
        this.container.removeChild(this.fallbackBody);
        this.fallbackBody.destroy();
        this.fallbackBody = null;
      }
      // Insert sprite after highlight ring (index 0) but before name label
      this.container.addChildAt(this.sprite, 1);
      this.usingSpriteSheet = true;
    } catch {
      // Keep fallback
    }
  }

  /** Smoothly move toward the given world-pixel position. */
  updatePosition(x: number, y: number, deltaTime: number) {
    this.targetPos.x = x;
    this.targetPos.y = y;

    const dx = this.targetPos.x - this.container.x;
    const dy = this.targetPos.y - this.container.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    this.isMoving = dist > 1;

    if (this.isMoving) {
      // Determine direction from movement vector
      if (Math.abs(dx) > Math.abs(dy)) {
        this.currentDirection = dx > 0 ? 2 : 1; // right / left
      } else {
        this.currentDirection = dy > 0 ? 0 : 3; // down / up
      }
    }

    const lerp = Math.min(1, deltaTime * LERP_SPEED);
    this.container.x += dx * lerp;
    this.container.y += dy * lerp;

    // Animate walk cycle
    if (this.usingSpriteSheet && this.sprite) {
      if (this.isMoving && this.action !== "sleeping") {
        this.frameTimer += deltaTime;
        if (this.frameTimer >= FRAME_DURATION) {
          this.frameTimer = 0;
          this.frameIndex = (this.frameIndex + 1) % SPRITE_CONFIG.WALK_FRAMES;
        }
        const idx = this.currentDirection * SPRITE_CONFIG.WALK_FRAMES + this.frameIndex;
        this.sprite.texture = this.frames[idx];
      } else {
        // Idle: show first frame of current direction
        this.frameIndex = 0;
        this.frameTimer = 0;
        const idx = this.currentDirection * SPRITE_CONFIG.WALK_FRAMES;
        this.sprite.texture = this.frames[idx];
      }
    }
  }

  /** Per-frame lerp toward the current target — call from ticker without new data. */
  lerpToTarget(deltaTime: number) {
    const dx = this.targetPos.x - this.container.x;
    const dy = this.targetPos.y - this.container.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    this.isMoving = dist > 1;

    if (this.isMoving) {
      if (Math.abs(dx) > Math.abs(dy)) {
        this.currentDirection = dx > 0 ? 2 : 1;
      } else {
        this.currentDirection = dy > 0 ? 0 : 3;
      }

      const lerp = Math.min(1, deltaTime * LERP_SPEED);
      this.container.x += dx * lerp;
      this.container.y += dy * lerp;
    }

    // Walk animation
    if (this.usingSpriteSheet && this.sprite) {
      if (this.isMoving && this.action !== "sleeping") {
        this.frameTimer += deltaTime;
        if (this.frameTimer >= FRAME_DURATION) {
          this.frameTimer = 0;
          this.frameIndex = (this.frameIndex + 1) % SPRITE_CONFIG.WALK_FRAMES;
        }
        const idx = this.currentDirection * SPRITE_CONFIG.WALK_FRAMES + this.frameIndex;
        this.sprite.texture = this.frames[idx];
      } else {
        this.frameIndex = 0;
        this.frameTimer = 0;
        const idx = this.currentDirection * SPRITE_CONFIG.WALK_FRAMES;
        if (this.frames[idx]) this.sprite.texture = this.frames[idx];
      }
    }
  }

  /** Directly set position without lerp (for initial placement). */
  setPositionImmediate(x: number, y: number) {
    this.targetPos.x = x;
    this.targetPos.y = y;
    this.container.x = x;
    this.container.y = y;
  }

  setName(name: string) {
    this.nameLabel.text = name;
  }

  setSelected(selected: boolean) {
    this.highlightRing.visible = selected;
  }

  setAction(action: string) {
    this.action = action;
    // For sleeping, show down-facing idle frame and reduce alpha
    if (this.usingSpriteSheet && this.sprite) {
      if (action === "sleeping") {
        this.sprite.alpha = 0.7;
        this.currentDirection = 0;
      } else {
        this.sprite.alpha = 1;
      }
    }
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}

// --- Color utilities (same as GameCanvas originals) ---

function hslToHex(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}
