import * as PIXI from "pixi.js";
import { SPRITE_CONFIG } from "../../lib/spriteConfig";
import { ANIMATIONS, actionToAnimation, type AnimationDef } from "../../lib/animationRegistry";

const LERP_SPEED = 0.3;
const { SPRITE_SCALE, AGENT_WIDTH, AGENT_HEIGHT } = SPRITE_CONFIG;

/** Represents a single agent's visual on the canvas using LimeZu character sprite sheets. */
export class AgentSprite {
  container: PIXI.Container;

  private selectionRing: PIXI.Graphics;
  private spriteWrapper: PIXI.Container;
  private sprite: PIXI.Sprite;
  private nameLabel: PIXI.Text;
  private actionLabel: PIXI.Text;
  readonly statusContainer: PIXI.Container;

  private moodDot: PIXI.Graphics;
  private moodPulse: boolean = false;
  private needIcons: PIXI.Container[] = [];

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

    // Hit area covers sprite + name label area
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

    // --- Action label (below name) ---
    this.actionLabel = new PIXI.Text({
      text: "",
      style: { fontFamily: "monospace", fontSize: 6, fill: 0x9ca3af, align: "center" },
    });
    this.actionLabel.anchor.set(0.5, 0);
    this.actionLabel.x = AGENT_WIDTH * SPRITE_SCALE / 2;
    this.actionLabel.y = this.nameLabel.y + 10;
    this.container.addChild(this.actionLabel);

    // --- Status container (mood dot + need icons) ---
    this.statusContainer = new PIXI.Container();
    this.statusContainer.y = -8; // above sprite
    this.container.addChild(this.statusContainer);

    // --- Mood dot ---
    this.moodDot = new PIXI.Graphics();
    this.moodDot.visible = false;
    this.statusContainer.addChild(this.moodDot);

    // --- Need alert icons ---
    for (let i = 0; i < 2; i++) {
      const icon = new PIXI.Container();
      const circle = new PIXI.Graphics();
      circle.circle(0, 0, 4).fill(0x888888);
      const text = new PIXI.Text({ text: "!", style: { fontSize: 6, fill: 0xffffff, fontFamily: "monospace" } });
      text.anchor.set(0.5);
      icon.addChild(circle, text);
      icon.x = 8 + i * 10;
      icon.visible = false;
      this.statusContainer.addChild(icon);
      this.needIcons.push(icon);
    }

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
        // idle: 4 frames (1 per direction), single row
        for (let i = 0; i < def.totalFrames; i++) {
          frames.push(new PIXI.Texture({
            source: tex.source,
            frame: new PIXI.Rectangle(i * def.frameWidth, 0, def.frameWidth, def.frameHeight),
          }));
        }
      } else if (!def.directional) {
        // Non-directional (phone): all frames in a single row
        for (let i = 0; i < def.totalFrames; i++) {
          frames.push(new PIXI.Texture({
            source: tex.source,
            frame: new PIXI.Rectangle(i * def.frameWidth, 0, def.frameWidth, def.frameHeight),
          }));
        }
      } else {
        // Directional animations: framesPerDirection × 4 directions
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

    // Set initial texture
    this.setAnimation("idleAnim");
  }

  private setAnimation(name: string) {
    if (name === this.currentAnimation && this.sprite.texture.label !== "EMPTY") return;
    const frames = this.animations.get(name);
    if (!frames || frames.length === 0) {
      // Fallback: try idleAnim, then idle
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
    const frameDuration = 1 / (def.speed * 60); // convert speed to ticks
    if (this.frameTimer < frameDuration) return;
    this.frameTimer = 0;

    if (!def.directional) {
      // Non-directional: cycle through all frames
      this.frameIndex = (this.frameIndex + 1) % def.totalFrames;
      this.sprite.texture = frames[this.frameIndex];
    } else {
      // Directional: cycle within current direction's frames
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
    // LimeZu order: down=0, up=1, left=2, right=3
    if (Math.abs(dx) > Math.abs(dy)) {
      this.currentDirection = dx > 0 ? 3 : 2; // right : left
    } else {
      this.currentDirection = dy > 0 ? 0 : 1; // down : up
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
      this.detectDirection(dx, dy);
    }

    const lerp = Math.min(1, deltaTime * LERP_SPEED);
    this.container.x += dx * lerp;
    this.container.y += dy * lerp;

    // Animate
    if (this.isMoving && this.action !== "sleeping") {
      this.advanceFrame(deltaTime);
    } else {
      this.showIdleFrame();
    }
  }

  /** Per-frame lerp toward the current target — call from ticker without new data. */
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

    if (this.moodPulse && this.moodDot.visible) {
      this.moodDot.alpha = 0.4 + 0.6 * ((Math.sin(Date.now() * 0.004) + 1) / 2);
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
    this.selectionRing.visible = selected;
  }

  setAction(actionType: string) {
    this.action = actionType;
    const animName = actionToAnimation(actionType);
    this.setAnimation(animName);

    // Sleeping: face down, reduce alpha
    if (actionType === "sleeping") {
      this.currentDirection = 0;
      this.sprite.alpha = 0.5;
      this.updateSpriteForDirection();
    } else {
      this.sprite.alpha = 1;
    }
  }

  updateMood(mood: number | undefined) {
    if (mood === undefined || mood > 60) {
      this.moodDot.visible = false;
      this.moodPulse = false;
      return;
    }
    this.moodDot.visible = true;
    this.moodDot.clear();
    const color = mood > 40 ? 0xeab308 : mood > 20 ? 0xf97316 : 0xef4444;
    this.moodDot.circle(0, 0, 3).fill(color);
    this.moodPulse = mood <= 20;
  }

  updateNeeds(needs: any) {
    this.needIcons.forEach(i => { i.visible = false; });
    if (!needs) return;
    const critical = needs.thresholds?.critical ?? 15;
    const alerts: { color: number }[] = [];
    if (needs.hunger < critical) alerts.push({ color: 0xf97316 });
    if (needs.energy < critical) alerts.push({ color: 0x6366f1 });
    if (needs.social < critical) alerts.push({ color: 0xf472b6 });
    if (needs.comfort < critical) alerts.push({ color: 0x60a5fa });
    if (needs.fun < critical) alerts.push({ color: 0xa78bfa });
    alerts.sort((a, b) => a.color - b.color);
    for (let i = 0; i < Math.min(2, alerts.length); i++) {
      const icon = this.needIcons[i];
      const circle = icon.children[0] as PIXI.Graphics;
      circle.clear().circle(0, 0, 4).fill(alerts[i].color);
      icon.visible = true;
    }
  }

  updateActionLabel(action: any, locationName?: string) {
    if (!action) { this.actionLabel.text = ""; return; }
    const type = typeof action === "string" ? action : action.type ?? "";
    const label = type.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    let text = locationName ? `${label} at ${locationName}` : label;
    if (text.length > 20) text = text.slice(0, 19) + "…";
    this.actionLabel.text = text;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
