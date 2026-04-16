import * as PIXI from "pixi.js";
import { getAgentColor, AGENT_RADIUS } from "../../lib/spriteConfig";

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

/** Represents a single agent's visual on the canvas as a colored circle with a letter. */
export class AgentSprite {
  container: PIXI.Container;

  private interiorGlow: PIXI.Graphics;
  private selectionRing: PIXI.Graphics;
  private circle: PIXI.Graphics;
  private letter: PIXI.Text;
  private nameLabel: PIXI.Text;
  private stateRing: PIXI.Graphics;

  private targetPos = { x: 0, y: 0 };

  constructor(name: string) {
    this.container = new PIXI.Container();

    // --- Interior glow (behind everything, visible when inside a building) ---
    this.interiorGlow = new PIXI.Graphics();
    this.interiorGlow.circle(0, 0, AGENT_RADIUS * 1.8);
    this.interiorGlow.fill({ color: 0xffffff, alpha: 0.12 });
    this.interiorGlow.blendMode = 'add';
    this.interiorGlow.visible = false;
    this.container.addChildAt(this.interiorGlow, 0);

    // --- Selection ring (yellow ellipse at feet) ---
    this.selectionRing = new PIXI.Graphics();
    this.selectionRing
      .ellipse(0, AGENT_RADIUS, 14, 5)
      .stroke({ color: 0xffdd44, width: 2, alpha: 0.8 });
    this.selectionRing.visible = false;
    this.container.addChild(this.selectionRing);

    // --- Colored circle ---
    this.circle = new PIXI.Graphics();
    this.circle.circle(0, 0, AGENT_RADIUS);
    this.circle.fill({ color: getAgentColor(name) });
    this.container.addChild(this.circle);

    // --- State ring (colored ring showing active state) ---
    this.stateRing = new PIXI.Graphics();
    this.stateRing.visible = false;
    this.container.addChild(this.stateRing);

    // --- First letter of name ---
    this.letter = new PIXI.Text({
      text: name.charAt(0).toUpperCase(),
      style: {
        fontSize: 10,
        fontWeight: "bold",
        fill: 0xffffff,
        fontFamily: "monospace",
      },
    });
    this.letter.anchor.set(0.5);
    this.letter.position.set(0, 0);
    this.container.addChild(this.letter);

    // --- Name label (below circle) ---
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
    this.nameLabel.position.set(0, AGENT_RADIUS + 4);
    this.container.addChild(this.nameLabel);
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
      this.stateRing.circle(0, 0, AGENT_RADIUS + 3);
      this.stateRing.stroke({ width: 2, color, alpha: 0.8 });
      this.stateRing.visible = true;
    } else {
      this.stateRing.visible = false;
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
