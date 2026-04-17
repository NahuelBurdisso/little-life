import * as PIXI from "pixi.js";
import { getMoodColor, AGENT_RADIUS } from "../../lib/spriteConfig";

const LERP_SPEED = 0.12;

/** Priority-ordered state ring colors. First match wins. */
const STATE_RING_COLORS: Record<string, number> = {
  angry: 0xef4444,
  jealous: 0xf43f5e,
  heartbroken: 0xfb7185,
  infatuated: 0xec4899,
  drunk: 0xf59e0b,
  alcoholic: 0xd97706,
  stressed: 0xf97316,
  in_debt: 0xea580c,
  depressed: 0x6366f1,
  lonely: 0x8b5cf6,
  sick: 0xa3e635,
  hungover: 0x84cc16,
  euphoric: 0x10b981,
  confident: 0x14b8a6,
  grieving: 0x6b7280,
};

const STATE_PRIORITY: string[] = [
  'angry', 'jealous', 'heartbroken', 'infatuated',
  'drunk', 'alcoholic', 'stressed', 'in_debt',
  'depressed', 'lonely', 'sick', 'hungover',
  'euphoric', 'confident', 'grieving',
];

/** Represents a single agent's visual on the canvas: pixel-art sprite with rings + label. */
export class AgentSprite {
  container: PIXI.Container;

  private interiorGlow: PIXI.Graphics;
  private selectionRing: PIXI.Graphics;
  private moodRing: PIXI.Graphics;
  private sprite: PIXI.Sprite | null = null;
  private fallback: PIXI.Graphics | null = null;
  private nameLabel: PIXI.Text;
  private stateRing: PIXI.Graphics;

  private targetPos = { x: 0, y: 0 };

  constructor(name: string, spriteKey?: string) {
    this.container = new PIXI.Container();

    // --- Interior glow (behind everything) ---
    this.interiorGlow = new PIXI.Graphics();
    this.interiorGlow.circle(0, 0, AGENT_RADIUS * 1.8);
    this.interiorGlow.fill({ color: 0xffffff, alpha: 0.12 });
    this.interiorGlow.blendMode = 'add';
    this.interiorGlow.visible = false;
    this.container.addChild(this.interiorGlow);

    // --- Selection ring (yellow ellipse at feet) ---
    this.selectionRing = new PIXI.Graphics();
    this.selectionRing
      .ellipse(0, AGENT_RADIUS, 14, 5)
      .stroke({ color: 0xc8a84b, width: 2, alpha: 0.8 });
    this.selectionRing.visible = false;
    this.container.addChild(this.selectionRing);

    // --- Mood ring under feet (colored ellipse) ---
    this.moodRing = new PIXI.Graphics();
    this.container.addChild(this.moodRing);

    // --- Sprite or fallback circle+letter ---
    if (spriteKey) {
      this.loadSprite(spriteKey, name);
    } else {
      this.buildFallback(name);
    }

    // --- State ring (active state indicator, above sprite) ---
    this.stateRing = new PIXI.Graphics();
    this.stateRing.visible = false;
    this.container.addChild(this.stateRing);

    // --- Name label below sprite ---
    this.nameLabel = new PIXI.Text({
      text: name,
      style: {
        fontFamily: "monospace",
        fontSize: 7,
        fill: 0xa09070,
        stroke: { color: 0x000000, width: 2 },
        align: "center",
      },
    });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.position.set(0, AGENT_RADIUS + 6);
    this.container.addChild(this.nameLabel);
  }

  private loadSprite(spriteKey: string, name: string) {
    const url = `/sprites/agents/${spriteKey}.png`;
    // PIXI v8: Sprite.from(url) only reads from cache; must Assets.load() first.
    // Build fallback immediately so there's something visible while texture loads.
    this.buildFallback(name);
    PIXI.Assets.load(url)
      .then((texture: PIXI.Texture) => {
        // If destroy() already ran, bail.
        if (this.container.destroyed) return;
        texture.source.scaleMode = 'nearest';
        const sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5, 0.9);
        sprite.scale.set(1);
        this.sprite = sprite;
        // Remove fallback now that real sprite is ready.
        if (this.fallback) {
          this.container.removeChild(this.fallback);
          this.fallback.destroy();
          this.fallback = null;
          // Also remove the fallback letter (it was added right after the circle).
          // Find and remove PIXI.Text children that aren't the name label.
          for (const child of [...this.container.children]) {
            if (child instanceof PIXI.Text && child !== this.nameLabel) {
              this.container.removeChild(child);
              child.destroy();
            }
          }
        }
        // Insert sprite below state ring (which is last-added before name label).
        const stateRingIdx = this.container.getChildIndex(this.stateRing);
        this.container.addChildAt(sprite, stateRingIdx);
      })
      .catch(() => this.onSpriteLoadFailed(name));
  }

  private onSpriteLoadFailed(name: string) {
    if (this.sprite) {
      this.container.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    if (!this.fallback) this.buildFallback(name);
  }

  private buildFallback(name: string) {
    const circle = new PIXI.Graphics();
    circle.circle(0, 0, AGENT_RADIUS);
    circle.fill({ color: 0x2a2520 });
    circle.stroke({ width: 1.5, color: 0x7a6f5a });
    this.fallback = circle;
    this.container.addChild(circle);

    const letter = new PIXI.Text({
      text: name.charAt(0).toUpperCase(),
      style: {
        fontSize: 10,
        fontWeight: "bold",
        fill: 0xd4c9a8,
        fontFamily: "monospace",
      },
    });
    letter.anchor.set(0.5);
    letter.position.set(0, 0);
    this.container.addChild(letter);
  }

  /** Set target and lerp toward it. */
  update(targetX: number, targetY: number, deltaTime: number) {
    this.targetPos.x = targetX;
    this.targetPos.y = targetY;
    this.lerp(deltaTime);
  }

  /** Lerp container position toward stored target without changing it. */
  lerp(deltaTime: number) {
    const dx = this.targetPos.x - this.container.x;
    const dy = this.targetPos.y - this.container.y;
    const t = Math.min(1, deltaTime * LERP_SPEED);
    this.container.x += dx * t;
    this.container.y += dy * t;
  }

  /** Snap position without lerp (e.g. on first placement). */
  setPositionImmediate(x: number, y: number) {
    this.targetPos.x = x;
    this.targetPos.y = y;
    this.container.x = x;
    this.container.y = y;
  }

  /** Show or hide the selection ring. */
  setSelected(selected: boolean) {
    this.selectionRing.visible = selected;
  }

  /** Update state ring color based on active states. */
  updateStates(activeStates: Array<{ type: string; metadata?: any }>) {
    const topState = STATE_PRIORITY.find(s => activeStates.some(as => as.type === s));

    if (topState) {
      const color = STATE_RING_COLORS[topState] ?? 0x6b7280;
      this.stateRing.clear();
      this.stateRing.ellipse(0, AGENT_RADIUS, 12, 4);
      this.stateRing.stroke({ width: 2, color, alpha: 0.85 });
      this.stateRing.visible = true;
    } else {
      this.stateRing.visible = false;
    }
  }

  /** Mood-based tint on sprite + colored foot ring. */
  updateMood(mood: number): void {
    const moodColor = getMoodColor(mood);
    // Foot mood ring
    this.moodRing.clear();
    this.moodRing.ellipse(0, AGENT_RADIUS + 1, 10, 3);
    this.moodRing.fill({ color: moodColor, alpha: 0.5 });

    // Fallback circle: recolor stroke
    if (this.fallback) {
      this.fallback.clear();
      this.fallback.circle(0, 0, AGENT_RADIUS);
      this.fallback.fill({ color: 0x2a2520 });
      this.fallback.stroke({ width: 1.5, color: moodColor });
    }

    // Sprite: subtle tint based on mood (dark = despair, bright = thriving)
    if (this.sprite) {
      const t = Math.max(0, Math.min(1, mood / 100));
      // Lerp from dim (0x808080) to full bright (0xffffff)
      const shade = Math.round(128 + 127 * t);
      this.sprite.tint = (shade << 16) | (shade << 8) | shade;
    }
  }

  /** Show or hide the interior glow effect. */
  setInsideBuilding(inside: boolean): void {
    this.interiorGlow.visible = inside;
  }

  get x(): number {
    return this.container.x;
  }

  get y(): number {
    return this.container.y;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
