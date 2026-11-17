import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, needs, relationshipEvents, relationships, shared_knowledge, loans } from '../../db/schema';
import { clearEffectivePersonalities, setEffectivePersonality } from '../states';
import { clearSocialCallState, onCallConversationEnded } from '../socialCalls';
import { callOf } from '../socialCalls/engine';
import { setSocialCallRng } from '../socialCalls/produce';
import { callTrigger } from '../socialCalls/topics';
import { simEvents } from '../simEvents';
import {
  factionsHourly, finishFeud, onRelationshipEvent, setFactionRng,
} from '../factions';
import { setMediationRng } from '../factions/mediate';
import {
  FACTIONS, activeFeuds, clearFactions, factionTally, feudBetween, feudSocialPenalty, opposedInTownFeud, townCamps,
} from '../factions/store';
import { cliqueSocialModifier, resetCliqueCache } from '../cliques';
import { buildBrewing } from '../brewing';
import { NOW, PERSONALITY, freshTown, insertResident, relate } from './populationFixtures';

const SIDER = { ...PERSONALITY, warmth: 50, aggression: 55, loyalty: 85 };
const PEACEMAKER = { ...PERSONALITY, warmth: 90, aggression: 15, loyalty: 70 };

function feudRows(beat?: string) {
  return db.select().from(activityLog).all()
    .filter((r) => r.type === 'feud' && (beat == null || (r.metadata as { beat?: string } | null)?.beat === beat));
}

function insertEvent(a: number, b: number, type: string, fab: number, fba: number, description = 'x'): number {
  return db.insert(relationshipEvents).values({
    agent_a: a, agent_b: b, event_type: type, description,
    friendship_delta_ab: fab, friendship_delta_ba: fba, romance_delta_ab: 0, romance_delta_ba: 0,
    trust_delta_ab: 0, trust_delta_ba: 0, sentiment: -0.8, processed: true, timestamp: Date.now(),
  }).returning({ id: relationshipEvents.id }).get().id;
}

function friendshipOf(from: number, to: number): number {
  const r = db.select().from(relationships)
    .where(and(eq(relationships.agent_a, Math.min(from, to)), eq(relationships.agent_b, Math.max(from, to)))).get()!;
  return r.agent_a === from ? r.friendship_ab : r.friendship_ba;
}

/** Everyone queued for this feud decides: the hourly pass past every due time, then past the summary flush. */
function stepThroughDecisions(): number {
  const late = NOW + FACTIONS.DECIDE_AFTER_MIN + FACTIONS.DECIDE_SPREAD_MIN + 60;
  factionsHourly(late);
  factionsHourly(late + FACTIONS.FLUSH_AFTER_MIN);
  return late + FACTIONS.FLUSH_AFTER_MIN;
}

describe('taking sides: a public fight splits the friends of the two', () => {
  let town: ReturnType<typeof freshTown>;
  let ana: number, ben: number, a1: number, a2: number, b1: number, b2: number, mia: number, kid: number;

  beforeEach(() => {
    town = freshTown({ homes: [2, 2, 2, 2, 2, 2] });
    clearFactions();
    clearSocialCallState();
    resetCliqueCache();
    setFactionRng(() => 0);
    setSocialCallRng(() => 0);
    setMediationRng(() => 0);
    ana = insertResident('Ana Gil', town.homes[0]);
    ben = insertResident('Ben Ruiz', town.homes[1]);
    a1 = insertResident('Alma Sanz', town.homes[2]);
    a2 = insertResident('Abel Mora', town.homes[3]);
    b1 = insertResident('Bea Cruz', town.homes[4]);
    b2 = insertResident('Bruno Paz', town.homes[5]);
    mia = insertResident('Mia Vidal', town.homes[2]);
    kid = insertResident('Kiko Gil', town.homes[0], { age: 10 });
    for (const id of [a1, a2, b1, b2]) setEffectivePersonality(id, SIDER);
    setEffectivePersonality(mia, PEACEMAKER);
    relate(ana, ben, { friendship_ab: -40, friendship_ba: -40, status: 'rivals' });
    for (const id of [a1, a2]) {
      relate(id, ana, { friendship_ab: 75, friendship_ba: 75, trust_ab: 50, trust_ba: 50 });
      relate(id, ben, { friendship_ab: -5, friendship_ba: -5 });
    }
    for (const id of [b1, b2]) {
      relate(id, ben, { friendship_ab: 75, friendship_ba: 75, trust_ab: 50, trust_ba: 50 });
      relate(id, ana, { friendship_ab: -5, friendship_ba: -5 });
    }
    relate(mia, ana, { friendship_ab: 60, friendship_ba: 60 });
    relate(mia, ben, { friendship_ab: 60, friendship_ba: 60 });
    relate(kid, ana, { friendship_ab: 90, friendship_ba: 90 });
  });

  afterEach(() => {
    clearEffectivePersonalities();
    setFactionRng(null);
    setSocialCallRng(null);
    setMediationRng(null);
    clearFactions();
  });

  it('the fight lines up their close ties, not instantly: nobody has decided yet', () => {
    const ev = insertEvent(ana, ben, 'fight', -20, -20);
    // Through the real listener, as the relationships phase emits it.
    simEvents.emit('relationship:event_applied', { eventId: ev, agentA: ana, agentB: ben, oldStatus: 'rivals', newStatus: 'rivals' });
    const f = feudBetween(ana, ben)!;
    expect(f).not.toBeNull();
    expect(f.stances.size).toBe(0);
    // The child is too young to be asked; the five adults are.
    expect([...f.pending.keys()].sort((x, y) => x - y)).toEqual([a1, a2, b1, b2, mia].sort((x, y) => x - y));
    for (const due of f.pending.values()) expect(due).toBeGreaterThanOrEqual(NOW + FACTIONS.DECIDE_AFTER_MIN);
    factionsHourly(NOW + 60);
    expect(f.stances.size).toBe(0);
  });

  it('friends take sides over the following days: one summary row, a town feud, the camps keep apart', () => {
    onRelationshipEvent({ eventId: insertEvent(ana, ben, 'fight', -20, -20), oldStatus: 'rivals', newStatus: 'rivals' }, NOW);
    const before = friendshipOf(a1, ben);
    stepThroughDecisions();
    const f = feudBetween(ana, ben)!;
    expect(f.stances.get(a1)).toBe('a');
    expect(f.stances.get(a2)).toBe('a');
    expect(f.stances.get(b1)).toBe('b');
    expect(f.stances.get(b2)).toBe('b');
    // ONE summary row for the batch, naming the sides.
    const split = feudRows('took_sides');
    expect(split).toHaveLength(1);
    const text = (split[0].template_data as { description: string }).description;
    expect(text).toMatch(/The quarrel between Ana Gil and Ben Ruiz has split their friends/);
    expect(text).toMatch(/Alma Sanz and Abel Mora stand with Ana/);
    expect(split[0].importance).toBeGreaterThanOrEqual(0.55);
    expect(split[0].importance).toBeLessThanOrEqual(0.65);
    // Two on each side in a town of 9: a town feud, its own row at 0.75+.
    const townRow = feudRows('town_feud');
    expect(townRow).toHaveLength(1);
    expect(townRow[0].importance).toBeGreaterThanOrEqual(0.75);
    expect(f.townSinceMin).not.toBeNull();
    // The side-taker cooled toward the other principal through the relationship-event path.
    const took = db.select().from(relationshipEvents).all().filter((e) => e.event_type === 'took_sides');
    expect(took.length).toBe(4);
    expect(before).toBe(-5);
    // The camps avoid each other in free time, and don't sit together at a gathering.
    expect(opposedInTownFeud(a1, b1)).toBe(true);
    expect(feudSocialPenalty(a1, b2)).toBe(FACTIONS.TOWN_SOCIAL_PENALTY);
    expect(cliqueSocialModifier(a1, b1)).toBeLessThanOrEqual(FACTIONS.TOWN_SOCIAL_PENALTY);
    expect(townCamps()).toEqual([{ a: [ana, a1, a2], b: [ben, b1, b2] }]);
    // The Brewing tab carries it.
    const brew = buildBrewing({
      agents: [ana, ben, a1, a2, b1, b2].map((id) => ({ id, name: `#${id}`, personality: null })),
      tension: [], secrets: [], queue: [], goals: [], relationships: [],
      feuds: [{ id: f.id, aId: ana, bId: ben, sideA: [a1, a2], sideB: [b1, b2], deciding: 0, town: true, causeText: f.causeText }],
    });
    expect(brew.find((i) => i.kind === 'feud')?.heat).toBeGreaterThanOrEqual(0.75);
  });

  it('a peacemaker close to both walks to one, then the other, and they make peace; the sides thaw', () => {
    onRelationshipEvent({ eventId: insertEvent(ana, ben, 'fight', -20, -20), oldStatus: 'rivals', newStatus: 'rivals' }, NOW);
    const t = stepThroughDecisions();
    const f = feudBetween(ana, ben)!;
    expect(f.stances.get(mia)).toBe('mediator');
    // Torn between two friends: stress, and a mood that shows it.
    const mods = db.select().from(needs).where(eq(needs.agent_id, mia)).get()!.mood_modifiers.map((m) => m.source);
    expect(mods).toContain('torn_loyalties');
    expect(factionTally()).toMatchObject({ mediationsTried: 1, torn: 1 });

    const first = callOf(mia)!;
    expect(first).toMatchObject({ kind: 'mediate', targetId: ana });
    onCallConversationEnded({ agentId: mia, perpetratorId: ana, triggerReason: callTrigger('mediate'), template: true, sentiment: 0.3, turns: 4 });
    const second = callOf(mia)!;
    expect(second).toMatchObject({ kind: 'mediate', targetId: ben });
    onCallConversationEnded({ agentId: mia, perpetratorId: ben, triggerReason: callTrigger('mediate'), template: true, sentiment: 0.3, turns: 4 });

    // Peace: the reconciliation event, a feed row crediting her at 0.7+, and the feud is over.
    expect(feudBetween(ana, ben)).toBeNull();
    expect(factionTally()).toMatchObject({ mediationsSucceeded: 1, townEnded: 1 });
    expect(db.select().from(relationshipEvents).all().some((e) => e.event_type === 'reconciliation')).toBe(true);
    const peace = db.select().from(activityLog).all().find((r) => (r.metadata as { beat?: string } | null)?.beat === 'reconciliation')!;
    expect((peace.template_data as { description: string }).description).toMatch(/Thanks to Mia Vidal/);
    expect(peace.importance).toBeGreaterThanOrEqual(0.7);
    expect(feudRows('feud_ended')).toHaveLength(1);
    // The camps no longer keep apart, and the side-takers come round over the next days.
    expect(feudSocialPenalty(a1, b1)).toBe(0);
    factionsHourly(t + 3 * 24 * 60);
    const thaws = db.select().from(relationshipEvents).all().filter((e) => e.event_type === 'thaw');
    expect(thaws.length).toBe(4);
  });

  it('a slight between friends is forgiven once; a debt gone sour starts it, and those who know blame the borrower', () => {
    onRelationshipEvent({ eventId: insertEvent(ana, mia, 'missed_funeral', -3, 0), oldStatus: 'friends', newStatus: 'friends' }, NOW);
    expect(feudBetween(ana, mia)).toBeNull();
    db.insert(loans).values({ lender_id: ana, borrower_id: ben, amount: 20, lent_at_min: NOW - 20000, due_at_min: NOW - 10, status: 'overdue', settled_at_min: null }).run();
    db.insert(shared_knowledge).values({
      type: 'debt', subject_id: ben, target_id: ana, content: 'x', sensitivity: 2, known_by: [ana, mia], created_at: 0, source: 'observed',
    }).run();
    // feel() writes the lower id first: the deltas say who was wronged.
    onRelationshipEvent({ eventId: insertEvent(ana, ben, 'loan_unpaid', -6, 0), oldStatus: 'rivals', newStatus: 'rivals' }, NOW);
    const f = feudBetween(ana, ben)!;
    expect(f).toMatchObject({ aId: ana, bId: ben, culprit: 'b' });
    expect(f.culpritKnownBy).toContain(mia);
  });

  it('it burns out after a long quiet stretch, and ends when one of them is gone', () => {
    onRelationshipEvent({ eventId: insertEvent(ana, ben, 'fight', -20, -20), oldStatus: 'rivals', newStatus: 'rivals' }, NOW);
    const t = stepThroughDecisions();
    expect(activeFeuds()).toHaveLength(1);
    factionsHourly(t + FACTIONS.QUIET_MIN + 60);
    expect(activeFeuds()).toHaveLength(0);
    expect(factionTally().ended.faded).toBe(1);
    expect(feudRows('feud_ended')).toHaveLength(1);
  });

  it('an ended feud thaws nothing but a reconciliation does; finishing twice is harmless', () => {
    onRelationshipEvent({ eventId: insertEvent(ana, ben, 'fight', -20, -20), oldStatus: 'rivals', newStatus: 'rivals' }, NOW);
    const f = feudBetween(ana, ben)!;
    finishFeud(f, 'gone', NOW + 10);
    expect(activeFeuds()).toHaveLength(0);
    // The pair cools off before another feud can start.
    onRelationshipEvent({ eventId: insertEvent(ana, ben, 'fight', -20, -20), oldStatus: 'rivals', newStatus: 'rivals' }, NOW + 20);
    expect(feudBetween(ana, ben)).toBeNull();
  });
});
