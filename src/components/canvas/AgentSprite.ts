import * as PIXI from "pixi.js";
import { getMoodColor, AGENT_RADIUS } from "../../lib/spriteConfig";
import { facingFromStep, pickAgentFrame, type SheetFacing } from "./agentFrames";
import { loadAgentSheet } from "./agentSheet";

const LERP_SPEED = 0.12;

// Procedural animation tuning (audit H1: static sprites glide like chess pieces).
const WALK_BOB_RATE = 0.55;      // walk-cycle radians advanced per pixel traveled
const WALK_BOB_HEIGHT = 1.6;     // px of vertical hop at bob peak
const WALK_SWAY = 0.055;         // radians of side-to-side lean while walking
const WALK_MIN_STEP = 0.08;      // px moved per frame below which agent counts as idle
const FLIP_MIN_DX = 0.04;        // horizontal px per frame needed to change facing
const IDLE_BREATH_RATE = 0.028;  // radians per frame (~3.7s period at 60fps)
const IDLE_BREATH_SCALE = 0.02;  // peak scale.y delta while breathing
const SETTLE = 0.75;             // per-frame decay pulling walk offsets back to rest

// Sleep pose (audit M4: sleeping agents looked identical to idle ones).
const SLEEP_ROTATION = Math.PI / 2;  // lie down, pivoting on the feet anchor
// Rotating about the feet anchor throws the body sideways and half of it below the
// ground line, so recenter it over the agent's position.
const SLEEP_SHIFT_X = 12.8;          // px back toward the agent after the rotation
const SLEEP_GROUND_DROP = 2;         // px the lying body sinks toward the ground line
const SLEEP_BREATH_RATE = 0.012;     // slower than idle — deep sleep breathing
const SLEEP_BREATH_SCALE = 0.035;    // deeper than idle so it reads at low zoom
const POSE_LERP = 0.15;              // per-frame blend into/out of the lying pose

// Sitting pose — driven by `current_action.pose`, which the server stamps for
// agents parked in a seated zone (bar stools, benches, booths, desks).
const SIT_DROP = 3.5;                // px the body settles down onto the seat
const SIT_SQUASH = 0.14;             // scale.y compression: knees bent, torso lower
const SIT_LEAN = 0.05;               // radians of slouch toward `facing`

// Working pose — a repeating effort motion so labour reads as labour.
const WORK_RATE = 0.09;              // radians per frame (~1.2s per stroke at 60fps)
const WORK_BOB_HEIGHT = 2.2;         // px the body dips at the bottom of a stroke
const WORK_LEAN = 0.13;              // radians of forward lean at full stroke

// Blinking (sheet sprites only): a closed-eye frame every few seconds, desynced per agent.
const BLINK_MIN_GAP = 150;           // frames (~2.5s at 60fps) between blinks, minimum
const BLINK_GAP_SPREAD = 240;        // extra random frames on top of the minimum
const BLINK_LENGTH = 7;              // frames the eyes stay shut
// The server moves agents one step per sim tick, so a walk is a string of short glides with
// pauses between them. Turning to the camera on every pause made northbound walkers flip
// between back and face each tile; only a real stop (this long) turns them around.
const TURN_TO_CAMERA_AFTER = 90;     // idle frames (~1.5s at 60fps)

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
  /** Animation frames from `<key>_sheet.png`; null while loading or for static sprites. */
  private frames: PIXI.Texture[] | null = null;
  private sheetFacing: SheetFacing = 'down';
  private walkDistance = 0;
  private idleFrames = 0;
  private blinkCountdown = BLINK_MIN_GAP + Math.random() * BLINK_GAP_SPREAD;
  private fallback: PIXI.Graphics | null = null;
  private nameLabel: PIXI.Text;
  private stateRing: PIXI.Graphics;

  private targetPos = { x: 0, y: 0 };

  // Procedural animation state
  private walkPhase = 0;
  private idlePhase = Math.random() * Math.PI * 2; // desync breathing across agents
  private facing: 1 | -1 = 1;
  private actionType = 'idle';
  private poseBlend = 0; // 0 = upright, 1 = fully lying down
  private sitBlend = 0;  // 0 = standing, 1 = fully seated
  private workBlend = 0; // 0 = still, 1 = full work motion
  private workPhase = 0;
  private seated = false;

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
    // Bright fill + dark pill backing keeps names readable on any terrain
    // (light plaza sand, dark evening grass) — fresh-eyes audit r17.
    this.nameLabel = new PIXI.Text({
      text: name,
      style: {
        fontFamily: "monospace",
        fontSize: 7,
        fill: 0xe8e0d0,
        stroke: { color: 0x000000, width: 2 },
        align: "center",
      },
    });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.position.set(0, AGENT_RADIUS + 6);
    const pill = new PIXI.Graphics();
    pill.roundRect(
      -this.nameLabel.width / 2 - 3,
      AGENT_RADIUS + 5,
      this.nameLabel.width + 6,
      this.nameLabel.height + 2,
      3,
    ).fill({ color: 0x000000, alpha: 0.4 });
    this.container.addChild(pill);
    this.container.addChild(this.nameLabel);
  }

  private loadSprite(spriteKey: string, name: string) {
    // PIXI v8: Sprite.from(url) only reads from cache; must Assets.load() first.
    // Build fallback immediately so there's something visible while texture loads.
    this.buildFallback(name);
    // Prefer the animation sheet; agents without one (custom residents, or a key whose
    // sheet was never generated) keep the single static frame.
    loadAgentSheet(spriteKey)
      .then(frames => {
        if (this.container.destroyed) return;
        this.frames = frames;
        this.attachSprite(frames[0]);
      })
      .catch(() => {
        const url = `/sprites/agents/${spriteKey}.png`;
        return PIXI.Assets.load(url).then((texture: PIXI.Texture) => {
          if (this.container.destroyed) return;
          texture.source.scaleMode = 'nearest';
          this.attachSprite(texture);
        });
      })
      .catch(() => this.onSpriteLoadFailed(name));
  }

  private attachSprite(texture: PIXI.Texture) {
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

  /**
   * Record where the server says the agent is. Stepping toward it is the
   * ticker's job — `lerp` also advances the procedural animation, so moving
   * from the data path too would give sprites extra frames on every sim tick.
   */
  setTarget(targetX: number, targetY: number) {
    this.targetPos.x = targetX;
    this.targetPos.y = targetY;
  }

  /** Lerp container position toward stored target without changing it. */
  lerp(deltaTime: number) {
    const dx = this.targetPos.x - this.container.x;
    const dy = this.targetPos.y - this.container.y;
    const t = Math.min(1, deltaTime * LERP_SPEED);
    const stepX = dx * t;
    const stepY = dy * t;
    this.container.x += stepX;
    this.container.y += stepY;
    this.animate(stepX, stepY, deltaTime);
  }

  /** Current server-side action, used to pick a pose (e.g. lying down while asleep). */
  setActionType(actionType: string) {
    this.actionType = actionType;
  }

  /**
   * Whether the agent's current action places them on furniture they'd sit on.
   * Comes from the server (`current_action.pose`) because the zone that decides
   * it is not part of the client's world model.
   */
  setSeated(seated: boolean) {
    this.seated = seated;
  }

  /**
   * 0 = upright, 1 = fully lying down. Head-anchored overlays (bubbles, emotes)
   * use this to drop with the body instead of floating where the head used to be.
   */
  get lyingBlend(): number {
    return this.poseBlend;
  }

  /**
   * Procedural motion: walk bob + lean driven by distance traveled, facing flip
   * from horizontal direction, breathing while idle, lying down while asleep. All
   * transforms apply to the body sprite only — rings, label, and glow stay planted
   * at the feet.
   *
   * The pose/phase bookkeeping runs whether or not the body sprite exists: an
   * agent still rendering as a fallback circle (texture failed, or not loaded
   * yet) otherwise kept `poseBlend` at 0 forever, which anchored its sleep
   * bubbles at standing head height. Only the sprite transforms are guarded.
   */
  private animate(stepX: number, stepY: number, deltaTime: number) {
    const body = this.sprite;

    const dist = Math.hypot(stepX, stepY);

    const sleeping = this.actionType === 'sleeping';
    this.poseBlend += ((sleeping ? 1 : 0) - this.poseBlend) * Math.min(1, POSE_LERP * deltaTime);

    // Facing freezes once the body commits to lying down — otherwise a sub-pixel
    // nudge would snap the sleeper's head 180 degrees.
    if (this.poseBlend < 0.01 && Math.abs(stepX) > FLIP_MIN_DX * deltaTime) {
      this.facing = stepX < 0 ? -1 : 1;
    }

    if (this.poseBlend > 0.01) {
      // Lying down: rotate about the feet anchor so the head falls toward `facing`.
      // A sleeper shows the front idle frame — eyes open or not, it reads as a body in bed.
      this.walkPhase = 0;
      this.sheetFacing = 'down';
      this.showFrame(false);
      this.idlePhase += SLEEP_BREATH_RATE * deltaTime;
      if (body) {
        body.rotation = this.facing * SLEEP_ROTATION * this.poseBlend;
        body.x = -this.facing * SLEEP_SHIFT_X * this.poseBlend;
        body.y = SLEEP_GROUND_DROP * this.poseBlend;
        const breath = Math.sin(this.idlePhase) * SLEEP_BREATH_SCALE * this.poseBlend;
        body.scale.set(this.facing, 1 + breath);
      }
      return;
    }

    if (body) body.x *= SETTLE; // decay the lying offset after waking

    const walking = dist > WALK_MIN_STEP * deltaTime;

    // Standing poses blend rather than snap, so an agent dropping onto a bar
    // stool eases into it the same way a sleeper eases into the bed.
    const blendStep = Math.min(1, POSE_LERP * deltaTime);
    this.sitBlend += ((this.seated && !walking ? 1 : 0) - this.sitBlend) * blendStep;
    this.workBlend +=
      ((this.actionType === 'working' && !walking ? 1 : 0) - this.workBlend) * blendStep;
    if (this.workBlend > 0.01) this.workPhase += WORK_RATE * deltaTime;

    if (walking) {
      this.sheetFacing = facingFromStep(stepX, stepY, this.sheetFacing);
      this.walkDistance += dist;
      this.idleFrames = 0;
      this.showFrame(true);
      // Walking: hop + lean, cycle speed tied to actual ground covered. Sheet sprites
      // already bob and swap legs in their frames; the procedural hop on top of that
      // made them bounce like they were on springs, so they only keep the facing flip.
      this.walkPhase += dist * WALK_BOB_RATE;
      if (body) {
        const procedural = this.frames ? 0 : 1;
        body.y = -Math.abs(Math.sin(this.walkPhase)) * WALK_BOB_HEIGHT * procedural;
        body.rotation = Math.sin(this.walkPhase) * WALK_SWAY * procedural;
        body.scale.set(this.facing, 1);
      }
    } else {
      // Stopped agents turn to face the camera unless they're busy with something in
      // front of them — a worker at a bench or someone seated at a counter keeps their back.
      // walkDistance is kept, so the leg cycle resumes where it was after a between-tick pause.
      this.idleFrames += deltaTime;
      if (this.idleFrames > TURN_TO_CAMERA_AFTER && this.workBlend < 0.01 && this.sitBlend < 0.01) {
        this.sheetFacing = 'down';
      }
      this.blinkCountdown -= deltaTime;
      const blinking = this.blinkCountdown < BLINK_LENGTH;
      if (this.blinkCountdown <= 0) {
        this.blinkCountdown = BLINK_MIN_GAP + Math.random() * BLINK_GAP_SPREAD;
      }
      this.showFrame(false, blinking);
      // Idle: breathe, plus whatever the current pose adds. Offsets are absolute
      // rather than decayed so sitting and working hold their shape instead of
      // being pulled back to rest every frame.
      this.idlePhase += IDLE_BREATH_RATE * deltaTime;
      if (body) {
        const breath = Math.sin(this.idlePhase) * IDLE_BREATH_SCALE;
        // Half-wave: the effort stroke dips and returns, it does not rise above rest.
        const stroke = Math.abs(Math.sin(this.workPhase)) * this.workBlend;
        body.y = SIT_DROP * this.sitBlend + stroke * WORK_BOB_HEIGHT;
        body.rotation = this.facing * (SIT_LEAN * this.sitBlend + WORK_LEAN * stroke);
        body.scale.set(
          this.facing * (1 - breath * 0.5),
          (1 + breath) * (1 - SIT_SQUASH * this.sitBlend),
        );
      }
    }
  }

  private showFrame(walking: boolean, blinking = false) {
    if (!this.frames || !this.sprite) return;
    const i = pickAgentFrame({
      facing: this.sheetFacing,
      walking,
      walkDistance: this.walkDistance,
      blinking,
    });
    const tex = this.frames[i];
    if (this.sprite.texture !== tex) this.sprite.texture = tex;
  }

  /**
   * Override the horizontal facing. Normally facing follows the step delta, but a
   * standing conversation produces no delta, so participants keep whatever
   * direction they happened to arrive in — often back to back. The next walk step
   * takes it over again, and a sleeping body ignores it (facing is frozen there).
   */
  setFacing(dir: 1 | -1) {
    if (this.poseBlend < 0.01) this.facing = dir;
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
