/**
 * Small misdeeds: the everyday material a calm town's gossip runs on.
 *
 * WHY: secrets came from drama (thefts, affairs, fights, drunken scenes in an argument) and
 * from the LLM tier's confidences. A town at peace — which a settled world soon is — stopped
 * producing them: a 30-day soak created no new secrets after day 14, and with `createFact`
 * keeping one fact per type and subject, the gossip engine ended up retelling the same few
 * rumors until everyone knew them. Real small towns never run out: someone runs up a tab they
 * can't pay, fibs about where they were, lies to cover a slip at work, drinks too much, makes
 * eyes at someone, forgets a promise.
 *
 * Once per game hour each awake resident may commit one, at a rate per game minute set by
 * temperament (impulsive, not very honest, not very principled → more) and gated by their
 * situation (money trouble for a debt, the tavern of an evening for a drunken scene, a crush in
 * the room, a coworker to lie to). Whoever else is in the room may NOTICE (curiosity helps):
 * they learn it as a fact — gossip material with names and a detail. Unnoticed, it is still a
 * secret the resident carries: curious neighbours may discover it later (gossip engine), and an
 * honest conscience may confess it (conversationBeats.ts).
 *
 * The catalogue and pick are pure; `smallMisdeedsHourly` reads the town and writes facts,
 * memories and (when noticed) a `misdeed` drama row.
 */
import { db } from '../db';
import { agents, agentStates, economy, locations, relationships, shared_knowledge } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { chancePerTick } from './gameClock';
import { createFact, getAgentSelf } from './gossip';
import { thatSentence } from './factText';
import type { PersonalityProfile } from './personality';
import { firstName as givenName } from '../ai/names';

export type Rng = () => number;

export interface MisdeedContext {
  hour: number;
  placeType: string | null;
  atWork: boolean;
  money: number;
  states: readonly string[];
  personality: PersonalityProfile | null;
  /** Awake people in the same place (not the resident). */
  present: readonly number[];
  /** Someone present this resident is sweet on (romance >= 25, not already a couple). */
  crushHere: number | null;
  /** Someone present with money to spare (a creditor for a debt). */
  creditorHere: number | null;
  /** Someone present this resident is friendly with (a promise to break). */
  friendHere: number | null;
}

export interface Misdeed {
  type: string;
  sensitivity: number;
  /** Relative pick weight here; 0 = impossible. */
  weight: (c: MisdeedContext) => number;
  /** Who it's done to, if anyone. */
  target: (c: MisdeedContext, rng: Rng) => number | null;
  details?: readonly string[];
  /** The resident's own memory of it (what they'd rather nobody knew). */
  memory: (detail: string | undefined, targetFirst: string | null) => string;
}

const trait = (c: MisdeedContext, k: keyof PersonalityProfile) => (c.personality?.[k] as number | undefined) ?? 50;
const EVENING = (c: MisdeedContext) => c.hour >= 18 || c.hour <= 1;
const anyPresent = (c: MisdeedContext, rng: Rng) =>
  c.present.length ? c.present[Math.min(c.present.length - 1, Math.floor(rng() * c.present.length))] : null;

export const MISDEEDS: readonly Misdeed[] = [
  {
    type: 'drunk_incident', sensitivity: 2,
    weight: (c) => ((c.placeType === 'tavern' || c.placeType === 'divebar') && EVENING(c)
      ? (c.states.includes('drunk') ? 3 : trait(c, 'impulsiveness') > 55 ? 1.5 : 0.5) : 0),
    target: () => null,
    memory: () => 'I had far too much to drink tonight and made a fool of myself.',
  },
  {
    type: 'debt', sensitivity: 2,
    weight: (c) => (c.money < 20 || c.states.includes('in_debt') ? 2 : 0),
    target: (c) => c.creditorHere,
    details: ['a tab left unpaid for weeks', 'a loan they swore to repay by Sunday', 'the rent money they borrowed'],
    memory: (_d, t) => (t ? `I still owe ${t} money, and I can't look them in the eye.` : "My debts are piling up and I haven't told a soul."),
  },
  {
    type: 'lie', sensitivity: 2,
    weight: (c) => (c.atWork && trait(c, 'honesty') < 55 ? 1.5 : 0),
    target: anyPresent,
    details: ['a broken tool', 'a spoiled batch', 'a missing entry in the ledger', 'a late delivery', 'a job left half done'],
    memory: (d, t) => `I lied${t ? ` to ${t}` : ''} to cover up ${d ?? 'a mistake'}. I hope it never comes out.`,
  },
  {
    type: 'white_lie', sensitivity: 2,
    weight: (c) => (c.present.length > 0 && trait(c, 'honesty') < 65 ? 1 : 0),
    target: anyPresent,
    details: [
      'where they were last night', 'being too busy to help', 'liking a gift', 'having read a letter',
      'why they were late', 'what they paid for their boots',
    ],
    memory: (d, t) => `I fibbed${t ? ` to ${t}` : ''} about ${d ?? 'something silly'}. Only a small lie.`,
  },
  {
    type: 'crush', sensitivity: 2,
    weight: (c) => (c.crushHere != null ? 2 : 0),
    target: (c) => c.crushHere,
    memory: (_d, t) => `I couldn't stop looking at ${t ?? 'them'}. I hope nobody noticed.`,
  },
  {
    type: 'broken_promise', sensitivity: 2,
    weight: (c) => (c.friendHere != null && trait(c, 'loyalty') < 50 ? 1 : 0),
    target: (c) => c.friendHere,
    details: ['they never came to help with the harvest', 'the book they swore to return', 'a secret they said they would keep'],
    memory: (_d, t) => `I broke my promise to ${t ?? 'a friend'}. I told myself it didn't matter.`,
  },
];

/** Misdeeds per game minute awake: ~0.3 a day for an average temperament, 0.1-0.55 by character. */
export function misdeedChancePerMinute(p: PersonalityProfile | null | undefined): number {
  const impulsiveness = p?.impulsiveness ?? 50;
  const honesty = p?.honesty ?? 50;
  const morality = p?.morality ?? 50;
  const factor = Math.min(1.8, Math.max(0.3, (impulsiveness + (100 - honesty) + (100 - morality)) / 150));
  return (0.3 / 960) * factor;
}

/** Chance a person in the room notices: a third of the time, more for the curious. */
export function noticeChance(curiosity: number): number {
  return 0.3 + curiosity / 250;
}

/** Weighted pick among the misdeeds possible here; null when none is. */
export function pickMisdeed(c: MisdeedContext, rng: Rng = Math.random): Misdeed | null {
  const options = MISDEEDS.map((m) => ({ m, w: m.weight(c) })).filter((o) => o.w > 0);
  if (options.length === 0) return null;
  const total = options.reduce((s, o) => s + o.w, 0);
  let roll = rng() * total;
  for (const o of options) {
    if (roll < o.w) return o.m;
    roll -= o.w;
  }
  return options[options.length - 1].m;
}

// ─── Effects ──────────────────────────────────────────────────────────────────

type AgentRow = typeof agents.$inferSelect;
const firstName = (a: { name: string }) => givenName(a.name);
const isAwake = (a: AgentRow) => (a.current_action as { type?: string } | null)?.type !== 'sleeping';

/** Once per game hour; returns how many new facts it created (tests). */
export function smallMisdeedsHourly(hour: number, rng: Rng = Math.random): number {
  const active = db.select().from(agents).where(eq(agents.is_active, true)).all();
  if (active.length < 2) return 0;
  const byId = new Map(active.map((a) => [a.id, a]));
  const locTypes = new Map(db.select({ id: locations.id, type: locations.type }).from(locations).all().map((l) => [l.id, l.type]));
  const money = new Map(db.select({ id: economy.agent_id, money: economy.money }).from(economy).all().map((e) => [e.id, e.money]));
  const statesByAgent = new Map<number, string[]>();
  for (const s of db.select({ agent: agentStates.agent_id, type: agentStates.type }).from(agentStates).all()) {
    (statesByAgent.get(s.agent) ?? statesByAgent.set(s.agent, []).get(s.agent)!).push(s.type);
  }
  const rels = db.select().from(relationships).all();
  const feel = (from: number, to: number) => {
    const r = rels.find((x) => x.agent_a === Math.min(from, to) && x.agent_b === Math.max(from, to));
    if (!r) return { friendship: 0, romance: 0, status: null as string | null };
    const isA = r.agent_a === from;
    return { friendship: isA ? r.friendship_ab : r.friendship_ba, romance: isA ? r.romance_ab : r.romance_ba, status: r.status };
  };

  let created = 0;
  for (const agent of active) {
    if (!isAwake(agent) || agent.current_location == null) continue;
    const personality = (agent.personality as PersonalityProfile | null) ?? null;
    if (rng() >= chancePerTick(misdeedChancePerMinute(personality), 60)) continue;

    const here = agent.current_location;
    const present = active.filter((o) => o.id !== agent.id && o.current_location === here && isAwake(o)).map((o) => o.id);
    const ctx: MisdeedContext = {
      hour,
      placeType: locTypes.get(here) ?? null,
      atWork: agent.workplace != null && here === agent.workplace,
      money: money.get(agent.id) ?? 0,
      states: statesByAgent.get(agent.id) ?? [],
      personality,
      present,
      crushHere: present.find((id) => { const f = feel(agent.id, id); return f.romance >= 25 && f.status !== 'partners'; }) ?? null,
      creditorHere: present.find((id) => (money.get(id) ?? 0) > 60) ?? null,
      friendHere: present.find((id) => feel(agent.id, id).friendship >= 30) ?? null,
    };
    const misdeed = pickMisdeed(ctx, rng);
    if (!misdeed) continue;

    const targetId = misdeed.target(ctx, rng);
    const target = targetId != null ? byId.get(targetId) ?? null : null;
    const detail = misdeed.details ? misdeed.details[Math.min(misdeed.details.length - 1, Math.floor(rng() * misdeed.details.length))] : undefined;

    // Who noticed: anyone else in the room, the curious likelier. The one lied to doesn't
    // see through it; the one being made eyes at might.
    const witnesses = present.filter((id) => {
      if (id === targetId && misdeed.type !== 'crush') return false;
      const curiosity = ((byId.get(id)?.personality as PersonalityProfile | null)?.curiosity) ?? 50;
      return rng() < noticeChance(curiosity);
    });
    const factId = createFact(
      misdeed.type, agent.id, targetId, misdeed.sensitivity, [agent.id, ...witnesses],
      witnesses.length > 0 ? 'witnessed' : 'self', detail ? { detail } : undefined,
    );
    if (factId == null) continue; // already a live secret of this kind
    created++;

    simEvents.emit('life:milestone', {
      agentId: agent.id,
      description: misdeed.memory(detail, target ? firstName(target) : null),
      valence: -0.3,
      importance: 4,
      ...(targetId != null ? { relatedAgentId: targetId } : {}),
    });
    if (witnesses.length === 0) continue;

    const content = db.select({ content: shared_knowledge.content }).from(shared_knowledge)
      .where(eq(shared_knowledge.id, factId)).get()?.content ?? '';
    for (const w of witnesses) {
      // `witnessed`: MemoryObserver words it "I saw it with my own eyes", not "their own eyes told me".
      simEvents.emit('gossip:learned', { agentId: w, sourceName: 'their own eyes', witnessed: true, content });
    }
    // The first witness makes the feed line; the rest just know.
    const seer = byId.get(witnesses[0])!;
    logActivity({
      type: 'drama',
      initiator: seer.id,
      target: agent.id,
      agents: [seer.id, agent.id, ...(targetId != null ? [targetId] : [])],
      location: here,
      templateData: { description: thatSentence(`${seer.name} noticed`, content, [getAgentSelf(seer.id)]) },
      metadata: { beat: 'misdeed' },
    });
  }
  return created;
}
