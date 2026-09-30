/**
 * Drama beats for TEMPLATE chats: deterministic outcome rules read off the pair's state and
 * the topic script that was played.
 *
 * WHY: the LLM tier reads its beats off the transcript (a bitter exchange → insult, a
 * flirtatious one → flirt, conversations.ts). A template chat has no transcript worth reading
 * — its lines are picked FROM the pair's state — so it produced no beats at all, and a town on
 * templates (LLM off, or the ~25% of chats that fall back even with it on) ran on gossip
 * alone: a 30-day soak saw two beat types. Here the same state that picked the script decides
 * what the exchange came to:
 *   - a hostile standoff can boil over: the more aggressive one insults the other, and an
 *     aggressive, angry or drunk one may take it further (a fight);
 *   - a sour exchange between merely cool people can end in an insult from a hothead;
 *   - someone sweet on the listener (the `flirting`, `shy_flirt` or `sweethearts` script) flirts, if the
 *     listener didn't rebuff them;
 *   - an honest person with a secret on their conscience confides in someone they trust;
 *   - a pair with a grudge or a rivalry behind them who manage a warm exchange may make up,
 *     if one of them is loyal or warm enough to offer it.
 * Plus the one rule the LLM tier applies to every chat, no roll: someone who knows about
 * their partner's affair reacts to it (breakup, forgiveness, quiet end).
 *
 * Chances are PER CHAT (an event, not a rate) and modest; a pair gets at most one beat per
 * `PAIR_BEAT_COOLDOWN_MINUTES` of game time, so two rivals who keep bumping into each other
 * don't brawl every hour. The decision (`decideTemplateBeats`) is pure; `applyTemplateBeats`
 * writes the effects through lib/conversationBeats.ts, so a template beat is the same feed
 * row, interaction event, fact and memory as an LLM one.
 */
import { db } from '../db';
import { activityLog, agentStates } from '../db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { PersonalityProfile } from './personality';
import {
  emitFightBeat, emitFlirtBeat, emitInsultBeat, findConfessableSin, insertPairEvent, pairRelationship,
  performConfession, performReconciliation, reactToPartnerAffair, type BeatAgent,
} from './conversationBeats';
import { getNegativeFactCount } from './gossip';

export type Rng = () => number;

/** One side of the chat as the rules see it. */
export interface BeatPerson {
  personality: PersonalityProfile | null;
  /** State types, and who each targeted state is about (`angry` at whom, `infatuated` with whom). */
  states: ReadonlyArray<{ type: string; target: number | null }>;
  /** This person's feelings toward the OTHER one. */
  friendship: number;
  romance: number;
  trust: number;
  /** Has a secret of their own few people know (conversationBeats `findConfessableSin`). */
  hasConfessableSin: boolean;
  /** Active negative facts about them (a reconciliation doesn't forgive a known scoundrel). */
  negativeFacts: number;
}

export interface TemplateBeatInput {
  scriptId: string;
  /** Mean sentiment of the chat's lines. */
  sentiment: number;
  /** [opener, listener], with ids so a state's target can be matched. */
  ids: [number, number];
  people: [BeatPerson, BeatPerson];
  status: string | null;
  tags: readonly string[];
}

export type TemplateBeatKind = 'insult' | 'fight' | 'flirt' | 'confession' | 'reconciliation';

/** `actor` (0 opener, 1 listener) does it to the other one. */
export interface TemplateBeat {
  kind: TemplateBeatKind;
  actor: 0 | 1;
}

/** Game minutes between two template drama beats for the same pair. */
export const PAIR_BEAT_COOLDOWN_MINUTES = 360;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const trait = (p: BeatPerson, k: keyof PersonalityProfile) => (p.personality?.[k] as number | undefined) ?? 50;
const hasState = (p: BeatPerson, type: string, targetId?: number) =>
  p.states.some((s) => s.type === type && (targetId == null || s.target == null || s.target === targetId));

/** Scripts a crush plays out on: the one written for it and the established couple's. */
const FLIRT_SCRIPTS = new Set(['flirting', 'shy_flirt', 'sweethearts']);
const HOSTILE_SCRIPT = 'standoff';

/**
 * What this template chat came to — usually nothing. At most one beat, except an insult
 * that escalates into a fight.
 */
export function decideTemplateBeats(input: TemplateBeatInput, rng: Rng = Math.random): TemplateBeat[] {
  const [p0] = input.people;
  const other = (i: 0 | 1): 0 | 1 => (i === 0 ? 1 : 0);

  // ── Hostility: the standoff, or a sour exchange between cool people ──
  const hostileScript = input.scriptId === HOSTILE_SCRIPT;
  if (hostileScript || input.sentiment < -0.25) {
    // The one who brings more fight to it speaks first; an angry or drunk one more so.
    const heat = (i: 0 | 1) => {
      const p = input.people[i];
      return trait(p, 'aggression')
        + (hasState(p, 'angry', input.ids[other(i)]) ? 20 : 0)
        + (hasState(p, 'drunk') ? 15 : 0);
    };
    const aggressor: 0 | 1 = heat(1) > heat(0) ? 1 : 0;
    const h = heat(aggressor);
    // Standoff: 5% for a mild soul up to 35% for a hothead; a merely sour chat needs a
    // hothead (heat > 60) and tops out at 15%.
    const pInsult = hostileScript
      ? clamp(0.1 + (h - 50) * 0.006, 0.05, 0.35)
      : h > 60 ? clamp((h - 60) * 0.005, 0, 0.15) : 0;
    if (pInsult > 0 && rng() < pInsult) {
      const beats: TemplateBeat[] = [{ kind: 'insult', actor: aggressor }];
      // Words turn to shoving only for someone already past words: aggressive, angry or drunk.
      const pFight = h >= 75 ? 0.3 : h >= 65 ? 0.12 : 0;
      if (hostileScript && pFight > 0 && rng() < pFight) beats.push({ kind: 'fight', actor: aggressor });
      return beats;
    }
    return [];
  }

  // ── Warm outcomes: need the listener not to have rebuffed it ──
  if (input.sentiment <= 0.1) return [];

  // A crush flirts. The opener is the one sweet on the listener (the script's `when`).
  if (FLIRT_SCRIPTS.has(input.scriptId) && p0.romance >= 20) {
    const infatuated = hasState(p0, 'infatuated', input.ids[1]);
    const p = clamp(0.2 + (trait(p0, 'sensuality') - 50) * 0.005 + (infatuated ? 0.1 : 0), 0.08, 0.4);
    if (rng() < p) return [{ kind: 'flirt', actor: 0 }];
  }

  // An honest one with something on their conscience, talking to someone they trust.
  for (const i of [0, 1] as const) {
    const me = input.people[i];
    if (!me.hasConfessableSin || trait(me, 'honesty') <= 50 || me.trust <= 50) continue;
    if (rng() < 0.2) return [{ kind: 'confession', actor: i }];
  }

  // Old enemies, a warm exchange, and one of them big enough to offer peace. Never across
  // estrangement: that door is shut for good (relationships.ts).
  const pastFeud = input.tags.includes('grudge') || input.tags.includes('rival')
    || input.status === 'rivals' || input.status === 'complicated';
  if (pastFeud && !input.tags.includes('estranged') && input.status !== 'estranged') {
    for (const i of [0, 1] as const) {
      const me = input.people[i];
      const them = input.people[other(i)];
      const generous = trait(me, 'loyalty') > 55 || trait(me, 'warmth') > 60;
      if (!generous || me.friendship < -10 || them.negativeFacts >= 3) continue;
      if (rng() < 0.2) return [{ kind: 'reconciliation', actor: i }];
    }
  }
  return [];
}

// ─── Effects ──────────────────────────────────────────────────────────────────

type AgentRow = BeatAgent & { personality?: unknown };

/** Beats that count toward the pair cooldown (a gossip row naming them both does not). */
const CONVERSATION_BEATS = new Set(['insult', 'fight', 'flirt', 'confession', 'reconciliation', 'breakup']);

function recentPairBeat(a: number, b: number, sinceMinute: number): boolean {
  const rows = db.select({ initiator: activityLog.initiator_id, target: activityLog.target_id, metadata: activityLog.metadata })
    .from(activityLog)
    .where(and(eq(activityLog.type, 'drama'), gte(activityLog.game_minute, sinceMinute), inArray(activityLog.initiator_id, [a, b])))
    .all();
  return rows.some((r) => ((r.initiator === a && r.target === b) || (r.initiator === b && r.target === a))
    && CONVERSATION_BEATS.has(String((r.metadata as { beat?: unknown } | null)?.beat)));
}

function statesOf(agentId: number): Array<{ type: string; target: number | null }> {
  return db.select({ type: agentStates.type, target: agentStates.target_agent_id })
    .from(agentStates).where(eq(agentStates.agent_id, agentId)).all();
}

/**
 * Read the pair, decide, and write whatever the chat came to. `pair` is [opener, listener] —
 * the order the script was played in. Returns the beats applied (tests, the caller ignores it).
 */
export function applyTemplateBeats(
  pair: [AgentRow, AgentRow],
  scriptId: string,
  sentiment: number,
  nowMinutes: number,
  rng: Rng = Math.random,
): TemplateBeat[] {
  const [a, b] = pair;

  // The LLM tier's no-roll rule: knowing about a partner's affair comes out when they talk.
  if (reactToPartnerAffair(a, b, nowMinutes) || reactToPartnerAffair(b, a, nowMinutes)) return [];

  if (recentPairBeat(a.id, b.id, nowMinutes - PAIR_BEAT_COOLDOWN_MINUTES)) return [];

  const rel = pairRelationship(a.id, b.id);
  const toward = (fromId: number) => {
    if (!rel) return { friendship: 0, romance: 0, trust: 0 };
    const isA = rel.agent_a === fromId;
    return {
      friendship: isA ? rel.friendship_ab : rel.friendship_ba,
      romance: isA ? rel.romance_ab : rel.romance_ba,
      trust: isA ? rel.trust_ab : rel.trust_ba,
    };
  };
  const person = (agent: AgentRow): BeatPerson => ({
    personality: (agent.personality as PersonalityProfile | null) ?? null,
    states: statesOf(agent.id),
    ...toward(agent.id),
    hasConfessableSin: findConfessableSin(agent.id) != null,
    negativeFacts: getNegativeFactCount(agent.id),
  });

  const beats = decideTemplateBeats({
    scriptId,
    sentiment,
    ids: [a.id, b.id],
    people: [person(a), person(b)],
    status: rel?.status ?? null,
    tags: (rel?.tags as string[] | undefined) ?? [],
  }, rng);

  for (const beat of beats) {
    const actor = beat.actor === 0 ? a : b;
    const target = beat.actor === 0 ? b : a;
    switch (beat.kind) {
      case 'insult':
        emitInsultBeat(actor, target, `${actor.name} insulted ${target.name} to their face`);
        // The template exchange's own deltas are light; an insult stings on top of them.
        insertPairEvent(actor.id, target.id, 'insult', `${actor.name} insulted ${target.name}`, {
          friendshipFrom: -2, friendshipTo: -6, trustFrom: 0, trustTo: -4,
        }, -0.6);
        break;
      case 'fight':
        emitFightBeat(actor, target, `${actor.name} and ${target.name} came to blows`);
        insertPairEvent(actor.id, target.id, 'fight', `${actor.name} started a fight with ${target.name}`, {
          friendshipFrom: -10, friendshipTo: -12, trustFrom: -6, trustTo: -10,
        }, -0.9);
        break;
      case 'flirt':
        emitFlirtBeat(actor, target, `${actor.name} flirted with ${target.name}`);
        insertPairEvent(actor.id, target.id, 'flirting', `${actor.name} flirted with ${target.name}`, {
          friendshipFrom: 1, friendshipTo: 1, romanceFrom: 4, romanceTo: 2,
        }, 0.5);
        break;
      case 'confession': {
        const sin = findConfessableSin(actor.id);
        if (sin) performConfession(actor, target, sin);
        break;
      }
      case 'reconciliation':
        if (rel) performReconciliation(rel, actor, target);
        break;
    }
  }
  return beats;
}
