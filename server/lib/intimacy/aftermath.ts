import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agentStates, agents, relationships } from '../../db/schema';
import { addMoodModifier } from '../dailyLife';
import { insertPairEvent, pairRelationship } from '../conversationBeats';
import { learnFact } from '../gossip';
import { recordGoalOutcome } from '../goals/goalProgress';
import { affairInvolvesMarriage, affairSensitivity } from '../marriage';
import { LOVERS_TAG } from '../storyBeats';
import { committedTo } from './committed';
import { simEvents } from '../simEvents';
import { getEffectivePersonality, type StateType } from '../states';
import { isAdultContent } from '../worldRules';
import { isIntimacyEligible } from './eligibility';
import { relieveLongingTo } from './longing';
import { rollTrystConception } from './pregnancy';
import { getStay, updateAgentIntimacy, updatePairIntimacy } from './state';

// ─── What a night leaves behind ──────────────────────────────────────────────
//
// The evening itself is off-stage (tryst.ts) and nothing here narrates it; this
// is the morning after, in numbers, tags, states and memories. It runs once per
// tryst, from tryst.ts's `onTrystCompleted`, after the pair's `activeTryst` is
// gone and only for two adults the age gate already let through (a minor never
// reaches `beginTryst`, so never this).
//
//   completed evening ─▶ the sticky `lovers` tag, a relationship event (the first
//        a pivotal `first_tryst`, kept forever; later ones a routine `tryst`),
//        longing spent down to a little, `afterglow` for ~8 game hours and a
//        memory each ("I spent the night with X" the first time, plainer after)
//        and, for a man and an unmarried woman of childbearing age, the conception
//        roll (pregnancy.ts)
//   if either is engaged or married to somebody else ─▶ the `affair` secret is
//        born from the act itself (known to the two), and whoever has a
//        conscience (morality > 60) is `guilty` for a day toward the betrayed
//   interrupted (somebody walked in) ─▶ none of that: no night happened. Both are
//        mortified for a few hours, and it does not count as the pair's first

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** The sticky relationship tag once a night together happened (contract name; the chronicle reads it from storyBeats.ts). */
export { LOVERS_TAG };

export const AFTERGLOW_MINUTES = 8 * 60;
export const AFTERGLOW_MOOD = 6;
export const GUILTY_MINUTES = 24 * 60;
/** Someone with at least this much conscience is troubled by betraying a partner. */
export const GUILT_MORALITY_ABOVE = 60;
/** Longing a night leaves behind: it does not vanish, it eases. */
export const LONGING_AFTER_NIGHT = 10;
/** Being walked in on: how mortified, and for how long. */
export const INTERRUPTED_MOOD = -8;
export const INTERRUPTED_MOOD_MINUTES = 4 * 60;

const FIRST_NIGHT_EFFECTS = { friendshipFrom: 2, friendshipTo: 2, romanceFrom: 5, romanceTo: 5, trustFrom: 3, trustTo: 3 };
const LATER_NIGHT_EFFECTS = { friendshipFrom: 1, friendshipTo: 1, romanceFrom: 2, romanceTo: 2, trustFrom: 1, trustTo: 1 };

// ─── A state, given ──────────────────────────────────────────────────────────

/**
 * Start one of the intimacy layer's fixed-length states, replacing any of the same
 * type the agent already has (a second night refreshes the afterglow instead of
 * stacking). Game minutes, like every state clock. `getAgentStates` notices the
 * write by itself (the write triggers bump its version).
 */
export function giveState(
  agentId: number,
  type: Extract<StateType, 'afterglow' | 'guilty' | 'suspicious'>,
  targetId: number,
  minutes: number,
  now: number,
  source: string,
): void {
  db.delete(agentStates).where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, type))).run();
  db.insert(agentStates).values({
    agent_id: agentId, type, severity: 0.6, started_at: now, duration: minutes,
    target_agent_id: targetId, source, metadata: null,
  }).run();
}

// ─── The hook ────────────────────────────────────────────────────────────────

export interface TrystCompletion {
  a: number;
  b: number;
  venueId: number;
  secret: boolean;
  /** The pair's first night together. */
  first: boolean;
  /** Somebody walked in and it ended early. */
  interrupted: boolean;
  /** Game minute it ended. */
  now: number;
}

type AgentRow = typeof agents.$inferSelect;

const remember = (agentId: number, description: string, valence: number, importance: number, relatedAgentId: number): void => {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId });
};

/** The evening is over: write what it leaves behind (see the header). */
export function applyTrystAftermath(t: TrystCompletion): void {
  const rows = db.select().from(agents).where(inArray(agents.id, [t.a, t.b])).all();
  const a = rows.find((r) => r.id === t.a);
  const b = rows.find((r) => r.id === t.b);
  // The pass ends an evening whose pair stopped being eligible (somebody left town, a
  // hand-built minor) without a night having happened: nothing is left behind.
  if (!a || !b || !isAdultContent() || !isIntimacyEligible(a, b)) return;

  if (t.interrupted) {
    interrupted(t, a, b);
    return;
  }
  spendTheNight(t, a, b);
  if (committedTo(a.id, b.id) != null || committedTo(b.id, a.id) != null) betrayal(t, a, b);
  // A night can leave more than a memory: the roll for an unmarried mother (pregnancy.ts).
  rollTrystConception(a, b, t.now);
}

function interrupted(t: TrystCompletion, a: AgentRow, b: AgentRow): void {
  // No night happened, so it is not their first: the next real one still is. The
  // count and the stamp go back with it (rendezvousRetryAfter stays: they wait).
  updatePairIntimacy(a.id, b.id, (p) => {
    p.trysts = Math.max(0, p.trysts - 1);
    if (t.first) delete p.firstTrystAt;
  });
  for (const [me, other] of [[a, b], [b, a]] as const) {
    addMoodModifier(me.id, INTERRUPTED_MOOD, 'tryst_interrupted', INTERRUPTED_MOOD_MINUTES, t.now);
    remember(me.id, `We were interrupted, and I have never been so embarrassed. ${other.name} and I did not speak of it.`, -0.6, 5, other.id);
  }
}

function spendTheNight(t: TrystCompletion, a: AgentRow, b: AgentRow): void {
  const rel = pairRelationship(a.id, b.id);
  if (rel && !rel.tags.includes(LOVERS_TAG)) {
    db.update(relationships).set({ tags: [...rel.tags, LOVERS_TAG] }).where(eq(relationships.id, rel.id)).run();
  }
  // The first night is a pivotal, permanent beat (storyBeats.ts ROMANTIC_EVENTS); later ones are routine.
  insertPairEvent(a.id, b.id, t.first ? 'first_tryst' : 'tryst',
    t.first ? `${a.name} and ${b.name} spent the night together` : `${a.name} and ${b.name} spent the evening together`,
    t.first ? FIRST_NIGHT_EFFECTS : LATER_NIGHT_EFFECTS,
    t.first ? 0.8 : 0.4);

  for (const [me, other] of [[a, b], [b, a]] as const) {
    // A night together is a seduction achieved for whoever had that goal aimed at the other (a first
    // and a later night alike: an already-completed goal is simply not active any more).
    recordGoalOutcome(me.id, other.id, 'night_together');
    relieveLongingTo(me.id, LONGING_AFTER_NIGHT);
    giveState(me.id, 'afterglow', other.id, AFTERGLOW_MINUTES, t.now, 'intimacy:tryst');
    addMoodModifier(me.id, AFTERGLOW_MOOD, 'afterglow', AFTERGLOW_MINUTES, t.now);
    if (t.first) remember(me.id, `I spent the night with ${other.name}.`, 0.9, 9, other.id);
    else remember(me.id, `Another evening with ${other.name}.`, 0.7, 4, other.id);

    // A guest who stays the night was away from home for it: the partner they share a bed
    // with may notice (suspicion.ts consumes this on the next morning).
    const stay = getStay(me.id);
    if (stay && !stay.leaving && stay.locationId === t.venueId) {
      updateAgentIntimacy(me.id, (s) => { s.awayNight = { since: t.now, hostId: stay.hostId }; });
    }
  }
}

/**
 * Either of them is committed to somebody else (partner, engaged or married: `committedTo`): the affair is born from the
 * act, known only to the two of them (the subject is whoever is spoken for, the
 * lower id when both are, so a repeat from either side lands on the same fact), and
 * whoever has a conscience carries it.
 */
function betrayal(t: TrystCompletion, a: AgentRow, b: AgentRow): void {
  const aTaken = committedTo(a.id, b.id) != null;
  const bTaken = committedTo(b.id, a.id) != null;
  const subject = aTaken && bTaken ? Math.min(a.id, b.id) : aTaken ? a.id : b.id;
  const target = subject === a.id ? b.id : a.id;
  learnFact('affair', subject, target, affairSensitivity(3, affairInvolvesMarriage(a.id, b.id)), [a.id, b.id], 'committed');

  for (const [cheater, other, taken] of [[a, b, aTaken], [b, a, bTaken]] as const) {
    if (!taken) continue;
    const morality = (getEffectivePersonality(cheater.id) ?? (cheater.personality as { morality?: number } | null))?.morality ?? 50;
    if (!(morality > GUILT_MORALITY_ABOVE)) continue;
    const betrayed = committedTo(cheater.id, other.id);
    if (betrayed != null) giveState(cheater.id, 'guilty', betrayed, GUILTY_MINUTES, t.now, 'intimacy:tryst');
  }
}
