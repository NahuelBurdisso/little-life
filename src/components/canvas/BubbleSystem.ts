import * as PIXI from "pixi.js";
import { bubbleText } from '../../lib/bubbleText';
import type { SpritePool } from "./SpritePool";
import { loadStrip } from "./stripAtlas";
import { idString } from "./idString";
import {
  EMOTES_URL, EMOTE_FRAME_COUNT, EMOTE_CELL, EMOTE_EMOJI_FALLBACK, emoteFrameAt,
} from "./emoteFrames";

// Four lines of the 7 px monospace at wordWrapWidth 100 (~23 chars a line).
const BUBBLE_MAX_CHARS = 84;
/** px a head-anchored overlay must fall to stay with a fully lying-down body. */
const LYING_HEAD_DROP = 15;
const SPEECH_DURATION_MS = 4000;
const EMOTE_DURATION_MS = 1500;
/** px per second — `update` is handed `ticker.deltaTime / 60`, not raw ticks. */
const EMOTE_FLOAT_SPEED = 18;

/** Module scope: `update` runs per frame, so these must not be rebuilt per agent. */
const STATE_EMOTES: Record<string, string> = {
  drunk: 'dizzy', hungover: 'dizzy', heartbroken: 'cry', angry: 'anger', euphoric: 'sparkle',
  confident: 'star', jealous: 'fire', sick: 'sick', stressed: 'sweat',
  infatuated: 'heart', lonely: 'think', depressed: 'cry', in_debt: 'money',
  afterglow: 'blush', guilty: 'sweat', suspicious: 'question',
};
// Emote when a zone verb (`current_action.zoneActivity`) begins. Plan-driven verbs (speech, scheme,
// cook...) arrive here since decisions.ts keeps them; ActivityFxSystem adds the repeats and the
// particles. Every value must be an atlas name (emoteFrames.test.ts checks).
const ACTIVITY_EMOTES: Record<string, string> = {
  fish: 'fish', garden: 'flower', perform: 'music',
  contemplate: 'think', forage: 'flower', browse: 'question',
  jog: 'sweat', comfort: 'sparkle', shoplifting: 'whisper', pickpocket: 'whisper', // the loot comes on leaving
  cook: 'fire', speech: 'exclaim', announce: 'exclaim', protest: 'anger',
  watch: 'star', people_watch: 'question',
  scheme: 'skull', secret_meeting: 'whisper', confide: 'whisper', smuggle: 'money',
  escape_attempt: 'exclaim', lock_out: 'anger',
  plant: 'flower', harvest: 'flower', pick_flowers: 'flower',
  collect_eggs: 'sparkle', feed_animals: 'heart',
};

/** Shared read-only stand-in for a missing `activeStates`, so the per-frame loop never allocates one. */
const EMPTY_STATES: readonly any[] = [];

/** First conversation listing `agentId` as a participant — a plain loop, `update` runs per frame. */
function findConversation<C extends { participants?: number[] }>(conversations: C[], agentId: number): C | undefined {
  for (let i = 0; i < conversations.length; i++) {
    const participants = conversations[i].participants;
    if (participants && participants.includes(agentId)) return conversations[i];
  }
  return undefined;
}

interface BubbleEntry {
  /** The key this entry lives under in `bubbles`, so a `values()` walk can delete without `[k, v]` pairs. */
  key: string;
  container: PIXI.Container;
  agentId: string;
  type: "speech" | "thought" | "emote";
  createdAt: number;
  duration: number; // ms, 0 = indefinite
  /**
   * Layout as chosen at creation time, so the per-frame reposition can reproduce
   * it. Measuring the container instead loses the multi-speaker nudge and picks
   * up the speech bubble's tail, which shifts it a few px on the first reflow.
   */
  dx: number; // container.x relative to the agent's world x
  bgH: number; // background height, excluding any tail
  /** Atlas-backed emotes only: which animation to play and the sprite to swap frames on. */
  emoteName?: string;
  emoteSprite?: PIXI.Sprite;
}

const THOUGHT_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 10,
  fill: 0x8a7f65,
});

const SPEECH_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 7,
  fill: 0xd4c9a8,
  wordWrap: true,
  wordWrapWidth: 100,
});

const TEXT_THOUGHT_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 7,
  fill: 0x8a7f65,
  fontStyle: "italic",
  wordWrap: true,
  wordWrapWidth: 100,
});

/**
 * Emote atlas textures, shared by every BubbleSystem. Null until the strip loads (or for good
 * if it fails) — `showEmote` then falls back to the emoji glyph, so a missing PNG degrades the
 * look but never breaks a bubble. `loadStrip` caches by URL and forgets failures.
 */
let emoteTextures: PIXI.Texture[] | null = null;
let emoteLoadStarted = false;
function ensureEmoteAtlas() {
  if (emoteTextures || emoteLoadStarted) return;
  emoteLoadStarted = true;
  loadStrip(EMOTES_URL, EMOTE_FRAME_COUNT, EMOTE_CELL)
    .then(frames => { emoteTextures = frames; })
    // Allow a later BubbleSystem (world reload) to try again.
    .catch(() => { emoteLoadStarted = false; });
}

/**
 * Emotes re-puffed on a loop for as long as a pose holds, rather than fired once
 * on an edge. They get their own bubble slot so they and the edge-triggered
 * mood/state emotes don't evict each other every few seconds.
 */
const LOOPED_EMOTES = new Set(['zzz', 'work']);

/** Renders speech, thought, and emote bubbles above agents. */
export class BubbleSystem {
  private bubbles: Map<string, BubbleEntry> = new Map();
  readonly container: PIXI.Container;
  private prevMoodMap: Map<string, number> = new Map();
  private prevStatesMap: Map<string, string[]> = new Map();
  private prevActionMap: Map<string, string> = new Map();
  private prevEmoteStampMap: Map<string, number> = new Map();
  private shownMessageCounts = new Map<string, number>(); // agentId → message count when last bubble shown
  private lyingBlendMap = new Map<string, number>(); // agentId → 0 upright .. 1 lying down
  /** Finished atlas emotes, kept for reuse: an emote per state change would churn allocations. */
  private emotePool: PIXI.Container[] = [];

  // Per-frame scratch for `update`, cleared and refilled in place: it runs at 60 fps and used to
  // build a Map of fresh `{x, y}` objects, three collections, a `String(id)` and a states array
  // per agent every frame.
  /** agentId → position. Entries are reused; `stamp` says whether one belongs to this frame. */
  private readonly posMap = new Map<string, { x: number; y: number; stamp: number }>();
  private frameStamp = 0;
  private readonly convoAgents = new Set<string>();
  private readonly latestMessages = new Map<string, string>();
  private readonly latestIsAction = new Set<string>();

  constructor(parentContainer: PIXI.Container) {
    this.container = new PIXI.Container();
    this.container.eventMode = 'none'; // transparent to clicks — let agents below receive events
    parentContainer.addChild(this.container);
    ensureEmoteAtlas();
  }

  /**
   * Retire a bubble. Atlas emotes go back to the pool (their sprite is reused); everything else
   * is destroyed with its children as before.
   */
  private dispose(entry: BubbleEntry) {
    if (entry.emoteSprite) {
      entry.container.removeFromParent();
      entry.container.visible = false;
      entry.emoteSprite = undefined;
      this.emotePool.push(entry.container);
    } else {
      entry.container.destroy({ children: true });
    }
  }

  /** A pooled (or fresh) container holding one `PIXI.Sprite`, with the sprite as first child. */
  private takeEmoteContainer(texture: PIXI.Texture): { container: PIXI.Container; sprite: PIXI.Sprite } {
    const container = this.emotePool.pop() ?? (() => {
      const c = new PIXI.Container();
      const s = new PIXI.Sprite(texture);
      // Floating at fractional y would shimmer a nearest-scaled 16px sprite; snap to whole pixels.
      s.roundPixels = true;
      c.addChild(s);
      return c;
    })();
    const sprite = container.children[0] as PIXI.Sprite;
    sprite.texture = texture;
    container.visible = true;
    container.alpha = 1;
    return { container, sprite };
  }

  /**
   * Overlay anchors assume a standing sprite, so a sleeping agent's bubbles
   * would float where its head used to be. Drop them with the lying body.
   */
  private headY(agentId: string, y: number): number {
    return y + LYING_HEAD_DROP * (this.lyingBlendMap.get(agentId) ?? 0);
  }

  /** Show a speech bubble with text above the agent. Auto-dismisses. */
  showSpeechBubble(agentId: string, text: string, position: { x: number; y: number }, sentiment = 0, offsetX = 0) {
    this.removeBubble(agentId);

    const truncated = bubbleText(text, BUBBLE_MAX_CHARS);

    const bubbleContainer = new PIXI.Container();

    const textObj = new PIXI.Text({ text: truncated, style: SPEECH_STYLE });
    const padX = 6;
    const padY = 4;
    const bgW = textObj.width + padX * 2;
    const bgH = textObj.height + padY * 2;

    // Sentiment-based border tint (background stays dark)
    const borderColor = sentiment > 0.2 ? 0x4a7a3a : sentiment < -0.2 ? 0xa03028 : 0xc8a84b;
    const bgAlpha = 0.9;

    // Background rounded rect
    const bg = new PIXI.Graphics();
    bg.roundRect(0, 0, bgW, bgH, 4).fill({ color: 0x1a1814, alpha: bgAlpha });
    bg.roundRect(0, 0, bgW, bgH, 4).stroke({ color: borderColor, width: 1, alpha: 1 });

    // Small tail triangle
    bg.poly([bgW / 2 - 4, bgH, bgW / 2, bgH + 5, bgW / 2 + 4, bgH]).fill({ color: 0x1a1814, alpha: bgAlpha });

    textObj.x = padX;
    textObj.y = padY;

    bubbleContainer.addChild(bg, textObj);

    // Position above agent sprite head.
    // Formula: agent.y - 32 (sprite half-height) - 4 (gap) - bgH
    // The sprite is 32px tall with feet at agent.y + ~8, so head top is
    // approximately agent.y - 24. The -32 constant matches
    // proposal-readability.md §4a for a 32px tall sprite.
    const dx = -bgW / 2 + offsetX;
    bubbleContainer.x = position.x + dx;
    bubbleContainer.y = this.headY(agentId, position.y) - 32 - 4 - bgH;

    this.container.addChild(bubbleContainer);
    this.bubbles.set(agentId, {
      key: agentId,
      container: bubbleContainer,
      agentId,
      type: "speech",
      createdAt: Date.now(),
      duration: SPEECH_DURATION_MS,
      dx,
      bgH,
    });
  }

  /** Show thinking dots above the agent. Stays until removed. */
  showThoughtBubble(agentId: string, position: { x: number; y: number }) {
    // Don't replace a speech bubble with a thought bubble
    const existing = this.bubbles.get(agentId);
    if (existing?.type === "speech") return;

    this.removeBubble(agentId);

    const bubbleContainer = new PIXI.Container();

    const bg = new PIXI.Graphics();
    bg.roundRect(0, 0, 28, 18, 4).fill({ color: 0x1a1814, alpha: 0.9 });
    bg.roundRect(0, 0, 28, 18, 4).stroke({ color: 0xc8a84b, width: 1, alpha: 1 });

    const dots = new PIXI.Text({ text: "...", style: THOUGHT_STYLE });
    dots.x = 5;
    dots.y = 1;

    bubbleContainer.addChild(bg, dots);

    // Thought bubble: 28×18 box. Place above head like speech bubble.
    bubbleContainer.x = position.x - 14;
    bubbleContainer.y = this.headY(agentId, position.y) - 32 - 4 - 18;

    this.container.addChild(bubbleContainer);
    this.bubbles.set(agentId, {
      key: agentId,
      container: bubbleContainer,
      agentId,
      type: "thought",
      createdAt: Date.now(),
      duration: 0, // stays until removed
      dx: -14,
      bgH: 18,
    });
  }

  /** Show a text thought bubble (italic, translucent) above the agent. Auto-dismisses after 4s. */
  showTextThought(agentId: string, text: string, position: { x: number; y: number }) {
    // Don't replace speech bubbles with thoughts
    const existing = this.bubbles.get(agentId);
    if (existing?.type === 'speech') return;

    this.removeBubble(agentId);

    const truncated = bubbleText(text, 40);

    const bubbleContainer = new PIXI.Container();

    const textObj = new PIXI.Text({ text: `💭 ${truncated}`, style: TEXT_THOUGHT_STYLE });
    const padX = 5;
    const padY = 3;
    const bgW = textObj.width + padX * 2;
    const bgH = textObj.height + padY * 2;

    const bg = new PIXI.Graphics();
    bg.roundRect(0, 0, bgW, bgH, 4).fill({ color: 0x1a1814, alpha: 0.9 });
    bg.roundRect(0, 0, bgW, bgH, 4).stroke({ color: 0xc8a84b, width: 1, alpha: 0.6 });

    textObj.x = padX;
    textObj.y = padY;

    bubbleContainer.addChild(bg, textObj);
    bubbleContainer.x = position.x - bgW / 2;
    bubbleContainer.y = this.headY(agentId, position.y) - 32 - 4 - bgH; // above sprite head

    this.container.addChild(bubbleContainer);
    this.bubbles.set(agentId, {
      key: agentId,
      container: bubbleContainer,
      agentId,
      type: 'thought',
      createdAt: Date.now(),
      duration: 4000, // 4 seconds
      dx: -bgW / 2,
      bgH,
    });
  }

  /** Show a small emote that floats up and fades out. */
  showEmote(agentId: string, emoteType: string, position: { x: number; y: number }) {
    // Emotes use a separate key so they don't replace speech bubbles. Looped
    // pose emotes get a slot of their own — see LOOPED_EMOTES. The key still
    // contains `__emote`, which the lifetime sweep in `update` keys off.
    const looped = LOOPED_EMOTES.has(emoteType);
    const emoteKey = looped ? `${agentId}__emote_${emoteType}` : `${agentId}__emote`;
    this.removeBubbleByKey(emoteKey);

    // Pixel-art frame from the atlas; the emoji glyph only while the atlas is still loading
    // (or failed) and for names it does not know.
    const first = emoteTextures ? emoteFrameAt(emoteType, 0) : null;
    let bubbleContainer: PIXI.Container;
    let emoteSprite: PIXI.Sprite | undefined;
    if (emoteTextures && first != null) {
      const taken = this.takeEmoteContainer(emoteTextures[first]);
      bubbleContainer = taken.container;
      emoteSprite = taken.sprite;
    } else {
      bubbleContainer = new PIXI.Container();
      const label = new PIXI.Text({
        text: EMOTE_EMOJI_FALLBACK[emoteType] ?? "?",
        style: { fontSize: 16 },
      });
      bubbleContainer.addChild(label);
    }

    // Emote floats above sprite head: same baseline as bubbles.
    // Looped emotes live in their own slot, so a sleeping agent who also gains
    // e.g. `sick` renders two emotes at once — offset the looped one so they
    // read as two glyphs instead of stacking on the identical origin.
    const dx = looped ? 6 : -8;
    bubbleContainer.x = position.x + dx;
    bubbleContainer.y = this.headY(agentId, position.y) - 32 - 20 - (looped ? 12 : 0); // 20px above head top

    this.container.addChild(bubbleContainer);
    this.bubbles.set(emoteKey, {
      key: emoteKey,
      container: bubbleContainer,
      agentId,
      type: "emote",
      createdAt: Date.now(),
      duration: EMOTE_DURATION_MS,
      // Emotes float on their own and are never repositioned, but the stored
      // layout still has to describe where they were placed: `-32 - 4 - 16` is
      // the same baseline as the `-32 - 20` used above, and the looped slot's
      // extra 12px of lift makes that `-32 - 4 - 28`.
      dx,
      bgH: looped ? 28 : 16,
      emoteName: emoteSprite ? emoteType : undefined,
      emoteSprite,
    });
  }

  removeBubble(agentId: string) {
    this.removeBubbleByKey(agentId);
  }

  private removeBubbleByKey(key: string) {
    const entry = this.bubbles.get(key);
    if (entry) {
      this.dispose(entry);
      this.bubbles.delete(key);
    }
  }

  /**
   * Per-frame update: manage bubble lifetimes, animate emotes,
   * and sync positions with agent positions.
   */
  update(
    conversations: Array<{ participants?: number[]; messages?: Array<{ speakerId?: number; text?: string; fallback?: boolean }> }>,
    agents: Array<{ id: number; position: { x: number; y: number } }>,
    deltaTime: number,
    spritePool?: SpritePool,
  ) {
    const now = Date.now();

    // Build a position lookup — prefer interpolated sprite positions over raw DB positions.
    // Entries persist between frames and are restamped; `posOf` hides the ones this frame skipped.
    const stamp = ++this.frameStamp;
    const posMap = this.posMap;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const aid = idString(a.id);
      const sprite = spritePool?.getSprite(aid);
      let entry = posMap.get(aid);
      if (!entry) {
        entry = { x: 0, y: 0, stamp };
        posMap.set(aid, entry);
      }
      entry.stamp = stamp;
      if (sprite) {
        entry.x = sprite.container.x;
        entry.y = sprite.container.y;
        this.lyingBlendMap.set(aid, sprite.lyingBlend);
      } else {
        entry.x = a.position?.x ?? 0;
        entry.y = a.position?.y ?? 0;
        this.lyingBlendMap.delete(aid);
      }
    }

    // Drop per-agent history for anyone who left the roster (death, deactivation),
    // otherwise these grow for the lifetime of the session. Every history map is only
    // written for agents that have a `posMap` entry, so a stale entry is the whole signal.
    // (The size check makes the common no-departure frame skip the walk entirely.)
    if (posMap.size > agents.length) {
      for (const [aid, entry] of posMap) {
        if (entry.stamp === stamp) continue;
        posMap.delete(aid);
        this.prevMoodMap.delete(aid);
        this.prevStatesMap.delete(aid);
        this.prevActionMap.delete(aid);
        this.prevEmoteStampMap.delete(aid);
        this.lyingBlendMap.delete(aid);
      }
    }

    // Determine which agents are currently in conversations
    const convoAgents = this.convoAgents;
    const latestMessages = this.latestMessages;
    // Agents whose newest message is a canned fallback action ("Omar smiled and
    // nodded.") — narration, not speech, so it gets no speech bubble.
    const latestIsAction = this.latestIsAction;
    convoAgents.clear();
    latestMessages.clear();
    latestIsAction.clear();
    if (conversations) {
      for (let c = 0; c < conversations.length; c++) {
        const convo = conversations[c];
        const participants = convo.participants;
        if (participants) {
          for (let i = 0; i < participants.length; i++) convoAgents.add(idString(participants[i]));
        }
        // Last message per agent
        const messages = convo.messages;
        if (messages) {
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.speakerId != null && msg.text) {
              const sid = idString(msg.speakerId);
              latestMessages.set(sid, msg.text);
              if (msg.fallback) latestIsAction.add(sid);
              else latestIsAction.delete(sid);
            }
          }
        }
      }
    }

    // Clear the watermark as soon as an agent leaves every conversation. Doing
    // it only when they still own a live bubble was not enough: speech bubbles
    // expire after 4s, so a conversation that ended later stranded the count,
    // and the agent then stayed mute through their whole next conversation
    // until it exceeded the old message total. Also keeps the map from growing
    // for agents that leave the roster.
    for (const aid of this.shownMessageCounts.keys()) {
      if (!convoAgents.has(aid)) this.shownMessageCounts.delete(aid);
    }

    // Show thought bubbles for agents in conversation without recent messages
    for (const aid of convoAgents) {
      const pos = posMap.get(aid);
      if (!pos) continue;

      // Find the conversation this agent is in
      const numericAid = Number(aid);
      const convo = findConversation(conversations, numericAid);
      const messageCount = convo?.messages?.length ?? 0;
      const lastShown = this.shownMessageCounts.get(aid) ?? 0;
      const lastMsg = latestMessages.get(aid);

      if (lastMsg && messageCount > lastShown) {
        // New message arrived — show a fresh speech bubble
        this.shownMessageCounts.set(aid, messageCount);
        const sentiment = (convo as any)?.sentiment ?? 0;
        // Determine bubble offset for multi-agent conversations
        const participantIds = (convo?.participants ?? []).map(String);
        const isMultiAgent = participantIds.length > 1;
        const participantIndex = participantIds.indexOf(aid);
        const offsetX = isMultiAgent ? (participantIndex === 0 ? -20 : 20) : 0;
        if (!latestIsAction.has(aid)) this.showSpeechBubble(aid, lastMsg, pos, sentiment, offsetX);
      } else if (!lastMsg && !this.bubbles.has(aid)) {
        // No messages yet — show thought bubble while waiting
        this.showThoughtBubble(aid, pos);
      }
    }

    // Remove bubbles for agents no longer in conversations (except emotes/timed)
    for (const entry of this.bubbles.values()) {
      if (entry.key.includes("__emote")) continue;
      if (entry.type !== "speech" && entry.type !== "thought") continue;
      if (convoAgents.has(entry.agentId)) continue;
      // Timed bubbles own their lifetime — `update` expires them above. Killing
      // them here cut every 4s speech bubble and action thought to one frame,
      // since the agent whose action changed is usually not in a conversation.
      if (entry.duration > 0) continue;
      entry.container.destroy({ children: true });
      this.bubbles.delete(entry.key);
    }

    // Auto-emote triggers based on mood changes
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const aid = idString(a.id);
      const pos = posMap.get(aid);
      if (!pos) continue;
      const curMood = (a as any).needs?.mood ?? 50;
      const prevMood = this.prevMoodMap.get(aid) ?? 50;

      if (curMood > 80 && prevMood <= 80) this.showEmote(aid, "heart", pos);
      if (curMood < 20 && prevMood >= 20) this.showEmote(aid, "cry", pos);
      this.prevMoodMap.set(aid, curMood);

      // State-triggered emotes — show when a new state appears
      // Compared against last frame's list, then that list is overwritten in place — building a
      // fresh `.map` array per agent per frame was pure garbage on a list that almost never changes.
      const curStates: any[] = (a as any).activeStates ?? EMPTY_STATES;
      let prevStates = this.prevStatesMap.get(aid);
      if (!prevStates) {
        prevStates = [];
        this.prevStatesMap.set(aid, prevStates);
      }
      for (let s = 0; s < curStates.length; s++) {
        const state: string = curStates[s].type;
        if (!prevStates.includes(state) && STATE_EMOTES[state]) {
          this.showEmote(aid, STATE_EMOTES[state], pos);
          break; // one emote per tick
        }
      }
      prevStates.length = curStates.length;
      for (let s = 0; s < curStates.length; s++) prevStates[s] = curStates[s].type;

      // Zone activity emotes
      const curAction = (a as any).current_action?.zoneActivity ?? '';
      const prevAct = this.prevActionMap.get(aid) ?? '';
      if (curAction && curAction !== prevAct) {
        if (ACTIVITY_EMOTES[curAction]) {
          this.showEmote(aid, ACTIVITY_EMOTES[curAction], pos);
        }
      }
      this.prevActionMap.set(aid, curAction);

      // Server-stamped one-shot emote (perception greetings). `emote_at` is the
      // edge, not `emote` — two greetings in a row carry the same emoji.
      const stampedAt = (a as any).current_action?.emote_at ?? 0;
      const stampedEmote = (a as any).current_action?.emote;
      if (stampedAt && stampedEmote && stampedAt !== this.prevEmoteStampMap.get(aid)) {
        this.showEmote(aid, stampedEmote, pos);
      }
      this.prevEmoteStampMap.set(aid, stampedAt);
    }

    // Update positions and lifetimes
    for (const entry of this.bubbles.values()) {
      // Expire timed bubbles
      if (entry.duration > 0 && now - entry.createdAt > entry.duration) {
        this.dispose(entry);
        this.bubbles.delete(entry.key);
        continue;
      }

      // Float emotes upward and fade
      if (entry.type === "emote") {
        entry.container.y -= EMOTE_FLOAT_SPEED * deltaTime;
        const elapsed = now - entry.createdAt;
        entry.container.alpha = Math.max(0, 1 - elapsed / entry.duration);
        if (entry.emoteSprite && entry.emoteName && emoteTextures) {
          const f = emoteFrameAt(entry.emoteName, elapsed);
          if (f != null && entry.emoteSprite.texture !== emoteTextures[f]) {
            entry.emoteSprite.texture = emoteTextures[f];
          }
        }
      }

      // Re-position non-emote bubbles to follow agent
      if (entry.type !== "emote") {
        const pos = posMap.get(entry.agentId);
        if (pos) {
          entry.container.x = pos.x + entry.dx;
          entry.container.y = this.headY(entry.agentId, pos.y) - 32 - 4 - entry.bgH;
        }
      }
    }
  }

  destroy() {
    for (const [, entry] of this.bubbles) {
      entry.container.destroy({ children: true });
    }
    this.bubbles.clear();
    // Pooled emotes were detached from the tree, so `container.destroy` below misses them.
    for (const c of this.emotePool) c.destroy({ children: true });
    this.emotePool.length = 0;
    this.prevMoodMap.clear();
    this.shownMessageCounts.clear();
    this.posMap.clear();
    this.convoAgents.clear();
    this.latestMessages.clear();
    this.latestIsAction.clear();
    this.container.destroy({ children: true });
  }
}
