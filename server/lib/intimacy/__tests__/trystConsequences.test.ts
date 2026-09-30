import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  agentStates, agents, locations, needs, relationshipEvents, relationships, shared_knowledge, worldState,
} from '../../../db/schema';
import { AFTERGLOW_MINUTES, GUILTY_MINUTES, LOVERS_TAG, LONGING_AFTER_NIGHT } from '../aftermath';
import { beginTryst, trystPass } from '../tryst';
import { kissSeenSensitivity } from '../kiss';
import { clearIntimacy, ensureAgentIntimacy, getAgentIntimacy, getPairIntimacy, updatePairIntimacy } from '../state';
import { MARRIED_TAG } from '../../marriage';
import { setRuleOverrides } from '../../worldRules';
import { gameMinutes } from '../../gameClock';
import { simEvents } from '../../simEvents';

/**
 * What a night leaves behind (aftermath.ts): tag, relationship events, longing,
 * afterglow and memories; the affair born from the act and the guilt of those with
 * a conscience; an interrupted evening leaving embarrassment and nothing else.
 * Nothing narrates the evening itself: what is pinned is the bookkeeping.
 */

const TIME = { day: 40, hour: 20, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
const DAY = 24 * 60;
const at = (minutes: number) => {
  const total = NOW + minutes;
  const rem = total % DAY;
  return { ...TIME, day: Math.floor(total / DAY), hour: Math.floor(rem / 60), minute: rem % 60 };
};

const madeAgents: number[] = [];
const madeLocations: number[] = [];

function setClock(): void {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time: TIME, weather: 'sunny', tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time: TIME, day_phase: 'evening', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertLocation(name: string, type: string, x = 0): number {
  const id = db.insert(locations).values({
    name, type, position: { x, y: 0, width: 96, height: 96 }, entry_point: { x, y: 96 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  madeLocations.push(id);
  return id;
}

function insertAgent(name: string, home: number, over: Partial<typeof agents.$inferInsert> = {}, morality = 60): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, current_location: home, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  madeAgents.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const locOf = (id: number) => db.select().from(locations).where(eq(locations.id, id)).get()!;
const statesOf = (id: number) => db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all();
const moodSources = (id: number) => db.select().from(needs).where(eq(needs.agent_id, id)).get()!.mood_modifiers.map((m) => m.source);

function relate(x: number, y: number, tags: string[] = [], status = 'partners'): number {
  return db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 70, friendship_ba: 70,
    romance_ab: 80, romance_ba: 80, trust_ab: 70, trust_ba: 70, familiarity: 80, interaction_count: 40,
    last_interaction: 0, average_interaction_sentiment: 0.5, tags, status, created_at: 0, last_updated: 0,
  }).returning({ id: relationships.id }).get().id;
}

/** A woman (`a`) at her home with a man (`b`) beside her; he lives elsewhere and will be the guest. */
function lovers(over: { aOver?: Partial<typeof agents.$inferInsert>; bOver?: Partial<typeof agents.$inferInsert>; bMorality?: number; aMorality?: number } = {}) {
  const aHome = insertLocation(`Cottage ${madeLocations.length}`, 'home', 200);
  const bHome = insertLocation(`Farmhouse ${madeLocations.length}`, 'home', 400);
  const a = insertAgent(`Lover ${madeAgents.length}`, aHome, { gender: 'female', ...over.aOver }, over.aMorality);
  const b = insertAgent(`Beloved ${madeAgents.length}`, bHome, { gender: 'male', current_location: aHome, ...over.bOver }, over.bMorality);
  return { a, b, aHome, bHome };
}

/** Begin the evening and let its time run out. Returns the milestone memories written. */
function nightTogether(a: number, b: number, venue: number, offset = 0): Array<{ agentId: number; description: string; importance: number }> {
  const seen: Array<{ agentId: number; description: string; importance: number }> = [];
  const fn = (p: { agentId: number; description: string; importance: number }) => { seen.push(p); };
  simEvents.on('life:milestone', fn);
  try {
    expect(beginTryst(load(a), load(b), locOf(venue), at(offset), () => 0)).toBe(true);
    trystPass(at(offset + 60), () => 0);
  } finally { simEvents.off('life:milestone', fn); }
  return seen;
}

const eventsOf = (x: number, y: number) => db.select().from(relationshipEvents)
  .where(and(eq(relationshipEvents.agent_a, Math.min(x, y)), eq(relationshipEvents.agent_b, Math.max(x, y)))).all();

describe('what a night leaves behind', () => {
  beforeAll(() => {
    setClock();
    setRuleOverrides({ adultContent: true });
  });

  beforeEach(() => {
    // A night between a man and an unmarried woman rolls for a baby (pregnancy.ts, Math.random):
    // pinned to "no", so these tests are about the morning after and never about a stray pregnancy.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    clearIntimacy();
    setRuleOverrides({ adultContent: true });
    setClock();
    if (madeAgents.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, madeAgents)).run();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, madeAgents), inArray(shared_knowledge.target_id, madeAgents))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, madeAgents), inArray(relationshipEvents.agent_b, madeAgents))).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, madeAgents)).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, madeAgents), inArray(relationships.agent_b, madeAgents))).run();
    db.delete(needs).where(inArray(needs.agent_id, madeAgents)).run();
    db.delete(agents).where(inArray(agents.id, madeAgents)).run();
    db.delete(locations).where(inArray(locations.id, madeLocations)).run();
    clearIntimacy();
  });

  describe('the first night', () => {
    it('tags them lovers, writes the pivotal event, eases longing, and leaves both glowing toward each other', () => {
      const { a, b, aHome } = lovers();
      const relId = relate(a, b, ['kissed']);
      ensureAgentIntimacy(a).longing = 80;
      ensureAgentIntimacy(b).longing = 6;

      const memories = nightTogether(a, b, aHome);

      const rel = db.select().from(relationships).where(eq(relationships.id, relId)).get()!;
      expect(rel.tags).toEqual(['kissed', LOVERS_TAG]);

      const events = eventsOf(a, b);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'first_tryst', romance_delta_ab: 5, romance_delta_ba: 5, trust_delta_ab: 3, trust_delta_ba: 3,
      });

      // Down to a little, never raised.
      expect(getAgentIntimacy(a)!.longing).toBe(LONGING_AFTER_NIGHT);
      expect(getAgentIntimacy(b)!.longing).toBe(6);

      for (const [me, other] of [[a, b], [b, a]] as const) {
        const glow = statesOf(me).filter((s) => s.type === 'afterglow');
        expect(glow).toHaveLength(1);
        expect(glow[0]).toMatchObject({ target_agent_id: other, duration: AFTERGLOW_MINUTES, started_at: NOW + 60 });
        expect(moodSources(me)).toContain('afterglow');
      }

      // A memory each, discreet and high.
      expect(memories).toHaveLength(2);
      expect(memories.find((m) => m.agentId === a)).toMatchObject({ description: `I spent the night with ${load(b).name}.`, importance: 9 });
      expect(memories.find((m) => m.agentId === b)).toMatchObject({ description: `I spent the night with ${load(a).name}.`, importance: 9 });
    });

    it('does not tag a pair that has no relationship row (nothing to tag), and still does the rest', () => {
      const { a, b, aHome } = lovers();
      nightTogether(a, b, aHome);
      expect(eventsOf(a, b)[0].event_type).toBe('first_tryst');
      expect(statesOf(a).map((s) => s.type)).toContain('afterglow');
    });
  });

  describe('later nights', () => {
    it('are a routine `tryst` event, a plainer and lower memory, and the tag stays once', () => {
      const { a, b, aHome } = lovers();
      const relId = relate(a, b, ['kissed']);
      nightTogether(a, b, aHome);
      // The stay and the pair's hold-back are not what is under test: a day later, again.
      updatePairIntimacy(a, b, (p) => { delete p.rendezvousRetryAfter; });
      const memories = nightTogether(a, b, aHome, 24 * 60);

      const events = eventsOf(a, b);
      expect(events.map((e) => e.event_type)).toEqual(['first_tryst', 'tryst']);
      expect(events[1]).toMatchObject({ romance_delta_ab: 2, romance_delta_ba: 2, trust_delta_ab: 1, trust_delta_ba: 1 });
      const rel = db.select().from(relationships).where(eq(relationships.id, relId)).get()!;
      expect(rel.tags.filter((t) => t === LOVERS_TAG)).toHaveLength(1);

      expect(memories).toHaveLength(2);
      for (const m of memories) {
        expect(m.description).toMatch(/^Another evening with /);
        expect(m.importance).toBeLessThan(9);
      }
      // One afterglow each, refreshed, not stacked.
      expect(statesOf(a).filter((s) => s.type === 'afterglow')).toHaveLength(1);
    });
  });

  describe('an interrupted evening', () => {
    it('leaves embarrassment and nothing else: no afterglow, no tag, no event, and it was not their first', () => {
      const { a, b, aHome } = lovers();
      const relId = relate(a, b, ['kissed']);
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      // A housemate, awake, turns up.
      insertAgent(`Housemate ${madeAgents.length}`, aHome, { gender: 'male' });
      trystPass(at(10), () => 0);

      expect(getPairIntimacy(a, b)!.activeTryst).toBeUndefined();
      for (const id of [a, b]) {
        expect(statesOf(id).map((s) => s.type)).not.toContain('afterglow');
        expect(moodSources(id)).toContain('tryst_interrupted');
        expect(moodSources(id)).not.toContain('afterglow');
      }
      expect(db.select().from(relationships).where(eq(relationships.id, relId)).get()!.tags).toEqual(['kissed']);
      expect(eventsOf(a, b)).toHaveLength(0);
      // The night that never was does not count: the next real one is still the first.
      expect(getPairIntimacy(a, b)!.trysts).toBe(0);
      expect(getPairIntimacy(a, b)!.firstTrystAt).toBeUndefined();
    });
  });

  describe('a betrayal', () => {
    /** `a` is married to `c` (who lives with her), and spends the evening with `b`. */
    function affair(over: { aMorality?: number; bMorality?: number } = {}) {
      const l = lovers({ aMorality: over.aMorality, bMorality: over.bMorality });
      // The spouse is not home tonight (or the evening would be walked in on).
      const c = insertAgent(`Spouse ${madeAgents.length}`, l.aHome, { gender: 'male', current_location: null });
      relate(l.a, c, [MARRIED_TAG]);
      return { ...l, c };
    }

    it('is born from the act: an affair fact the two know, sensitivity 4 for a marriage', () => {
      const { a, b, c, aHome } = affair();
      nightTogether(a, b, aHome);
      const facts = db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'affair')).all()
        .filter((f) => f.subject_id === a && f.target_id === b);
      expect(facts).toHaveLength(1);
      expect(facts[0].sensitivity).toBe(4);
      expect((facts[0].known_by as number[]).sort()).toEqual([a, b].sort());
      expect(facts[0].known_by).not.toContain(c);
    });

    it('a second night adds no second fact', () => {
      const { a, b, aHome } = affair();
      nightTogether(a, b, aHome);
      updatePairIntimacy(a, b, (p) => { delete p.rendezvousRetryAfter; });
      nightTogether(a, b, aHome, 24 * 60);
      expect(db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'affair')).all()
        .filter((f) => f.subject_id === a && f.target_id === b)).toHaveLength(1);
    });

    it('someone with a conscience (morality > 60) is guilty toward the spouse for a day; someone without is not', () => {
      const { a, b, c, aHome } = affair({ aMorality: 85 });
      nightTogether(a, b, aHome);
      const guilty = statesOf(a).filter((s) => s.type === 'guilty');
      expect(guilty).toHaveLength(1);
      expect(guilty[0]).toMatchObject({ target_agent_id: c, duration: GUILTY_MINUTES });
      // The unattached lover has no one to betray.
      expect(statesOf(b).map((s) => s.type)).not.toContain('guilty');

      const cold = affair({ aMorality: 60 });
      nightTogether(cold.a, cold.b, cold.aHome);
      expect(statesOf(cold.a).map((s) => s.type)).not.toContain('guilty');
    });

    it('two people who are simply together, or both single, make no affair and no guilt', () => {
      const { a, b, aHome } = lovers({ aMorality: 95, bMorality: 95 });
      nightTogether(a, b, aHome);
      expect(db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'affair')).all()
        .filter((f) => f.subject_id === a || f.target_id === a)).toHaveLength(0);
      expect(statesOf(a).map((s) => s.type)).not.toContain('guilty');
    });
  });

  describe('the rule and the age line', () => {
    it('nothing is left behind when the pair stops being eligible before the evening ends', () => {
      const { a, b, aHome } = lovers();
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      db.update(agents).set({ age: 16 }).where(eq(agents.id, b)).run();
      trystPass(at(60), () => 0);
      expect(eventsOf(a, b)).toHaveLength(0);
      expect(statesOf(a)).toHaveLength(0);
    });

    it('a minor can never be brought to a tryst at all, so nothing here can run for one', () => {
      const { a, b, aHome } = lovers({ bOver: { age: 17 } });
      expect(beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0)).toBe(false);
      expect(getPairIntimacy(a, b)?.activeTryst).toBeUndefined();
      trystPass(at(60), () => 0);
      expect(eventsOf(a, b)).toHaveLength(0);
      expect(statesOf(b)).toHaveLength(0);
    });
  });


  describe('a love the 1900 town hides', () => {
    it('a same-sex pair\'s kiss_seen secret weighs one more, capped at 4', () => {
      const home = insertLocation(`Hidden ${madeLocations.length}`, 'home');
      const w1 = insertAgent(`Ada ${madeAgents.length}`, home, { gender: 'female' });
      const w2 = insertAgent(`Bea ${madeAgents.length}`, home, { gender: 'female' });
      const m1 = insertAgent(`Carl ${madeAgents.length}`, home, { gender: 'male' });
      // No engagement or marriage: base 2 for a mixed pair, 3 for the hidden one.
      expect(kissSeenSensitivity(w1, m1)).toBe(2);
      expect(kissSeenSensitivity(w1, w2)).toBe(3);
      // Somebody married elsewhere is already 4 (3, then the marriage step): the bump stops there.
      const spouse = insertAgent(`Dan ${madeAgents.length}`, home, { gender: 'male' });
      relate(w2, spouse, [MARRIED_TAG]);
      expect(kissSeenSensitivity(w1, w2)).toBe(4);
    });
  });
});
