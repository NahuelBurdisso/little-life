import * as PIXI from "pixi.js";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext } from "../types";
import { inView } from "../view";
import { loadStrip } from "../../stripAtlas";
import { createDetectorState, detectBeats, type BeatKind, type BeatSnapshot } from "./beatDetect";
import {
  BEATS_FRAME_COUNT, BEATS_URL, BEAT_STYLE, FX_ANIMS, GHOST_RISE_PX, GIFT_TRAVEL_S, KISS_LEAN_S,
  beatDuration, fxFrame, kissFacing, type BeatStyle, type FxName,
} from "./beatFrames";
import type { ActivityPoseKind } from "../../statePose";

/** At most this many effects on screen at once; a new one evicts the oldest. */
const MAX_LIVE = 8;
/** Last stretch of an effect's life during which it fades out. */
const FADE_FRACTION = 0.25;

/** One pooled effect. Everything the per-frame path touches is a plain field. */
interface Slot {
  sprite: PIXI.Sprite;
  active: boolean;
  /** Spawn order, to find the oldest when the pool is full. */
  serial: number;
  style: BeatStyle;
  isGift: boolean;
  isGhost: boolean;
  fx: FxName;
  elapsed: number;
  duration: number;
  /** Anchor (the effect's centre before `lift`); for a gift the receiver. */
  x: number;
  y: number;
  /** Gift only: where the box takes off. */
  fromX: number;
  fromY: number;
  frame: number;
}

interface Point { x: number; y: number }

/**
 * A kiss leans its two agents together for `KISS_LEAN_S`. BeatSystem borrows the sprite's activity
 * pose for that long and gives back whatever it had (a kiss can begin mid-activity), but only if
 * the 'lean' is still the pose in place — ActivityFxSystem may have moved the agent on since.
 */
interface Lean {
  id: string;
  sprite: LeanSprite;
  until: number;
  prevKind: ActivityPoseKind;
  prevTint: number;
}
type LeanSprite = NonNullable<ReturnType<CanvasServices["sprites"]["getSprite"]>>;

/** A detected beat. (The player's own interventions are answered by systems/playerFx.) */
interface Spawn { kind: BeatKind; agentIds: number[]; at?: Point }

/**
 * Story beats on the map: fights, gifts, kisses, arrests, secrets, level-ups, birthdays,
 * deaths become one-second pixel effects between (or over)
 * the agents involved, plus the matching emote on each participant. Purely client-side — the
 * detection (beatDetect.ts) reads the activity feed and diffs the agent list; this class only
 * renders.
 */
class BeatSystem implements CanvasSystem {
  private readonly layers: CanvasLayers;
  private readonly services: CanvasServices;
  private readonly detector = createDetectorState();
  /** Reused every poll: only its fields change. */
  private readonly snap: BeatSnapshot = { activity: [], agents: [], relationships: [], events: [], removed: [] };
  private textures: PIXI.Texture[] | null = null;
  private readonly slots: Slot[] = [];
  private serial = 0;
  private live = 0;
  /** Kisses in progress. Small and rarely touched; the per-frame path only reads `until`. */
  private readonly leans: Lean[] = [];
  private leanClock = 0;
  private destroyed = false;

  constructor(layers: CanvasLayers, services: CanvasServices) {
    this.layers = layers;
    this.services = services;
    loadStrip(BEATS_URL, BEATS_FRAME_COUNT).then(t => {
      if (!this.destroyed) this.textures = t;
    }).catch(err => {
      // Emotes still play without the atlas; only the map effects are lost.
      console.warn("[beats] FX atlas failed to load:", err);
    });
  }

  onData(data: DataContext): void {
    const s = this.snap;
    s.activity = data.activity;
    s.agents = data.agents;
    s.relationships = data.relationships;
    // A beat is keyed by its event's id; a row without one (never sent by the server) has no beat.
    s.events = data.events.filter((e): e is typeof e & { id: number } => e?.id != null);
    // Valid right now only: SpritePool refills it on every update.
    s.removed = this.services.sprites.recentlyRemoved;
    // Activity rows carry wall-clock `real_timestamp`s, so the detector's clock is Date.now().
    for (const beat of detectBeats(this.detector, s, Date.now())) this.spawn(beat);
  }

  private where(id: number): Point | null {
    const sp = this.services.sprites.getSprite(String(id));
    return sp ? { x: sp.x, y: sp.y } : null;
  }

  private spawn(beat: Spawn): void {
    try {
      this.spawnUnsafe(beat);
    } catch (err) {
      console.warn("[beats] spawn failed:", err);
    }
  }

  private spawnUnsafe(beat: Spawn): void {
    const kind = beat.kind;
    const style = BEAT_STYLE[kind];
    if (!style) return;

    const pts: Array<Point | null> = beat.agentIds.map(id => this.where(id));
    const a0 = pts[0], b0 = pts[1];
    // Emotes first: they work even while the atlas is still loading.
    for (let i = 0; i < 2; i++) {
      const name = style.emotes[i];
      const p = pts[i];
      if (name && p) this.services.bubbles.showEmote(String(beat.agentIds[i]), name, p);
    }

    if (kind === "kiss" && a0 && b0) this.leanTogether(String(beat.agentIds[0]), String(beat.agentIds[1]), a0, b0);

    // Anchor of the effect: the death spot, the first agent, or the midpoint of the pair.
    let ax: number, ay: number;
    const a = pts[0], b = pts[1];
    if (beat.at) { ax = beat.at.x; ay = beat.at.y; }
    else if (a && b && (kind === "fight" || kind === "romance" || kind === "heartbreak" || kind === "secret" || kind === "kiss")) {
      ax = (a.x + b.x) / 2; ay = (a.y + b.y) / 2;
    } else if (kind === "gift") {
      const to = b ?? a;
      if (!to) return;
      ax = to.x; ay = to.y;
    } else {
      const first = a ?? b;
      if (!first) return;
      ax = first.x; ay = first.y;
    }
    if (!this.textures) return;

    const slot = this.acquire();
    slot.serial = ++this.serial;
    slot.style = style;
    slot.fx = style.fx;
    slot.isGift = kind === "gift";
    slot.isGhost = kind === "death";
    slot.elapsed = 0;
    slot.duration = beatDuration(kind);
    slot.x = ax + (style.dx ?? 0);
    slot.y = ay;
    slot.fromX = a ? a.x : ax;
    slot.fromY = a ? a.y : ay;
    slot.frame = -1;
    slot.active = true;
    slot.sprite.visible = true;
    slot.sprite.alpha = 1;
    slot.sprite.scale.set(style.scale ?? 1, (style.scale ?? 1) * (style.squashY ?? 1));
    this.live++;
  }

  /** Turn the pair toward each other and start their lean; a repeat kiss just extends it. */
  private leanTogether(idA: string, idB: string, a: Point, b: Point): void {
    const sprites = this.services.sprites;
    const spriteA = sprites.getSprite(idA), spriteB = sprites.getSprite(idB);
    if (!spriteA || !spriteB) return;
    const face = kissFacing(a.x, b.x);
    if (face) { spriteA.setFacing(face[0]); spriteB.setFacing(face[1]); }
    this.lean(idA, spriteA);
    this.lean(idB, spriteB);
  }

  private lean(id: string, sprite: LeanSprite): void {
    const until = this.leanClock + KISS_LEAN_S;
    for (const l of this.leans) {
      if (l.id === id && l.sprite === sprite) { l.until = until; return; }
    }
    const prevKind = sprite.activityPoseKind, prevTint = sprite.activityPoseTint;
    sprite.setActivityPose("lean", prevTint);
    this.leans.push({ id, sprite, until, prevKind, prevTint });
  }

  /** Give the pose back once a kiss is over; drop entries whose sprite was replaced or removed. */
  private tickLeans(dt: number): void {
    this.leanClock += dt;
    for (let i = this.leans.length - 1; i >= 0; i--) {
      const l = this.leans[i];
      const gone = this.services.sprites.getSprite(l.id) !== l.sprite;
      if (!gone && this.leanClock < l.until) continue;
      if (!gone && l.sprite.activityPoseKind === "lean") l.sprite.setActivityPose(l.prevKind, l.prevTint);
      this.leans[i] = this.leans[this.leans.length - 1];
      this.leans.pop();
    }
  }

  /** A free slot, or the oldest live one when all `MAX_LIVE` are busy. */
  private acquire(): Slot {
    for (const s of this.slots) if (!s.active) return s;
    if (this.slots.length < MAX_LIVE) {
      const sprite = new PIXI.Sprite(this.textures![0]);
      sprite.anchor.set(0.5);
      sprite.eventMode = "none";
      sprite.visible = false;
      this.layers.overAgents.addChild(sprite);
      const slot: Slot = {
        sprite, active: false, serial: 0, style: BEAT_STYLE.fight, isGift: false, isGhost: false,
        fx: "brawl", elapsed: 0, duration: 1, x: 0, y: 0, fromX: 0, fromY: 0, frame: -1,
      };
      this.slots.push(slot);
      return slot;
    }
    let oldest = this.slots[0];
    for (const s of this.slots) if (s.serial < oldest.serial) oldest = s;
    this.live--; // it is being replaced; `spawn` counts the new one
    oldest.active = false;
    return oldest;
  }

  update(frame: FrameContext): void {
    if (this.leans.length > 0) this.tickLeans(frame.seconds);
    if (this.live === 0 || !this.textures) return;
    const tex = this.textures;
    const dt = frame.seconds;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      s.elapsed += dt;
      if (s.elapsed >= s.duration) {
        s.active = false;
        s.sprite.visible = false;
        this.live--;
        continue;
      }

      let cell: number;
      let x = s.x;
      let y = s.y - s.style.lift;
      if (s.isGift && s.elapsed < GIFT_TRAVEL_S) {
        // The wrapped box hops from giver to receiver along a small arc.
        const f = s.elapsed / GIFT_TRAVEL_S;
        const e = f * f * (3 - 2 * f);
        x = s.fromX + (s.x - s.fromX) * e;
        y = s.fromY + (s.y - s.fromY) * e - s.style.lift - Math.sin(f * Math.PI) * 10;
        cell = FX_ANIMS.giftBox.start;
      } else if (s.isGift) {
        cell = fxFrame("giftPop", s.elapsed - GIFT_TRAVEL_S);
      } else {
        cell = fxFrame(s.fx, s.elapsed);
        if (s.isGhost) {
          const f = s.elapsed / s.duration;
          y -= f * GHOST_RISE_PX;
          x += Math.sin(s.elapsed * 3) * 1.5;
        }
      }

      const sprite = s.sprite;
      if (cell !== s.frame) {
        s.frame = cell;
        sprite.texture = tex[cell];
      }
      sprite.position.set(x, y);
      const left = s.duration - s.elapsed;
      const fadeSpan = s.duration * FADE_FRACTION;
      sprite.alpha = left < fadeSpan ? left / fadeSpan : 1;
      sprite.visible = inView(frame.view, x, y);
    }
  }

  destroy(): void {
    this.destroyed = true;
    // Give every borrowed pose back: the sprites outlive this system on a canvas rebuild.
    this.leanClock = Infinity;
    this.tickLeans(0);
    for (const s of this.slots) {
      s.sprite.parent?.removeChild(s.sprite);
      s.sprite.destroy();
    }
    this.slots.length = 0;
    this.live = 0;
    this.textures = null;
  }
}

export function createBeatSystem(layers: CanvasLayers, services: CanvasServices): CanvasSystem {
  return new BeatSystem(layers, services);
}
