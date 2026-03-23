import * as PIXI from "pixi.js";
import { SPRITE_CONFIG } from "../../lib/spriteConfig";

const BUBBLE_MAX_CHARS = 60;
const SPEECH_DURATION_MS = 4000;
const EMOTE_DURATION_MS = 1500;
const EMOTE_FLOAT_SPEED = 0.3; // pixels per tick

interface BubbleEntry {
  container: PIXI.Container;
  agentId: string;
  type: "speech" | "thought" | "emote";
  createdAt: number;
  duration: number; // ms, 0 = indefinite
}

const THOUGHT_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 10,
  fill: 0x666666,
});

const SPEECH_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 8,
  fill: 0x222222,
  wordWrap: true,
  wordWrapWidth: 100,
});

const EMOTE_TYPES = ["heart", "anger", "laugh", "wave", "question", "exclaim", "zzz", "cry"] as const;

/** Renders speech, thought, and emote bubbles above agents. */
export class BubbleSystem {
  private bubbles: Map<string, BubbleEntry> = new Map();
  readonly container: PIXI.Container;
  private emoteTextures: Map<string, PIXI.Texture> = new Map();
  private prevMoodMap: Map<string, number> = new Map();

  constructor(parentContainer: PIXI.Container) {
    this.container = new PIXI.Container();
    parentContainer.addChild(this.container);
    this.preloadEmotes();
  }

  private async preloadEmotes() {
    for (const emote of EMOTE_TYPES) {
      try {
        const tex = await PIXI.Assets.load(`/sprites/emotes/${emote}.png`);
        if (tex) this.emoteTextures.set(emote, tex);
      } catch {
        // Will fall back to text emotes
      }
    }
  }

  /** Show a speech bubble with text above the agent. Auto-dismisses. */
  showSpeechBubble(agentId: string, text: string, position: { x: number; y: number }, sentiment = 0, offsetX = 0) {
    this.removeBubble(agentId);

    const truncated = text.length > BUBBLE_MAX_CHARS ? text.slice(0, BUBBLE_MAX_CHARS - 1) + "\u2026" : text;

    const bubbleContainer = new PIXI.Container();

    const textObj = new PIXI.Text({ text: truncated, style: SPEECH_STYLE });
    const padX = 6;
    const padY = 4;
    const bgW = textObj.width + padX * 2;
    const bgH = textObj.height + padY * 2;

    // Sentiment-based colors
    const bgColor = sentiment > 0.2 ? 0xdcfce7 : sentiment < -0.2 ? 0xfde2e2 : 0xffffff;
    const borderColor = sentiment > 0.2 ? 0x22c55e : sentiment < -0.2 ? 0xef4444 : 0xd1d5db;
    const bgAlpha = 0.92;

    // Background rounded rect
    const bg = new PIXI.Graphics();
    bg.roundRect(0, 0, bgW, bgH, 4).fill({ color: bgColor, alpha: bgAlpha });
    bg.roundRect(0, 0, bgW, bgH, 4).stroke({ color: borderColor, width: 1, alpha: 0.25 });

    // Small tail triangle
    bg.poly([bgW / 2 - 4, bgH, bgW / 2, bgH + 5, bgW / 2 + 4, bgH]).fill({ color: bgColor, alpha: bgAlpha });

    textObj.x = padX;
    textObj.y = padY;

    bubbleContainer.addChild(bg, textObj);

    // Position above agent
    const half = SPRITE_CONFIG.AGENT_SIZE / 2;
    bubbleContainer.x = position.x + half - bgW / 2 + offsetX;
    bubbleContainer.y = position.y - bgH - 8;

    this.container.addChild(bubbleContainer);
    this.bubbles.set(agentId, {
      container: bubbleContainer,
      agentId,
      type: "speech",
      createdAt: Date.now(),
      duration: SPEECH_DURATION_MS,
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
    bg.roundRect(0, 0, 28, 18, 4).fill({ color: 0xffffff, alpha: 0.85 });
    bg.roundRect(0, 0, 28, 18, 4).stroke({ color: 0x000000, width: 1, alpha: 0.2 });

    const dots = new PIXI.Text({ text: "...", style: THOUGHT_STYLE });
    dots.x = 5;
    dots.y = 1;

    bubbleContainer.addChild(bg, dots);

    const half = SPRITE_CONFIG.AGENT_SIZE / 2;
    bubbleContainer.x = position.x + half - 14;
    bubbleContainer.y = position.y - 24;

    this.container.addChild(bubbleContainer);
    this.bubbles.set(agentId, {
      container: bubbleContainer,
      agentId,
      type: "thought",
      createdAt: Date.now(),
      duration: 0, // stays until removed
    });
  }

  /** Show a small emote that floats up and fades out. */
  showEmote(agentId: string, emoteType: string, position: { x: number; y: number }) {
    // Emotes use a separate key so they don't replace speech bubbles
    const emoteKey = `${agentId}__emote`;
    this.removeBubbleByKey(emoteKey);

    const bubbleContainer = new PIXI.Container();

    const tex = this.emoteTextures.get(emoteType);
    if (tex) {
      const emoteSprite = new PIXI.Sprite(tex);
      emoteSprite.width = 16;
      emoteSprite.height = 16;
      bubbleContainer.addChild(emoteSprite);
    } else {
      // Fallback: text symbol
      const symbols: Record<string, string> = {
        heart: "\u2764", anger: "\u2757", laugh: "\ud83d\ude04", wave: "\ud83d\udc4b",
        question: "?", exclaim: "!", zzz: "zzz", cry: "\ud83d\ude22",
      };
      const label = new PIXI.Text({
        text: symbols[emoteType] ?? "?",
        style: { fontSize: 14, fill: 0xff4444 },
      });
      bubbleContainer.addChild(label);
    }

    const half = SPRITE_CONFIG.AGENT_SIZE / 2;
    bubbleContainer.x = position.x + half - 8;
    bubbleContainer.y = position.y - 16;

    this.container.addChild(bubbleContainer);
    this.bubbles.set(emoteKey, {
      container: bubbleContainer,
      agentId,
      type: "emote",
      createdAt: Date.now(),
      duration: EMOTE_DURATION_MS,
    });
  }

  removeBubble(agentId: string) {
    this.removeBubbleByKey(agentId);
  }

  private removeBubbleByKey(key: string) {
    const entry = this.bubbles.get(key);
    if (entry) {
      entry.container.destroy({ children: true });
      this.bubbles.delete(key);
    }
  }

  /**
   * Per-frame update: manage bubble lifetimes, animate emotes,
   * and sync positions with agent positions.
   */
  update(
    conversations: Array<{ participants?: Array<string | { agentId?: string }>; messages?: Array<{ agentId?: string; text?: string }> }>,
    agents: Array<{ _id?: string; id?: string; position: { x: number; y: number } }>,
    deltaTime: number,
  ) {
    const now = Date.now();

    // Build a position lookup
    const posMap = new Map<string, { x: number; y: number }>();
    for (const a of agents) {
      const aid = a._id ?? a.id;
      if (aid) {
        posMap.set(aid, {
          x: a.position?.x ?? 0,
          y: a.position?.y ?? 0,
        });
      }
    }

    // Determine which agents are currently in conversations
    const convoAgents = new Set<string>();
    const latestMessages = new Map<string, string>();
    if (conversations) {
      for (const convo of conversations) {
        for (const p of convo.participants ?? []) {
          const pid = typeof p === "string" ? p : p?.agentId;
          if (pid) convoAgents.add(pid);
        }
        // Last message per agent
        for (const msg of convo.messages ?? []) {
          if (msg.agentId && msg.text) {
            latestMessages.set(msg.agentId, msg.text);
          }
        }
      }
    }

    // Show thought bubbles for agents in conversation without recent messages
    for (const aid of convoAgents) {
      const pos = posMap.get(aid);
      if (!pos) continue;
      const lastMsg = latestMessages.get(aid);
      if (lastMsg) {
        const existing = this.bubbles.get(aid);
        // Only show a new speech bubble if we don't already have one (or it expired)
        if (!existing || existing.type === "thought") {
          // Find the conversation this agent is in
          const convo = conversations.find(c => {
            const participants = c.participants ?? [];
            return participants.some(p => {
              const pid = typeof p === "string" ? p : p?.agentId;
              return pid === aid;
            });
          });
          const sentiment = (convo as any)?.sentiment ?? 0;
          // Determine bubble offset for multi-agent conversations
          const participants = convo?.participants ?? [];
          const participantIds = participants.map((p: any) => typeof p === "string" ? p : p?.agentId).filter(Boolean);
          const isMultiAgent = participantIds.length > 1;
          const participantIndex = participantIds.indexOf(aid);
          const offsetX = isMultiAgent ? (participantIndex === 0 ? -20 : 20) : 0;
          this.showSpeechBubble(aid, lastMsg, pos, sentiment, offsetX);
        }
      } else {
        if (!this.bubbles.has(aid)) {
          this.showThoughtBubble(aid, pos);
        }
      }
    }

    // Remove bubbles for agents no longer in conversations (except emotes/timed)
    for (const [key, entry] of this.bubbles) {
      if (key.includes("__emote")) continue;
      if ((entry.type === "speech" || entry.type === "thought") && !convoAgents.has(entry.agentId)) {
        entry.container.destroy({ children: true });
        this.bubbles.delete(key);
      }
    }

    // Auto-emote triggers based on mood changes
    for (const a of agents) {
      const aid = a._id ?? a.id;
      if (!aid) continue;
      const pos = posMap.get(aid);
      if (!pos) continue;
      const curMood = (a as any).needs?.mood ?? 50;
      const prevMood = this.prevMoodMap.get(aid) ?? 50;

      if (curMood > 80 && prevMood <= 80) this.showEmote(aid, "heart", pos);
      if (curMood < 20 && prevMood >= 20) this.showEmote(aid, "cry", pos);

      this.prevMoodMap.set(aid, curMood);
    }

    // Update positions and lifetimes
    for (const [key, entry] of this.bubbles) {
      // Expire timed bubbles
      if (entry.duration > 0 && now - entry.createdAt > entry.duration) {
        entry.container.destroy({ children: true });
        this.bubbles.delete(key);
        continue;
      }

      // Float emotes upward and fade
      if (entry.type === "emote") {
        entry.container.y -= EMOTE_FLOAT_SPEED * deltaTime;
        const elapsed = now - entry.createdAt;
        entry.container.alpha = Math.max(0, 1 - elapsed / entry.duration);
      }

      // Re-position non-emote bubbles to follow agent
      if (entry.type !== "emote") {
        const pos = posMap.get(entry.agentId);
        if (pos) {
          const half = SPRITE_CONFIG.AGENT_SIZE / 2;
          const w = entry.container.width;
          entry.container.x = pos.x + half - w / 2;
          entry.container.y = pos.y - entry.container.height - 8;
        }
      }
    }
  }

  destroy() {
    for (const [, entry] of this.bubbles) {
      entry.container.destroy({ children: true });
    }
    this.bubbles.clear();
    this.prevMoodMap.clear();
    this.container.destroy({ children: true });
  }
}
