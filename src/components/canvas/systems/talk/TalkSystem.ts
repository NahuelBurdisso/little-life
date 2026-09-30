import * as PIXI from "pixi.js";
import { inferTier } from "../../../../lib/director";
import { idString } from "../../idString";
import type { CanvasLayers, CanvasServices, CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { inView } from "../view";
import {
  arcBow, groupAnchors, latestSpeaker, lineWidth, pulseT, talkTone, zoomFade,
} from "./talkLinks";
import type { Pt, Seg } from "./talkLinks";

/** Head height: where the link attaches, above the feet anchor (the old arc's 14 px). */
const TALK_LINK_LIFT = 14;
/** The line stays quiet (the old arc was 0.3): the dot is what says who just spoke. */
const LINE_ALPHA = 0.4;
const DOT_ALPHA = 0.95;
const DOT_RADIUS = 2.5;
const HALO_RADIUS = 5;
const HALO_ALPHA = 0.3;
const PULSE_MS = 500;
/** Culling margin (px) around a talker. */
const VIEW_MARGIN = 64;

const PULSE_NONE = 0;
/** A message arrived on a poll; the frame clock starts it on the next `update`. */
const PULSE_PENDING = 1;
const PULSE_RUNNING = 2;

interface ChatState {
  id: number;
  numIds: number[];
  ids: string[];
  /** Head-height anchor of each talker, rewritten every frame. */
  pts: Pt[];
  segs: Seg[];
  color: number;
  width: number;
  /** Messages seen so far; -1 until the first poll that shows this chat. */
  msgCount: number;
  pulse: 0 | 1 | 2;
  pulseStart: number;
  /** Index (into `ids`) of whoever spoke last, for the dot's origin. */
  speakerIdx: number;
  seen: number;
}

/**
 * Who is talking to whom. Every active conversation gets a line between its talkers, tinted by
 * the topic and the recent mood (`talkTone`), heavier when the chat is a deep one; whenever a
 * new message lands a 0.5 s dot travels from the speaker to the listener (a group gets spokes to
 * their centroid and the dot runs down the speaker's spoke). It replaces GameCanvas' fixed gold
 * arc, which only knew `participants[0]` and `[1]`.
 *
 * Discretion: a chat with a veiled talker (a private evening, or anyone inside a veiled house)
 * draws nothing, like the bubbles and emotes -- a line pointing at a closed roof would give the
 * evening away.
 *
 * Cost: one `Graphics`, cleared and rebuilt each frame with one stroked path per visible chat
 * plus at most one dot. Colour, width and the message diff are settled once per poll in `onData`;
 * `update` reuses each chat's point and segment objects, so it allocates nothing of its own (the
 * `Graphics` still records its instructions, as the arc it replaces did).
 */
class TalkSystem implements CanvasSystem {
  private readonly g = new PIXI.Graphics();
  private readonly chats = new Map<number, ChatState>();
  private chatList: ChatState[] = [];
  private generation = 0;

  constructor(layers: CanvasLayers, private readonly services: CanvasServices) {
    this.g.eventMode = "none";
    layers.overAgents.addChild(this.g);
  }

  // -- Once per poll ---------------------------------------------------------------------------

  onData(data: DataContext): void {
    this.generation++;
    const gen = this.generation;
    let listChanged = false;
    for (const c of data.conversations) {
      if (!c || (c.status != null && c.status !== "active")) continue;
      const participants: unknown = c.participants;
      if (!Array.isArray(participants) || participants.length < 2 || typeof c.id !== "number") continue;

      let st = this.chats.get(c.id);
      if (!st) {
        st = {
          id: c.id, numIds: [], ids: [], pts: [], segs: [], color: 0, width: 1,
          msgCount: -1, pulse: PULSE_NONE, pulseStart: 0, speakerIdx: -1, seen: gen,
        };
        this.chats.set(c.id, st);
        listChanged = true;
      }
      st.seen = gen;
      this.syncTalkers(st, participants as number[]);
      st.color = talkTone(c);
      st.width = lineWidth(inferTier(c));

      // A chat first seen mid-way (page load, a poll that missed its start) does not replay its
      // backlog: only messages that arrive while we watch send a dot.
      const len = Array.isArray(c.messages) ? c.messages.length : 0;
      if (st.msgCount >= 0 && len > st.msgCount) {
        const speaker = latestSpeaker(c);
        const idx = speaker == null ? -1 : st.numIds.indexOf(speaker);
        if (idx >= 0) {
          st.speakerIdx = idx;
          st.pulse = PULSE_PENDING;
        }
      }
      st.msgCount = len;
    }
    for (const [id, st] of this.chats) {
      if (st.seen === gen) continue;
      this.chats.delete(id);
      listChanged = true;
    }
    if (listChanged) this.chatList = Array.from(this.chats.values());
  }

  /** Rebuilds a chat's talker arrays only when the roster changed (someone joined or left). */
  private syncTalkers(st: ChatState, participants: number[]): void {
    const n = participants.length;
    let same = st.numIds.length === n;
    for (let i = 0; same && i < n; i++) if (st.numIds[i] !== participants[i]) same = false;
    if (same) return;
    st.numIds = participants.slice();
    st.ids = participants.map(idString);
    st.pts = participants.map(() => ({ x: 0, y: 0 }));
    // An in-flight dot's origin index may no longer exist.
    st.pulse = PULSE_NONE;
  }

  // -- Every frame -----------------------------------------------------------------------------

  update(frame: FrameContext): void {
    const g = this.g;
    g.clear();
    const list = this.chatList;
    if (list.length === 0) return;
    const fade = zoomFade(frame.view.scale);
    for (let i = 0; i < list.length; i++) {
      try { this.drawChat(list[i], frame, fade); } catch (err) { console.warn("[talk] draw failed:", err); }
    }
  }

  private drawChat(st: ChatState, frame: FrameContext, fade: number): void {
    // The dot's clock runs even while the chat is off screen or veiled, so it never resumes stale.
    if (st.pulse === PULSE_PENDING) {
      st.pulse = PULSE_RUNNING;
      st.pulseStart = frame.now;
    }
    if (st.pulse === PULSE_RUNNING && frame.now - st.pulseStart >= PULSE_MS) st.pulse = PULSE_NONE;

    const n = st.ids.length;
    let visible = false;
    for (let i = 0; i < n; i++) {
      const s = this.services.sprites.getSprite(st.ids[i]);
      if (!s || s.container.destroyed || s.isVeiled) return;
      const p = st.pts[i];
      p.x = s.x;
      p.y = s.y - TALK_LINK_LIFT;
      if (!visible && inView(frame.view, p.x, p.y, VIEW_MARGIN)) visible = true;
    }
    if (!visible) return;

    const count = groupAnchors(st.pts, st.segs);
    if (count === 0) return;
    const g = this.g;
    const pair = n === 2;
    const segs = st.segs;

    if (pair) {
      const s = segs[0];
      g.moveTo(s.ax, s.ay).quadraticCurveTo((s.ax + s.bx) / 2, (s.ay + s.by) / 2 - this.bowOf(s), s.bx, s.by);
    } else {
      for (let i = 0; i < count; i++) g.moveTo(segs[i].ax, segs[i].ay).lineTo(segs[i].bx, segs[i].by);
    }
    g.stroke({ color: st.color, alpha: LINE_ALPHA * fade, width: st.width });

    if (st.pulse === PULSE_RUNNING && st.speakerIdx >= 0 && st.speakerIdx < n) {
      const t = pulseT(st.pulseStart, frame.now, PULSE_MS);
      this.drawDot(st, pair, t, fade);
    }
  }

  /** The bow of a two-person link, from its length (same 30% rule as the old arc). */
  private bowOf(s: Seg): number {
    return arcBow(Math.hypot(s.bx - s.ax, s.by - s.ay));
  }

  /**
   * The dot at `t` along the speaker's route: pair -> speaker to listener along the bowed curve;
   * group -> speaker to centroid along their spoke. No temporaries: the maths is inline.
   */
  private drawDot(st: ChatState, pair: boolean, t: number, fade: number): void {
    let x: number;
    let y: number;
    if (pair) {
      const s = st.segs[0];
      const fromA = st.speakerIdx === 0;
      const x0 = fromA ? s.ax : s.bx;
      const y0 = fromA ? s.ay : s.by;
      const x1 = fromA ? s.bx : s.ax;
      const y1 = fromA ? s.by : s.ay;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2 - this.bowOf(s);
      const u = 1 - t;
      x = u * u * x0 + 2 * u * t * cx + t * t * x1;
      y = u * u * y0 + 2 * u * t * cy + t * t * y1;
    } else {
      const s = st.segs[st.speakerIdx];
      x = s.ax + (s.bx - s.ax) * t;
      y = s.ay + (s.by - s.ay) * t;
    }
    const g = this.g;
    g.circle(x, y, HALO_RADIUS).fill({ color: st.color, alpha: HALO_ALPHA * fade });
    g.circle(x, y, DOT_RADIUS).fill({ color: st.color, alpha: DOT_ALPHA * fade });
  }

  destroy(): void {
    this.chats.clear();
    this.chatList = [];
    this.g.destroy();
  }
}

export const createTalkSystem: SystemFactory = (layers, services) => new TalkSystem(layers, services);
