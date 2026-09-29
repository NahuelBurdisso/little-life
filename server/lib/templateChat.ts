/**
 * Template-chat composer: plays one small-talk topic script
 * (server/data/smallTalkScripts.ts) as a coherent mini-exchange.
 *
 * Pure — no DB. conversations.ts gathers the real context (weather, place,
 * events, a mutual acquaintance, needs, jobs, the relationship) into a
 * `ChatContext`, reads the pair's per-script cooldowns from `template_usage`,
 * and records the script it got back.
 *
 * Guarantees the tests hold it to (templateChat.test.ts):
 *  - every line carries one of the script's topic anchors, so each reply is
 *    about what the previous line said;
 *  - a question is followed by an answer written for it;
 *  - no unfilled `{placeholder}` (a line whose slot has no value is skipped);
 *  - nobody says their own name, and people are addressed by first name;
 *  - no line repeats within a chat;
 *  - it always ends on a closing line.
 */

import {
  FOLLOW_ACKS,
  SMALL_TALK_SCRIPTS,
  type ChatContext,
  type ChatPerson,
  type OpenerLine,
  type ScriptLine,
  type Tone,
  type TopicScript,
  type Voice,
} from '../data/smallTalkScripts';
import type { PersonalityProfile } from './personality';

export type Rng = () => number;

export type TemplateMove = 'ask' | 'tell' | 'answer' | 'react' | 'follow' | 'close';

export interface TemplateTurn {
  /** Index into `ChatContext.people`: 0 = opener, 1 = listener. */
  speaker: 0 | 1;
  text: string;
  sentiment: number;
  move: TemplateMove;
}

export interface TemplateChat {
  scriptId: string;
  /** Conversation topic label ("the rain", "Rosa", "a drink at the tavern"). */
  topic: string;
  /** The words every line of this chat contains one of (lower case). */
  anchors: string[];
  turns: TemplateTurn[];
}

/** How a personality talks. Coarse on purpose: it only picks among written variants. */
export function voiceOf(p: PersonalityProfile | null | undefined): Voice {
  if (!p) return 'plain';
  if (p.aggression >= 65 || p.warmth <= 25) return 'gruff';
  if (p.warmth >= 65 && p.impulsiveness >= 60) return 'bubbly';
  if (p.neuroticism >= 65 && p.warmth < 65) return 'shy';
  if (p.warmth >= 65) return 'warm';
  return 'plain';
}

/**
 * How someone comes across to this listener: their feelings for them, and
 * their own mood. Below 30 is the mood the rough-day script notices, so the
 * same person can't look miserable and chirp about the sunshine.
 */
export function toneOf(friendship: number, mood: number): Tone {
  if (friendship < -10 || mood < 30) return 'cool';
  if (friendship >= 30 && mood >= 40) return 'warm';
  return 'neutral';
}

/**
 * Whether a location's name can be said aloud in a line. Worldgen homes are
 * "Home 4" (nobody says "Do you come to Home 4 often?"), and a place named
 * after one of the two speakers ("Rosa's Bakery") would have Rosa naming
 * herself — the topic scripts fall back to lines without `{place}`.
 */
export function placeIsSpeakable(name: string, type: string | null, firstNames: string[]): boolean {
  if (!name.trim()) return false;
  if (type === 'home' || type === 'house' || /^home\b/i.test(name.trim())) return false;
  return !firstNames.some((n) => n && new RegExp(`\\b${escapeRegExp(n)}\\b`, 'i').test(name));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Slot values for a line said by `speakerIdx`. `{you}` is always the OTHER
 * person — the reason a template can never make someone address themselves.
 * `{work}`/`{job}` are the listener's (people[1]): the work topic is theirs.
 */
function slotsFor(c: ChatContext, speakerIdx: 0 | 1): Record<string, string | undefined> {
  const you = c.people[speakerIdx === 0 ? 1 : 0];
  return {
    you: you.first,
    place: c.place.speakable ? c.place.name : undefined,
    mutual: c.mutual?.first,
    event: c.event?.phrase,
    Event: c.event ? capitalize(c.event.phrase) : undefined,
    work: c.people[1].workplace ?? undefined,
    job: c.people[1].job ?? undefined,
    tavern: c.roles.tavern,
    baker: c.roles.baker,
    bartender: c.roles.bartender,
  };
}

/** Fill `{slots}`; null when one has no value (the line is then not sayable here). */
function render(text: string, slots: Record<string, string | undefined>): string | null {
  let missing = false;
  const out = text.replace(/\{([A-Za-z]+)\}/g, (_m, key: string, offset: number) => {
    const value = slots[key];
    if (value == null || value === '') {
      missing = true;
      return '';
    }
    // "The Rusty Lantern" mid-sentence reads "the Rusty Lantern".
    return offset > 0 && /^The\s/.test(value) ? `t${value.slice(1)}` : value;
  });
  if (missing || /[{}]/.test(out)) return null;
  return capitalize(out);
}

interface Picked<L extends ScriptLine> {
  line: L;
  text: string;
}

function pickFrom<T>(items: T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/**
 * One line from `pool` for `speakerIdx`: its `when` must hold for the real
 * state, its tone and voice tags must fit the speaker, and it must render and
 * be new to this chat. Among what's left, a speaker who comes across cool
 * avoids the cheerful lines, and a line written for their voice wins most of
 * the time — so a gruff farmer and a bubbly baker say different things.
 */
function pickLine<L extends ScriptLine>(
  pool: readonly L[] | undefined,
  c: ChatContext,
  speakerIdx: 0 | 1,
  used: Set<string>,
  rng: Rng,
): Picked<L> | null {
  if (!pool?.length) return null;
  const me: ChatPerson = c.people[speakerIdx];
  const you: ChatPerson = c.people[speakerIdx === 0 ? 1 : 0];
  const slots = slotsFor(c, speakerIdx);
  const candidates: Picked<L>[] = [];
  for (const line of pool) {
    if (line.when && !line.when(c, me, you)) continue;
    if (line.tone && !line.tone.includes(me.tone)) continue;
    if (line.voice && !line.voice.includes(me.voice)) continue;
    const text = render(line.text, slots);
    if (text == null || used.has(text)) continue;
    candidates.push({ line, text });
  }
  if (candidates.length === 0) return null;
  const tempered = me.tone === 'cool' ? candidates.filter((x) => x.line.s <= 0.1) : candidates;
  const pool2 = tempered.length > 0 ? tempered : candidates;
  const voiced = pool2.filter((x) => x.line.voice?.includes(me.voice));
  const chosen = voiced.length > 0 && rng() < 0.7 ? pickFrom(voiced, rng) : pickFrom(pool2, rng);
  used.add(chosen.text);
  return chosen;
}

/** Chance a script gets its follow-up beat (4 lines instead of 3). */
const FOLLOW_CHANCE = 0.6;

/** Play one script, or null when this context can't voice it (no opener/reply/close fits). */
export function playScript(script: TopicScript, c: ChatContext, rng: Rng = Math.random): TemplateChat | null {
  const tried = new Set<OpenerLine>();
  for (let attempt = 0; attempt < script.openers.length; attempt++) {
    const used = new Set<string>();
    const opener = pickLine(script.openers.filter((o) => !tried.has(o)), c, 0, used, rng);
    if (!opener) return null;
    tried.add(opener.line);

    // The reply is written for THIS opener; a statement without its own
    // replies takes the script's generic reactions. A question never does:
    // "Is it ever going to stop raining?" can't be answered by a reaction.
    const replyPool = opener.line.replies ?? (opener.line.kind === 'tell' ? script.react : undefined);
    const reply = pickLine(replyPool, c, 1, used, rng);
    if (!reply) continue;

    const turns: TemplateTurn[] = [
      { speaker: 0, text: opener.text, sentiment: opener.line.s, move: opener.line.kind },
      { speaker: 1, text: reply.text, sentiment: reply.line.s, move: opener.line.kind === 'ask' ? 'answer' : 'react' },
    ];

    // Follow-up: the opener acknowledges the reply's stance, then adds one
    // more thing on the same topic.
    if (script.follow && rng() < FOLLOW_CHANCE) {
      const follow = pickLine(script.follow, c, 0, used, rng);
      const acks = (script.acks ?? FOLLOW_ACKS)[reply.line.stance ?? 'neutral'];
      const ack = follow ? pickLine(acks, c, 0, used, rng) : null;
      if (follow && ack) {
        turns.push({
          speaker: 0,
          text: `${ack.text} ${follow.text}`,
          sentiment: (ack.line.s + follow.line.s) / 2,
          move: 'follow',
        });
      }
    }

    // The close goes to whoever didn't speak last, so the chat alternates.
    let closer: 0 | 1 = turns[turns.length - 1].speaker === 0 ? 1 : 0;
    let close = pickLine(script.close, c, closer, used, rng);
    if (!close && turns.length === 3) {
      // No closing line fits the listener: drop the follow-up and let the
      // opener sign off instead.
      turns.pop();
      closer = 0;
      close = pickLine(script.close, c, closer, used, rng);
    }
    if (!close) continue;
    turns.push({ speaker: closer, text: close.text, sentiment: close.line.s, move: 'close' });

    return { scriptId: script.id, topic: script.topic(c), anchors: script.anchors(c), turns };
  }
  return null;
}

export function isHostile(c: ChatContext): boolean {
  return c.people[0].friendship < -10 || c.status === 'rivals' || c.status === 'enemies';
}

/** The scripts this context could play, before cooldowns. */
export function eligibleScripts(c: ChatContext, scripts: readonly TopicScript[] = SMALL_TALK_SCRIPTS): TopicScript[] {
  const hostile = isHostile(c);
  return scripts.filter((s) => (!hostile || s.hostileOk) && s.when(c));
}

export interface ComposeOptions {
  rng?: Rng;
  /** Game minute each script id was last used by this pair (template_usage). */
  lastUsed?: ReadonlyMap<string, number>;
  nowGameMin?: number;
  scripts?: readonly TopicScript[];
}

/**
 * Pick a topic and play it. Scripts off cooldown come first, drawn by weight
 * (a shared event or a friend in common beats the weather, which beats "the
 * day"); when every eligible topic is on cooldown — a pair that keeps bumping
 * into each other — the least recently used one is replayed rather than the
 * pair standing in silence. Null only if nothing at all can be voiced.
 */
export function composeTemplateChat(c: ChatContext, opts: ComposeOptions = {}): TemplateChat | null {
  const rng = opts.rng ?? Math.random;
  const lastUsed = opts.lastUsed ?? new Map<string, number>();
  const now = opts.nowGameMin ?? 0;
  const eligible = eligibleScripts(c, opts.scripts);

  const onCooldown = (s: TopicScript) => {
    const at = lastUsed.get(s.id);
    return at != null && now - at < s.cooldownHours * 60;
  };
  const fresh = eligible.filter((s) => !onCooldown(s));
  const stale = eligible.filter(onCooldown).sort((x, y) => (lastUsed.get(x.id) ?? 0) - (lastUsed.get(y.id) ?? 0));

  // Weighted order without replacement over the fresh scripts.
  const order: TopicScript[] = [];
  const pool = fresh.map((s) => ({ s, w: Math.max(0.01, s.weight(c)) }));
  while (pool.length > 0) {
    const total = pool.reduce((sum, p) => sum + p.w, 0);
    let roll = rng() * total;
    let i = 0;
    while (i < pool.length - 1 && roll >= pool[i].w) {
      roll -= pool[i].w;
      i++;
    }
    order.push(pool[i].s);
    pool.splice(i, 1);
  }
  order.push(...stale);

  for (const script of order) {
    const chat = playScript(script, c, rng);
    if (chat) return chat;
  }
  return null;
}

/** `template_usage.template_category` for a script, so it shares the per-pair cooldown table. */
export function scriptUsageCategory(scriptId: string): string {
  return `script:${scriptId}`;
}
