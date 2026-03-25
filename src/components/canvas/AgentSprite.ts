import * as PIXI from "pixi.js";
import { SPRITE_CONFIG } from "../../lib/spriteConfig";
import { ANIMATIONS, actionToAnimation, type AnimationDef } from "../../lib/animationRegistry";

const LERP_SPEED = 0.3;
const { SPRITE_SCALE, AGENT_WIDTH, AGENT_HEIGHT } = SPRITE_CONFIG;

/** Map action types to display emojis. */
const ACTION_EMOJIS: Record<string, string> = {
  sleeping: "\u{1F4A4}",
  eating: "\u{1F37D}\uFE0F",
  working: "\u{1F528}",
  talking: "\u{1F4AC}",
  walking: "\u{1F6B6}",
  shopping: "\u{1F6D2}",
  socializing: "\u{1F44B}",
  idle: "\u23F8\uFE0F",
};

interface AgentNeeds {
  mood?: number;
  hunger?: number;
  energy?: number;
  social?: number;
  comfort?: number;
  fun?: number;
  thresholds?: { critical?: number };
}

/** Represents a single agent's visual on the canvas using LimeZu character sprite sheets. */
export class AgentSprite {
  container: PIXI.Container;

  private selectionRing: PIXI.Graphics;
  private spriteWrapper: PIXI.Container;
  private sprite: PIXI.Sprite;
  private nameLabel: PIXI.Text;

  // Status indicator elements
  private statusContainer: PIXI.Container;
  private actionLabel: PIXI.Text;
  private moodDot: PIXI.Graphics;
  private needAlert: PIXI.Text;
  private pulseTimer = 0;

  private animations: Map<string, PIXI.Texture[]> = new Map();
  private currentAnimation = "idleAnim";
  private frameIndex = 0;
  private frameTimer = 0;
  private currentDirection = 0; // 0=down, 1=up, 2=left, 3=right (LimeZu order)

  private targetPos = { x: 0, y: 0 };
  private isMoving = false;
  private action: string = "idle";

  constructor(characterBase: string, hueShift: number, name: string) {
    this.container = new PIXI.Container();

    this.container.hitArea = new PIXI.Rectangle(
      0, 0,
      AGENT_WIDTH * SPRITE_SCALE,
      AGENT_HEIGHT * SPRITE_SCALE + 8,
    );

    // --- Selection ring (ellipse at feet) ---
    this.selectionRing = new PIXI.Graphics();
    this.selectionRing
      .ellipse(
        AGENT_WIDTH * SPRITE_SCALE / 2,
        AGENT_HEIGHT * SPRITE_SCALE - 4,
        20, 8,
      )
      .stroke({ color: 0xffdd44, width: 2, alpha: 0.8 });
    this.selectionRing.visible = false;
    this.container.addChild(this.selectionRing);

    // --- Sprite wrapper (scaled container) ---
    this.spriteWrapper = new PIXI.Container();
    this.spriteWrapper.scale.set(SPRITE_SCALE);
    this.container.addChild(this.spriteWrapper);

    // --- Sprite (the actual animated character) ---
    this.sprite = new PIXI.Sprite();
    this.sprite.width = AGENT_WIDTH;
    this.sprite.height = AGENT_HEIGHT;
    this.spriteWrapper.addChild(this.sprite);

    // --- Hue shift via ColorMatrixFilter ---
    if (hueShift > 0) {
      const colorMatrix = new PIXI.ColorMatrixFilter();
      colorMatrix.hue(hueShift, false);
      this.spriteWrapper.filters = [colorMatrix];
    }

    // --- Name label ---
    this.nameLabel = new PIXI.Text({
      text: name,
      style: {
        fontFamily: "monospace",
        fontSize: 7,
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 2 },
        align: "center",
      },
    });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.x = AGENT_WIDTH * SPRITE_SCALE / 2;
    this.nameLabel.y = AGENT_HEIGHT * SPRITE_SCALE + 2;
    this.container.addChild(this.nameLabel);

    // --- Status indicators (above sprite) ---
    const spriteVisualWidth = AGENT_WIDTH * SPRITE_SCALE;

    this.statusContainer = new PIXI.Container();
    this.statusContainer.y = -14; // above the sprite top
    this.container.addChild(this.statusContainer);

    this.actionLabel = new PIXI.Text({
      text: "\u23F8\uFE0F",
      style: {
        fontFamily: "monospace",
        fontSize: 10,
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 2 },
        align: "center",
      },
    });
    this.actionLabel.anchor.set(0.5, 0.5);
    this.actionLabel.x = spriteVisualWidth / 2 - 10;
    this.statusContainer.addChild(this.actionLabel);

    this.moodDot = new PIXI.Graphics();
    this.moodDot.circle(0, 0, 4).fill({ color: 0x44cc44 });
    this.moodDot.x = spriteVisualWidth / 2 + 2;
    this.moodDot.y = 0;
    this.statusContainer.addChild(this.moodDot);

    this.needAlert = new PIXI.Text({
      text: "\u26A0\uFE0F",
      style: {
        fontFamily: "monospace",
        fontSize: 10,
        fill: 0xff3333,
        stroke: { color: 0x000000, width: 2 },
        align: "center",
      },
    });
    this.needAlert.anchor.set(0.5, 0.5);
    this.needAlert.x = spriteVisualWidth / 2 + 14;
    this.needAlert.visible = false;
    this.statusContainer.addChild(this.needAlert);

    // --- Load animation textures from pre-loaded assets ---
    this.loadAnimations(characterBase);
  }

  private loadAnimations(characterBase: string) {
    for (const [animName, def] of Object.entries(ANIMATIONS)) {
      const assetKey = def.file.replace("{base}", characterBase);
      const tex = PIXI.Assets.get(assetKey);
      if (!tex?.source) continue;

      const frames: PIXI.Texture[] = [];

      if (animName === "idle") {
        for (let i = 0; i < def.totalFrames; i++) {
          frames.push(new PIXI.Texture({
            source: tex.source,
            frame: new PIXI.Rectangle(i * def.frameWidth, 0, def.frameWidth, def.frameHeight),
          }));
        }
      } else if (!def.directional) {
        for (let i = 0; i < def.totalFrames; i++) {
          frames.push(new PIXI.Texture({
            source: tex.source,
            frame: new PIXI.Rectangle(i * def.frameWidth, 0, def.frameWidth, def.frameHeight),
          }));
        }
      } else {
        const rowOffset = (def.row ?? 0) * def.frameHeight;
        for (let dir = 0; dir < 4; dir++) {
          for (let f = 0; f < def.framesPerDirection; f++) {
            const frameIdx = dir * def.framesPerDirection + f;
            frames.push(new PIXI.Texture({
              source: tex.source,
              frame: new PIXI.Rectangle(frameIdx * def.frameWidth, rowOffset, def.frameWidth, def.frameHeight),
            }));
          }
        }
      }

      this.animations.set(animName, frames);
    }

    this.setAnimation("idleAnim");
  }

  private setAnimation(name: string) {
    if (name === this.currentAnimation && this.sprite.texture.label !== "EMPTY") return;
    const frames = this.animations.get(name);
    if (!frames || frames.length === 0) {
      if (name !== "idleAnim") {
        const fallback = this.animations.get("idleAnim") ?? this.animations.get("idle");
        if (fallback && fallback.length > 0) {
          this.currentAnimation = name === "idle" ? "idle" : "idleAnim";
          this.frameIndex = 0;
          this.frameTimer = 0;
          this.sprite.texture = fallback[0];
          return;
        }
      }
      return;
    }
    this.currentAnimation = name;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.sprite.texture = frames[0];
  }

  private getAnimDef(): AnimationDef | undefined {
    return ANIMATIONS[this.currentAnimation];
  }

  private advanceFrame(deltaTime: number) {
    const def = this.getAnimDef();
    if (!def || def.speed === 0) return;

    const frames = this.animations.get(this.currentAnimation);
    if (!frames || frames.length === 0) return;

    this.frameTimer += deltaTime;
    const frameDuration = 1 / (def.speed * 60);
    if (this.frameTimer < frameDuration) return;
    this.frameTimer = 0;

    if (!def.directional) {
      this.frameIndex = (this.frameIndex + 1) % def.totalFrames;
      this.sprite.texture = frames[this.frameIndex];
    } else {
      this.frameIndex = (this.frameIndex + 1) % def.framesPerDirection;
      const idx = this.currentDirection * def.framesPerDirection + this.frameIndex;
      if (idx < frames.length) {
        this.sprite.texture = frames[idx];
      }
    }
  }

  private updateSpriteForDirection() {
    const def = this.getAnimDef();
    if (!def) return;
    const frames = this.animations.get(this.currentAnimation);
    if (!frames || frames.length === 0) return;

    if (def.directional) {
      const idx = this.currentDirection * def.framesPerDirection + this.frameIndex;
      if (idx < frames.length) {
        this.sprite.texture = frames[idx];
      }
    }
  }

  private detectDirection(dx: number, dy: number) {
    if (Math.abs(dx) > Math.abs(dy)) {
      this.currentDirection = dx > 0 ? 3 : 2;
    } else {
      this.currentDirection = dy > 0 ? 0 : 1;
    }
  }

  updatePosition(x: number, y: number, deltaTime: number) {
    this.targetPos.x = x;
    this.targetPos.y = y;

    const dx = this.targetPos.x - this.container.x;
    const dy = this.targetPos.y - this.container.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    this.isMoving = dist > 1;

    if (this.isMoving) {
      this.detectDirection(dx, dy);
    }

    const lerp = Math.min(1, deltaTime * LERP_SPEED);
    this.container.x += dx * lerp;
    this.container.y += dy * lerp;

    if (this.isMoving && this.action !== "sleeping") {
      this.advanceFrame(deltaTime);
    } else {
      this.showIdleFrame();
    }
  }

  lerpToTarget(deltaTime: number) {
    const dx = this.targetPos.x - this.container.x;
    const dy = this.targetPos.y - this.container.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    this.isMoving = dist > 1;

    if (this.isMoving) {
      this.detectDirection(dx, dy);
      const lerp = Math.min(1, deltaTime * LERP_SPEED);
      this.container.x += dx * lerp;
      this.container.y += dy * lerp;
      this.advanceFrame(deltaTime);
    } else {
      this.showIdleFrame();
    }
  }

  private showIdleFrame() {
    const def = this.getAnimDef();
    if (!def) return;
    const frames = this.animations.get(this.currentAnimation);
    if (!frames || frames.length === 0) return;

    this.frameIndex = 0;
    this.frameTimer = 0;

    if (def.directional) {
      const idx = this.currentDirection * def.framesPerDirection;
      if (idx < frames.length) {
        this.sprite.texture = frames[idx];
      }
    } else {
      this.sprite.texture = frames[0];
    }
  }

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
    this.selectionRing.visible = selected;
  }

  setAction(actionType: string) {
    this.action = actionType;
    const animName = actionToAnimation(actionType);
    this.setAnimation(animName);

    if (actionType === "sleeping") {
      this.currentDirection = 0;
      this.sprite.alpha = 0.5;
      this.updateSpriteForDirection();
    } else {
      this.sprite.alpha = 1;
    }
  }

  /** Update the status indicators above the sprite. */
  updateStatus(actionType: string, needs: AgentNeeds | null | undefined, deltaTime: number) {
    // Action emoji
    const emoji = ACTION_EMOJIS[actionType] ?? ACTION_EMOJIS["idle"];
    this.actionLabel.text = emoji;

    // Mood dot color
    const mood = needs?.mood ?? 100;
    let moodColor: number;
    if (mood > 70) {
      moodColor = 0x44cc44; // green
    } else if (mood >= 40) {
      moodColor = 0xcccc44; // yellow
    } else {
      moodColor = 0xcc4444; // red
    }
    this.moodDot.clear();
    this.moodDot.circle(0, 0, 4).fill({ color: moodColor });

    // Critical need alert
    const threshold = needs?.thresholds?.critical ?? 20;
    let hasCritical = false;
    if (needs) {
      const needValues = [needs.hunger, needs.energy, needs.social, needs.comfort, needs.fun, needs.mood];
      hasCritical = needValues.some((v) => v !== undefined && v < threshold);
    }

    this.needAlert.visible = hasCritical;
    if (hasCritical) {
      // Pulse the alert alpha using a sine wave
      this.pulseTimer += deltaTime * 4;
      this.needAlert.alpha = 0.4 + 0.6 * Math.abs(Math.sin(this.pulseTimer));
    }
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
