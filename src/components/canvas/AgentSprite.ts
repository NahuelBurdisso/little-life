import * as PIXI from "pixi.js";
import { getAgentColor, AGENT_RADIUS } from "../../lib/spriteConfig";

const LERP_SPEED = 0.12;

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

/** Dramatic state emojis override action emojis when active. */
const STATE_EMOJIS: Record<string, string> = {
  in_debt: '\u{1F4B0}',       // 💰
  alcoholic: '\u{1F37A}',     // 🍺
  heartbroken: '\u{1F494}',   // 💔
  jealous: '\u{1F612}',       // 😒
  angry: '\u{1F621}',         // 😡
  infatuated: '\u{1F60D}',    // 😍
  depressed: '\u{1F61E}',     // 😞
  lonely: '\u{1F614}',        // 😔
  sick: '\u{1F912}',          // 🤒
  drunk: '\u{1F974}',         // 🥴
  euphoric: '\u{1F604}',      // 😄
  confident: '\u{1F60E}',     // 😎
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

/** Represents a single agent's visual on the canvas as a colored circle with a letter. */
export class AgentSprite {
  container: PIXI.Container;

  private selectionRing: PIXI.Graphics;
  private circle: PIXI.Graphics;
  private letter: PIXI.Text;
  private nameLabel: PIXI.Text;

  // Status indicator elements
  private statusContainer: PIXI.Container;
  private actionLabel: PIXI.Text;
  private moodDot: PIXI.Graphics;
  private needAlert: PIXI.Text;
  private pulseTimer = 0;
  private stateRing: PIXI.Graphics;
  private hasDramaticState = false;

  private targetPos = { x: 0, y: 0 };

  constructor(name: string) {
    this.container = new PIXI.Container();

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

    // --- Status container (above circle) ---
    this.statusContainer = new PIXI.Container();
    this.statusContainer.position.set(0, -AGENT_RADIUS - 14);
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
    this.actionLabel.position.set(-10, 0);
    this.statusContainer.addChild(this.actionLabel);

    this.moodDot = new PIXI.Graphics();
    this.moodDot.circle(0, 0, 4).fill({ color: 0x44cc44 });
    this.moodDot.position.set(2, 0);
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
    this.needAlert.position.set(14, 0);
    this.needAlert.visible = false;
    this.statusContainer.addChild(this.needAlert);
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

  /** Update emoji, mood dot color, and critical need alert. */
  updateStatus(actionType: string, needs: AgentNeeds | null | undefined, deltaTime: number) {
    // Don't overwrite if a dramatic state emoji is shown
    if (!this.hasDramaticState) {
      const emoji = ACTION_EMOJIS[actionType] ?? ACTION_EMOJIS["idle"];
      this.actionLabel.text = emoji;
    }

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
      this.pulseTimer += deltaTime * 4;
      this.needAlert.alpha = 0.4 + 0.6 * Math.abs(Math.sin(this.pulseTimer));
    }
  }

  /** Update state ring color and override action emoji for dramatic states. */
  updateStates(activeStates: Array<{ type: string; metadata?: any }>) {
    const topState = STATE_PRIORITY.find(s => activeStates.some(as => as.type === s));

    if (topState) {
      const color = STATE_RING_COLORS[topState] ?? 0x6b7280;
      this.stateRing.clear();
      this.stateRing.circle(0, 0, AGENT_RADIUS + 3);
      this.stateRing.stroke({ width: 2, color, alpha: 0.8 });
      this.stateRing.visible = true;

      // Override action emoji with state emoji
      if (STATE_EMOJIS[topState]) {
        this.actionLabel.text = STATE_EMOJIS[topState];
        this.hasDramaticState = true;
      } else {
        this.hasDramaticState = false;
      }
    } else {
      this.stateRing.visible = false;
      this.hasDramaticState = false;
    }
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
