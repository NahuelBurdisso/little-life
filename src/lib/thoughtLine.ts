/**
 * One line of "what is on this resident's mind", shared by the hover card and the inner-monologue
 * panel so the two can never disagree.
 *
 * It used to live inside `CurrentThought.tsx`, keyed on states the simulation never produces
 * (`in_love`, `injured`) and blind to whom a feeling is about. The server already sends that:
 * `agents.getActive` and `agents.getAgentSummary` both carry `target_agent_id` on every state row,
 * so a heartbroken resident can say who broke their heart.
 *
 * Voice: subjectless fragments ("Heartbroken over Jonas."). The hover card shows the name right
 * above and the panel puts the line in an italic quote, so repeating the name only made it long.
 * The residents' gender is never guessed: where a pronoun is needed it is they/them, and most
 * lines need none.
 *
 * Discretion: the adult layer's aftermath states get oblique wording on purpose. This line is on
 * screen for anyone hovering a sprite, so "afterglow" reads as a mood, never as a night together,
 * and "suspicious" says only that someone wonders where their partner goes.
 *
 * Pure (no DOM, no DB), tested in `__tests__/thoughtLine.test.ts`.
 */
import { contextLine } from './directorCaption';

/** Tone tints the line: dark = something is wrong, warm = affection, bright = good spirits. */
export type ThoughtTone = 'dark' | 'warm' | 'bright' | 'neutral';

export interface Thought {
  text: string;
  tone: ThoughtTone;
}

/** A card is a glance, not a paragraph: longer lines are cut with an ellipsis. */
export const THOUGHT_MAX_CHARS = 90;

/** The need columns this reads (0..100, higher is better), and mood / stress. */
export interface ThoughtNeeds {
  hunger: number;
  energy: number;
  social: number;
  mood: number;
  stress: number;
}

export interface ThoughtState {
  type: string;
  target_agent_id?: number | null;
}

export interface ThoughtAgent {
  id?: number | string;
  name: string;
  needs?: ThoughtNeeds | null;
  activeStates?: readonly ThoughtState[] | null;
}

/** The talk a resident is in: the subset of a `conversations` row `contextLine` reads. */
export interface ThoughtConversation {
  participants: number[];
  topic?: string | null;
  trigger_reason?: string | null;
}

export interface ThoughtContext {
  /** Name of a resident by id; undefined for someone who is gone or unknown. */
  nameOf: (id: number) => string | undefined;
  /** The conversation this resident is in right now, if any. */
  conversation?: ThoughtConversation | null;
}

/** Below this a need is "critical" (the old panel's `100 - need > 70`). */
const CRITICAL_NEED = 30;
const HIGH_STRESS = 70;
const HIGH_MOOD = 80;
const OKAY_MOOD = 50;

const dark = (text: string): Thought => ({ text, tone: 'dark' });
const warm = (text: string): Thought => ({ text, tone: 'warm' });
const neutral = (text: string): Thought => ({ text, tone: 'neutral' });

function clamp(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > THOUGHT_MAX_CHARS ? `${flat.slice(0, THOUGHT_MAX_CHARS - 1).trimEnd()}…` : flat;
}

/** Who a feeling points at, or "someone" (no target stored, or a resident who has since left). */
function targetName(state: ThoughtState, ctx: ThoughtContext): string {
  const id = state.target_agent_id;
  return (id != null ? ctx.nameOf(id) : undefined) || 'someone';
}

/**
 * The heavy feelings, strongest first. They outrank a conversation: someone mid-chat who is
 * grieving is still, above all, grieving.
 */
const FEELINGS: ReadonlyArray<readonly [string, (who: string) => string]> = [
  ['grieving', (who) => `Grieving for ${who}, and it weighs heavy.`],
  ['heartbroken', (who) => `Heartbroken over ${who}.`],
  ['jealous', (who) => `Burning with jealousy over ${who}.`],
  ['envious', (who) => `Envious of ${who}, and not proud of it.`],
  ['angry', (who) => `Furious with ${who}.`],
];

/**
 * States with no one to point at that still deserve their own line. They sit under the needs:
 * hunger is more pressing than being a bit stressed, but it is not "nothing" to be in debt.
 */
const MINOR: ReadonlyArray<readonly [string, Thought]> = [
  ['depressed', dark('Everything feels grey and far away.')],
  ['hungover', dark('Head pounding after too much last night.')],
  ['stressed', dark('Stressed out and struggling to focus.')],
  ['in_debt', dark('Worried about money and what is owed.')],
  ['alcoholic', dark('Thinking about the next drink.')],
  ['lonely', dark('Lonely, and wishing for company.')],
  ['euphoric', { text: 'On top of the world.', tone: 'bright' }],
  ['confident', { text: 'Feeling sure of themselves today.', tone: 'bright' }],
];

const hasState = (states: readonly ThoughtState[], type: string) => states.find((s) => s.type === type);

/**
 * The talk a resident is in, out of the active conversations, or null. `agentId` may be the
 * canvas's string id.
 */
export function conversationOf<C extends { participants: number[] }>(
  agentId: number | string | null | undefined,
  conversations: readonly C[] | null | undefined,
): C | null {
  if (agentId == null || !conversations) return null;
  const id = Number(agentId);
  return conversations.find((c) => c.participants.includes(id)) ?? null;
}

/**
 * What is on this resident's mind. Priority: arrested, the heavy feelings (grieving, heartbroken,
 * jealous, envious, angry: each names its target), being mid-conversation, infatuated, the
 * morning-after glow, sick, drunk, the quiet adult-layer states, a critical need, stress, the other
 * states, and finally plain mood. Always returns something.
 */
export function thoughtOf(agent: ThoughtAgent, ctx: ThoughtContext): Thought {
  const t = pick(agent, ctx);
  return { text: clamp(t.text), tone: t.tone };
}

function pick(agent: ThoughtAgent, ctx: ThoughtContext): Thought {
  const states = agent.activeStates ?? [];

  if (hasState(states, 'arrested')) return dark('Under arrest, and too rattled to think straight.');

  for (const [type, line] of FEELINGS) {
    const s = hasState(states, type);
    if (s) return dark(line(targetName(s, ctx)));
  }

  const convo = ctx.conversation;
  if (convo && convo.participants.length > 0) {
    const names = convo.participants.map((id) =>
      agent.id != null && id === Number(agent.id) ? agent.name : ctx.nameOf(id) || 'someone');
    return neutral(contextLine(names, convo.topic, convo.trigger_reason));
  }

  const smitten = hasState(states, 'infatuated');
  if (smitten) return warm(`Can't stop thinking about ${targetName(smitten, ctx)}.`);

  if (hasState(states, 'afterglow')) return warm('In a warm, faraway mood.');

  if (hasState(states, 'sick')) return dark('Feeling unwell and wishing for some rest.');

  if (hasState(states, 'drunk')) return neutral('A few drinks in, and in no hurry.');

  const suspicious = hasState(states, 'suspicious');
  if (suspicious) return dark(`Wondering where ${targetName(suspicious, ctx)} goes at night.`);

  if (hasState(states, 'guilty')) return dark("Carrying something they won't say.");

  const needs = agent.needs;
  if (needs) {
    // The lowest of the three, so a resident who is starving and tired says the more urgent one.
    const worst = [
      { value: needs.hunger, line: 'Really craving something to eat.' },
      { value: needs.energy, line: 'Exhausted and in need of rest.' },
      { value: needs.social, line: 'Lonely, and wanting company.' },
    ].sort((a, b) => a.value - b.value)[0];
    if (worst.value < CRITICAL_NEED) return dark(worst.line);
    if (needs.stress > HIGH_STRESS) return dark('Stressed out and struggling to focus.');
  }

  for (const [type, line] of MINOR) if (hasState(states, type)) return line;

  if (!needs) return neutral('Just existing right now.');
  if (needs.mood > HIGH_MOOD) return { text: 'Feeling great and in good spirits.', tone: 'bright' };
  if (needs.mood > OKAY_MOOD) return neutral('Getting through the day, one step at a time.');
  return neutral("Feeling a bit off, and can't quite say why.");
}

/** Tailwind text colour for a tone, so the card and the panel tint the same way. */
export function toneClass(tone: ThoughtTone): string {
  switch (tone) {
    case 'dark': return 'text-rose-300';
    case 'warm': return 'text-pink-300';
    case 'bright': return 'text-emerald-300';
    default: return 'text-ui-blue';
  }
}
