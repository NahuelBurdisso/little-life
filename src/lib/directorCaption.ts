/**
 * The director's lower-third: what the current shot says, as text.
 *
 * A caption is one line of context ("Mara confronts Jonas") plus the latest
 * lines of the conversation on screen ("Mara: ..."). Everything here is derived
 * from what the server already stores on a conversation — the opener is
 * `participants[0]`, the intent is `topic` / `trigger_reason` — so no new column
 * or endpoint was needed. Pure, tested in `__tests__/directorCaption.test.ts`.
 *
 * Spoilers: a player-told secret is queued with the topic "revealing: <the
 * fact>". The camera shows what people *say*, but the one-line context must not
 * print the fact for them, so those topics are reduced to "lets X in on a
 * secret" — the same rule lib/brewing.ts follows.
 */
import type { Shot } from './director';

/** Speaker colour slots (`--ui-speaker-N` in globals.css), by seat at the table. */
export const SPEAKER_SLOTS = 4;

export interface CaptionLine {
  speakerId: number | null;
  name: string;
  text: string;
  /** 0..SPEAKER_SLOTS-1, stable per resident within a conversation. */
  color: number;
  /** A canned "Omar smiled and nodded." action: shown as narration, not speech. */
  narration: boolean;
  /** Index in the conversation, so a new line is told apart from a re-render. */
  index: number;
}

export interface Caption {
  /** The shot this belongs to: the overlay fades out when it changes. */
  shotKey: string;
  conversationId: number | null;
  context: string;
  lines: CaptionLine[];
}

export interface CaptionConversation {
  id: number;
  participants: number[];
  messages: ReadonlyArray<Record<string, unknown>>;
  topic?: string | null;
  trigger_reason?: string | null;
  location?: number | null;
}

/** Two lines fit a lower-third at reading speed; the older one is dimmed. */
export const CAPTION_MAX_LINES = 2;
/** Long monologues are cut so the bar stays two lines high. */
export const CAPTION_MAX_CHARS = 200;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'Someone';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * "Mara confronts Jonas" — the one-line intent. `names[0]` is the initiator
 * (the conversation opens with `participants[0]`), the rest are who they are
 * with. Unknown topics fall back to "talk about <topic>", no topic to "talk".
 */
export function contextLine(names: readonly string[], topic: string | null | undefined, triggerReason: string | null | undefined): string {
  const a = names[0] ?? 'Someone';
  const others = names.slice(1);
  const b = others.length > 0 ? joinNames(others) : 'someone';
  const both = joinNames(names);
  const t = (topic ?? '').trim();
  const lower = t.toLowerCase();
  const trigger = triggerReason ?? '';

  if (trigger.startsWith('player_tell_secret') || lower.startsWith('revealing')) return `${a} lets ${b} in on a secret`;
  if (trigger.startsWith('player_confront') || /confront/.test(lower)) return `${a} confronts ${b}`;
  const gossip = /^gossip about (.+)$/.exec(t);
  if (gossip) return `${both} gossip about ${gossip[1]}`;
  if (/gossip|rumou?r/.test(lower)) return `${both} swap rumours`;
  if (/flirt/.test(lower)) return `${a} flirts with ${b}`;
  if (/vent/.test(lower)) return `${a} vents to ${b}`;
  if (/seeking comfort/.test(lower) || trigger === 'comfort_visit') return `${a} seeks comfort from ${b}`;
  if (/offering comfort/.test(lower)) return `${a} offers ${b} comfort`;
  if (/offering help/.test(lower)) return `${a} offers ${b} a hand`;
  if (/checking (in|on)/.test(lower)) return `${a} checks in on ${b}`;
  if (/celebrat/.test(lower)) return `${a} celebrates with ${b}`;
  if (/tension|argu|fight|clash/.test(lower)) return `${both} clash, tension in the air`;
  if (/sharing secrets/.test(lower)) return `${both} share secrets`;
  if (/reminisc/.test(lower)) return `${both} reminisce`;
  if (/catching up/.test(lower)) return `${both} catch up`;
  return t ? `${both} talk about ${lower}` : `${both} talk`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > CAPTION_MAX_CHARS ? `${flat.slice(0, CAPTION_MAX_CHARS - 1).trimEnd()}…` : flat;
}

/**
 * Which live conversation a shot is about: its own for a conversation shot,
 * otherwise the one involving the shot's lead resident (then any of its cast),
 * otherwise, for a place, the busiest talk held there.
 */
export function findShotConversation<C extends CaptionConversation>(
  shot: Pick<Shot, 'key' | 'agentIds' | 'locationId'>,
  conversations: readonly C[],
): C | null {
  const own = /^convo:(\d+)$/.exec(shot.key);
  if (own) {
    const hit = conversations.find((c) => c.id === Number(own[1]));
    if (hit) return hit;
  }
  for (const id of shot.agentIds) {
    const hit = conversations.find((c) => c.participants.includes(id));
    if (hit) return hit;
  }
  if (shot.locationId != null) {
    const here = conversations.filter((c) => c.location === shot.locationId);
    if (here.length > 0) return here.reduce((a, b) => (b.messages.length > a.messages.length ? b : a));
  }
  return null;
}

/**
 * The caption for a shot, or null when there is nothing to say (a roam stop
 * with no label and no talk). `nameOf` resolves a resident id.
 */
export function buildCaption<C extends CaptionConversation>(
  shot: Pick<Shot, 'key' | 'agentIds' | 'locationId' | 'label'>,
  conversations: readonly C[],
  nameOf: (id: number) => string,
): Caption | null {
  const convo = findShotConversation(shot, conversations);
  if (!convo) return shot.label ? { shotKey: shot.key, conversationId: null, context: shot.label, lines: [] } : null;

  const names = convo.participants.map(nameOf);
  const lines: CaptionLine[] = [];
  convo.messages.forEach((m, index) => {
    const text = typeof m.text === 'string' ? clip(m.text) : '';
    if (!text) return;
    const speakerId = typeof m.speakerId === 'number' ? m.speakerId : null;
    const seat = speakerId == null ? -1 : convo.participants.indexOf(speakerId);
    lines.push({
      speakerId,
      name: speakerId == null ? '' : nameOf(speakerId),
      text,
      color: seat < 0 ? 0 : seat % SPEAKER_SLOTS,
      narration: m.fallback === true,
      index,
    });
  });

  return {
    shotKey: shot.key,
    conversationId: convo.id,
    context: contextLine(names, convo.topic, convo.trigger_reason),
    lines: lines.slice(-CAPTION_MAX_LINES),
  };
}
