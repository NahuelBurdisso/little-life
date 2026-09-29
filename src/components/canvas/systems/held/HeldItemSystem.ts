import * as PIXI from "pixi.js";
import { actionTypeOf } from "../../SpritePool";
import type { AgentData, SpritePool } from "../../SpritePool";
import type { AgentSprite } from "../../AgentSprite";
import { loadStrip } from "../../stripAtlas";
import { inView } from "../view";
import type { CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { HELD_FRAME_COUNT, HELD_FRAME_SIZE, HELD_ITEMS, HELD_URL } from "./heldFrames";
import type { HeldItemId } from "./heldFrames";
import { bagDeadline, heldItemFor, heldPose } from "./heldItem";
import { isShoppingTrip } from "../activityFx/activity";
import { agentPhase } from "../activityFx/emitters";
import type { HeldPose } from "./heldItem";

/** Below this `lyingBlend` the body is still upright enough to hold something in front. */
const LYING_HIDE_ABOVE = 0.3;

/** One agent's slot. The sprite is created lazily, lives in the agent's `hand` and is reused. */
interface Entry {
  id: string;
  /** Stable per-agent offset (seconds) so neighbours don't sip and sway in lockstep. */
  phase: number;
  item: HeldItemId | null;
  agent: AgentSprite | null;
  sprite: PIXI.Sprite | null;
  /** The item the pooled sprite is currently set up for (anchor). */
  shown: HeldItemId | null;
  /** onData generation that last saw this agent — older entries belong to gone agents. */
  seen: number;
  /** Was on a shopping trip (shopping, browsing) at the last poll. */
  onTrip: boolean;
  /** performance.now() until which the shopping bag stays in hand (0 = none). */
  bagUntil: number;
}

/**
 * Tools in hand: a bakery worker holds a rolling pin, a smith a hammer, a diner a plate.
 *
 * What to hold is decided in `onData` (once per poll, `heldItemFor`); each frame only
 * writes the pooled sprite's transform (swing with the body's work stroke, bobbing rod,
 * tipping mug). The sprite is a child of the agent's `hand` container, so it follows the
 * body rig, mirrors with facing and bobs with the walk cycle for free.
 */
class HeldItemSystem implements CanvasSystem {
  private textures: PIXI.Texture[] | null = null;
  private readonly entries = new Map<string, Entry>();
  /** Same entries as an array, so the per-frame loop allocates no iterator. */
  private list: Entry[] = [];
  private readonly locationTypes = new Map<number, string>();
  private readonly pose: HeldPose = { rot: 0, dy: 0, alt: false };
  private generation = 0;
  private destroyed = false;

  constructor(private readonly sprites: SpritePool) {
    loadStrip(HELD_URL, HELD_FRAME_COUNT, HELD_FRAME_SIZE)
      .then(t => { if (!this.destroyed) this.textures = t; })
      .catch(err => console.warn("[held items] atlas failed to load:", err));
  }

  onData(data: DataContext): void {
    this.generation++;
    this.locationTypes.clear();
    for (const l of data.locations) {
      if (typeof l?.id === "number" && typeof l?.type === "string") this.locationTypes.set(l.id, l.type);
    }

    let added = false;
    for (const agent of data.agents) {
      const id = String(agent.id);
      let e = this.entries.get(id);
      if (!e) {
        e = { id, phase: agentPhase(agent.id), item: null, agent: null, sprite: null, shown: null, seen: 0, onTrip: false, bagUntil: 0 };
        this.entries.set(id, e);
        added = true;
      }
      e.seen = this.generation;
      e.item = this.itemFor(agent, e);
      const body = this.sprites.getSprite(id) ?? null;
      if (body !== e.agent) {
        // The pool rebuilt this agent's sprite (world replace...); its old hand died with it.
        this.dropSprite(e);
        e.agent = body;
      }
    }

    let removed = false;
    for (const e of this.list) {
      if (e.seen !== this.generation) { this.dropSprite(e); this.entries.delete(e.id); removed = true; }
    }
    if (added || removed) this.list = Array.from(this.entries.values());
  }

  update(frame: FrameContext): void {
    const textures = this.textures;
    if (!textures) return;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      try {
        this.animate(e, textures, frame);
      } catch (err) {
        // One bad agent must not stop the rest (or the canvas).
        if (e.sprite) e.sprite.visible = false;
        console.warn("[held items] update failed:", err);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const e of this.list) this.dropSprite(e);
    this.entries.clear();
    this.list = [];
  }

  private animate(e: Entry, textures: PIXI.Texture[], frame: FrameContext): void {
    const body = e.agent;
    const item = e.item;
    if (!body || !item) {
      if (e.sprite && !e.sprite.destroyed) e.sprite.visible = false;
      return;
    }
    const def = HELD_ITEMS[item];
    // Back to the camera: held-out tools still show at the body's side, but a plate or
    // book held at the chest would only be seen through the torso. Side-on it is held out in
    // front of the chest, so everything shows. Lying: nothing to hold.
    const show =
      inView(frame.view, body.x, body.y) &&
      body.lyingBlend < LYING_HIDE_ABOVE &&
      (body.viewFacing !== "up" || def.visibleFromBehind);
    if (!show) {
      if (e.sprite && !e.sprite.destroyed) e.sprite.visible = false;
      return;
    }

    let sprite = e.sprite;
    if (!sprite || sprite.destroyed) {
      sprite = new PIXI.Sprite(textures[def.frame]);
      sprite.eventMode = "none";
      body.hand.addChild(sprite);
      e.sprite = sprite;
      e.shown = null;
    }
    if (e.shown !== item) {
      // Pivot on the grip so swings rotate about the fist.
      sprite.anchor.set(def.grip.x / HELD_FRAME_SIZE, def.grip.y / HELD_FRAME_SIZE);
      e.shown = item;
    }

    // Absolute time: `frame.seconds` is the frame's delta, which froze every sway and sip.
    const p = heldPose(def, frame.now / 1000, body.workStroke, e.phase, this.pose);
    const tex = textures[p.alt && def.altFrame !== null ? def.altFrame : def.frame];
    if (sprite.texture !== tex) sprite.texture = tex;
    sprite.rotation = p.rot;
    sprite.y = p.dy;
    sprite.visible = true;
  }

  private itemFor(agent: AgentData, e: Entry): HeldItemId | null {
    const raw = agent.current_action;
    const zone = typeof raw === "object" && raw ? (raw as { zoneActivity?: string }).zoneActivity : undefined;
    const here = agent.current_location ?? null;
    const type = actionTypeOf(agent);
    const trip = isShoppingTrip(type, zone ?? null);
    e.bagUntil = bagDeadline(e.onTrip, trip, performance.now(), e.bagUntil);
    e.onTrip = trip;
    return heldItemFor({
      actionType: type,
      bag: e.bagUntil > 0,
      zoneActivity: zone ?? null,
      locationType: here != null ? this.locationTypes.get(here) ?? null : null,
      atWorkplace: agent.workplace != null && here === agent.workplace,
      workplaceType: agent.workplace != null ? this.locationTypes.get(agent.workplace) ?? null : null,
    });
  }

  private dropSprite(e: Entry): void {
    // AgentSprite.destroy() takes its hand's children with it, so it may already be gone.
    if (e.sprite && !e.sprite.destroyed) e.sprite.destroy();
    e.sprite = null;
    e.shown = null;
  }
}

export const createHeldItemSystem: SystemFactory = (_layers, services) => new HeldItemSystem(services.sprites);
