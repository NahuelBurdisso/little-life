import type { ConversationTier } from "../../../../lib/director";

/**
 * Who is talking to whom, as pure functions (no PixiJS) for TalkSystem to draw.
 *
 * The old conversation arc was one pale-gold line between the first two participants, so a chat
 * looked the same whether it was a quarrel or a flirtation and a third speaker was invisible.
 * Here the line takes its colour from the topic and the recent mood, a dot travels along it from
 * whoever just spoke, and a group of three or more gets spokes to its middle.
 */

export const TALK_GOLD = 0xfde68a;
export const TALK_ROSE = 0xf472b6;
export const TALK_RED = 0xef4444;
export const TALK_VIOLET = 0xa78bfa;
export const TALK_BLUE = 0x60a5fa;

/** How many of the newest messages set the mood. */
const MOOD_WINDOW = 3;
/** How much of the topic colour shows in a flat chat; a warm one goes up to the whole colour. */
const TOPIC_BASE_SHARE = 0.7;
/** Sentiment is roughly -1..1; a mean of -0.67 or worse is already fully red. */
const RED_GAIN = 1.5;

/** The slice of a client conversation row this reads (structurally a `conversations.getActive` row). */
export interface TalkConvo {
  topic?: string | null;
  messages?: ReadonlyArray<{ speakerId?: number; sentiment?: number | null } | null | undefined> | null;
}

/**
 * The colour a topic reads as. The stored topic is free text (personality picks, the player's
 * own words), so this matches stems, like `topicWeight` in lib/director.ts. Order matters for a
 * topic that mentions two things: a quarrel outranks a secret, a secret outranks romance.
 */
export function topicColor(topic: string | null | undefined): number {
  const t = (topic ?? "").toLowerCase();
  if (!t) return TALK_GOLD;
  if (/confront|argu|fight|tension|clash|accus/.test(t)) return TALK_RED;
  if (/secret|reveal|gossip|rumou?r/.test(t)) return TALK_VIOLET;
  if (/flirt|romanc|love|kiss|affair/.test(t)) return TALK_ROSE;
  if (/comfort|condol|vent|worr|griev|cry|sympath/.test(t)) return TALK_BLUE;
  return TALK_GOLD;
}

/** Channel-wise blend of two 0xRRGGBB colours, `t` 0 = a, 1 = b. No allocation. */
export function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * k);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Mean sentiment of the last few messages. Not `convo.sentiment`: that column is inserted as 0
 * and only averaged when the chat ends, so it says nothing while people are talking. A message
 * with no (or a non-finite) sentiment counts as 0.
 */
function recentMood(convo: TalkConvo): number {
  const m = convo.messages;
  if (!m || m.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (let i = m.length - 1; i >= 0 && n < MOOD_WINDOW; i--, n++) {
    const s = m[i]?.sentiment;
    if (typeof s === "number" && Number.isFinite(s)) sum += s;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * The line's colour. The topic colour is the base (a warm chat shows all of it, a flat one 70%
 * over gold); bitter recent words drag it toward red, whatever the topic.
 */
export function talkTone(convo: TalkConvo): number {
  const s = recentMood(convo);
  const topic = topicColor(convo.topic);
  let color = topic === TALK_GOLD
    ? TALK_GOLD
    : mixColor(TALK_GOLD, topic, TOPIC_BASE_SHARE + (1 - TOPIC_BASE_SHARE) * Math.max(0, s));
  if (s < 0) color = mixColor(color, TALK_RED, -s * RED_GAIN);
  return color;
}

/** The speaker of the newest message that names one, or null when nobody has spoken yet. */
export function latestSpeaker(convo: TalkConvo): number | null {
  const m = convo.messages;
  if (!m) return null;
  for (let i = m.length - 1; i >= 0; i--) {
    const id = m[i]?.speakerId;
    if (typeof id === "number") return id;
  }
  return null;
}

export interface Pt {
  x: number;
  y: number;
}

/** A link from participant `a` to `b` (for a group: `b` is the centroid). */
export interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * The links to draw for these anchor points: one segment for two people, and for three or more
 * a spoke from each person to the group's centroid (segment i belongs to point i). Segments are
 * written into `out` (its objects are reused, it only ever grows) and the count is returned, so
 * the per-frame call allocates nothing once the array has warmed up.
 */
export function groupAnchors(points: readonly Pt[], out: Seg[]): number {
  const n = points.length;
  if (n < 2) return 0;
  if (n === 2) {
    setSeg(out, 0, points[0].x, points[0].y, points[1].x, points[1].y);
    return 1;
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += points[i].x;
    cy += points[i].y;
  }
  cx /= n;
  cy /= n;
  for (let i = 0; i < n; i++) setSeg(out, i, points[i].x, points[i].y, cx, cy);
  return n;
}

function setSeg(out: Seg[], i: number, ax: number, ay: number, bx: number, by: number): void {
  const s = out[i];
  if (!s) {
    out[i] = { ax, ay, bx, by };
    return;
  }
  s.ax = ax;
  s.ay = ay;
  s.bx = bx;
  s.by = by;
}

/** How far through a message's dot has travelled, 0..1. */
export function pulseT(startMs: number, nowMs: number, durationMs = 500): number {
  if (durationMs <= 0) return 1;
  const t = (nowMs - startMs) / durationMs;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Deep (LLM, dramatic) chats are worth a heavier line than a passing exchange. */
export function lineWidth(tier: ConversationTier): number {
  return tier === "llm_deep" ? 2.5 : tier === "llm_standard" ? 1.75 : 1.25;
}

const FADE_FROM_SCALE = 0.8;
const FADE_TO_SCALE = 0.4;
const FADE_FLOOR = 0.25;

/** Alpha multiplier by zoom: full at normal zoom, down to a quarter when the map is far away. */
export function zoomFade(scale: number): number {
  if (scale >= FADE_FROM_SCALE) return 1;
  if (scale <= FADE_TO_SCALE) return FADE_FLOOR;
  return FADE_FLOOR + (1 - FADE_FLOOR) * ((scale - FADE_TO_SCALE) / (FADE_FROM_SCALE - FADE_TO_SCALE));
}

/** The upward bow of a two-person link: the old arc's 30% of the gap, kept within 8..24 px. */
export function arcBow(dist: number): number {
  return Math.min(24, Math.max(8, dist * 0.3));
}
