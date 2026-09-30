import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import { agentStates, agents, locations, relationships } from '../../../db/schema';
import { registerReactionListeners } from '../reactions';
import { clearIntimacy } from '../state';
import { simEvents } from '../../simEvents';
import { MARRIED_TAG } from '../../marriage';

/**
 * What seeing it does to whoever sees. A kiss or a walk home at dawn is not only a `kiss_seen` /
 * `tryst_seen` secret: the witness remembers it (how much depends on whom they love), a partner
 * of one of the two is heartbroken on the spot and somebody with a crush is jealous
 * (the same states the affair-discovery and gift-jealousy paths give). Only adults are ever
 * witnesses (witnesses.ts); nothing here narrates more than what was seen.
 */

let homeId: number;
const made: number[] = [];

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'bi',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 50,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  return id;
}

function relate(x: number, y: number, over: Partial<typeof relationships.$inferInsert> = {}): void {
  db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y),
    friendship_ab: 50, friendship_ba: 50, romance_ab: 0, romance_ba: 0, trust_ab: 50, trust_ba: 50,
    familiarity: 50, interaction_count: 5, last_interaction: 0, average_interaction_sentiment: 0,
    tags: [], status: 'friends', created_at: 0, last_updated: 0, ...over,
  }).run();
}

/** `from` feels `romance` toward `to` (the row is stored lower id first; `to` feels nothing back). */
function torch(from: number, to: number, romance: number): void {
  relate(from, to, { status: 'friends', ...(from < to ? { romance_ab: romance } : { romance_ba: romance }) });
}

interface Memory { agentId: number; description: string; valence: number; importance: number; relatedAgentId?: number }
interface Jealousy { agentId: number; loveInterestId: number; rivalId: number; trigger: string }

/** Run `fn` and collect the milestone memories, the states it triggered and the jealousy events. */
function watch(fn: () => void) {
  const memories: Memory[] = [];
  const triggered: Array<{ agentId: number; state: string }> = [];
  const jealous: Jealousy[] = [];
  const onMemory = (p: Memory) => memories.push(p);
  const onState = (p: { agentId: number; state: string }) => triggered.push({ agentId: p.agentId, state: p.state });
  const onJealous = (p: Jealousy) => jealous.push(p);
  simEvents.on('life:milestone', onMemory);
  simEvents.on('state:triggered', onState);
  simEvents.on('jealousy:triggered', onJealous);
  try { fn(); } finally {
    simEvents.off('life:milestone', onMemory);
    simEvents.off('state:triggered', onState);
    simEvents.off('jealousy:triggered', onJealous);
  }
  return { memories, triggered, jealous };
}

const nameOf = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!.name;
const statesOf = (id: number) => db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all();
const kiss = (a: number, b: number, witnessIds: number[], first = false) => simEvents.emit('intimacy:kiss', { a, b, first, witnessIds });
const caught = (subject: number, other: number, witnessId: number, scene?: string) =>
  simEvents.emit('intimacy:caught', { a: subject, b: other, witnessId, ...(scene ? { scene } : {}) });

describe('witnessing intimacy', () => {
  beforeAll(() => {
    registerReactionListeners();
    homeId = db.insert(locations).values({
      name: 'Reaction Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });

  beforeEach(() => {
    clearIntimacy();
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  afterAll(() => {
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
    clearIntimacy();
  });

  const cast = () => ({
    a: insertAgent(`Ada ${made.length}`), b: insertAgent(`Bruno ${made.length}`, { gender: 'male' }),
    w: insertAgent(`Witness ${made.length}`),
  });

  it('a stranger who saw a kiss remembers it, and nothing more happens to them', () => {
    const { a, b, w } = cast();
    const r = watch(() => kiss(a, b, [w]));
    const mine = r.memories.filter((m) => m.agentId === w);
    expect(mine).toHaveLength(1);
    expect(mine[0].description).toBe(`I saw ${nameOf(a)} kissing ${nameOf(b)}.`);
    expect(mine[0]).toMatchObject({ importance: 4, relatedAgentId: a });
    expect(mine[0].valence).toBeCloseTo(0.1);
    expect(statesOf(w)).toEqual([]);
    expect(r.triggered).toEqual([]);
    // Nobody but the witness is given a memory of having been watched.
    expect(r.memories.filter((m) => m.agentId !== w)).toEqual([]);
  });

  it('a partner who sees it is heartbroken on the spot, about the one they are with, and remembers it hard', () => {
    const { a, b, w } = cast();
    // w is Ada's partner; Bruno is the other one.
    relate(w, a, { status: 'partners', tags: ['partner'], romance_ab: 80, romance_ba: 80 });
    const r = watch(() => kiss(a, b, [w]));

    const heart = statesOf(w).filter((s) => s.type === 'heartbroken');
    expect(heart).toHaveLength(1);
    expect(heart[0]).toMatchObject({ target_agent_id: a, source: 'intimacy:witnessed' });
    expect(heart[0].duration).toBe(2 * 1440);
    expect(r.triggered).toEqual([{ agentId: w, state: 'heartbroken' }]);
    const mem = r.memories.find((m) => m.agentId === w)!;
    expect(mem).toMatchObject({ importance: 9, relatedAgentId: a });
    expect(mem.valence).toBeLessThan(-0.5);
    expect(mem.description).toMatch(/^I saw .* kissing .*\./);
  });

  it('a husband or fiance counts the same, and an existing heartbreak is not stacked', () => {
    const { a, b, w } = cast();
    relate(w, b, { status: 'partners', tags: ['partner', MARRIED_TAG], romance_ab: 80, romance_ba: 80 });
    db.insert(agentStates).values({
      agent_id: w, type: 'heartbroken', severity: 0.5, started_at: 0, duration: 999, source: 'test', metadata: null,
    }).run();
    const r = watch(() => kiss(a, b, [w]));
    expect(statesOf(w).filter((s) => s.type === 'heartbroken')).toHaveLength(1);
    expect(r.triggered).toEqual([]);
    // ... but the memory is still the hard one, about their spouse (Bruno).
    expect(r.memories.find((m) => m.agentId === w)).toMatchObject({ importance: 9, relatedAgentId: b });
  });

  it("somebody with a crush on one of them is jealous, with the giftEngine's states and event", () => {
    const { a, b, w } = cast();
    torch(w, b, 60);
    const r = watch(() => kiss(a, b, [w]));
    const jealous = statesOf(w).filter((s) => s.type === 'jealous');
    expect(jealous).toHaveLength(1);
    expect(jealous[0]).toMatchObject({ target_agent_id: b, source: 'kiss_witnessed' });
    expect(jealous[0].metadata).toMatchObject({ rivalId: a, loveInterestId: b });
    expect(r.jealous).toEqual([{ agentId: w, loveInterestId: b, rivalId: a, trigger: 'kiss_witnessed' }]);
    expect(r.memories.find((m) => m.agentId === w)).toMatchObject({ importance: 6, relatedAgentId: b });
  });

  it('a faint liking is not a torch', () => {
    const { a, b, w } = cast();
    torch(w, b, 15);
    const r = watch(() => kiss(a, b, [w]));
    expect(statesOf(w)).toEqual([]);
    expect(r.jealous).toEqual([]);
  });

  it("an open couple kissing is nobody's news: no memory, no state", () => {
    const { a, b, w } = cast();
    relate(a, b, { status: 'partners', tags: ['partner'], romance_ab: 80, romance_ba: 80 });
    torch(w, b, 60);
    const r = watch(() => kiss(a, b, [w]));
    expect(r.memories).toEqual([]);
    expect(statesOf(w)).toEqual([]);
  });

  describe('being caught', () => {
    it('at dawn: the witness remembers what they saw, and the two remember being seen', () => {
      const { a, b, w } = cast();
      const r = watch(() => caught(a, b, w, 'dawn'));
      const byAgent = (id: number) => r.memories.filter((m) => m.agentId === id);
      expect(byAgent(w)).toEqual([expect.objectContaining({
        description: `I saw ${nameOf(a)} slipping out of ${nameOf(b)}'s house at dawn.`, importance: 6, relatedAgentId: a,
      })]);
      expect(byAgent(a)).toEqual([expect.objectContaining({
        description: `${nameOf(w)} saw me leaving ${nameOf(b)}'s house at dawn. It will be all over town.`, importance: 7, relatedAgentId: w,
      })]);
      expect(byAgent(b)).toEqual([expect.objectContaining({
        description: `${nameOf(w)} saw ${nameOf(a)} leaving my house at dawn.`, importance: 6, relatedAgentId: w,
      })]);
    });

    it('outdoors: the same, worded for a barn or a grove after dark', () => {
      const { a, b, w } = cast();
      const r = watch(() => caught(a, b, w, 'outdoors'));
      expect(r.memories.find((m) => m.agentId === w)!.description).toMatch(/slipping away together after dark\.$/);
      expect(r.memories.filter((m) => m.agentId === a)).toHaveLength(1);
    });

    it("walked in on: the witness remembers; the two already have the interrupted evening's memory", () => {
      const { a, b, w } = cast();
      const r = watch(() => caught(a, b, w, 'found'));
      expect(r.memories.map((m) => m.agentId)).toEqual([w]);
      expect(r.memories[0].description).toMatch(/^I found .* and .* alone together late in the evening\.$/);
    });

    it('a spouse who saw is heartbroken about their husband, whoever the lover is', () => {
      const { a, b, w } = cast();
      relate(w, a, { status: 'partners', tags: ['partner', MARRIED_TAG], romance_ab: 80, romance_ba: 80 });
      const r = watch(() => caught(a, b, w, 'dawn'));
      expect(statesOf(w).filter((s) => s.type === 'heartbroken')).toEqual([expect.objectContaining({ target_agent_id: a })]);
      expect(r.memories.find((m) => m.agentId === w)).toMatchObject({ importance: 9, relatedAgentId: a });
    });

    it('an event from before `scene` existed still reads as the dawn walk', () => {
      const { a, b, w } = cast();
      const r = watch(() => caught(a, b, w));
      expect(r.memories.find((m) => m.agentId === w)!.description).toMatch(/at dawn\.$/);
    });
  });

  it('never says more than it saw', () => {
    const { a, b, w } = cast();
    relate(w, a, { status: 'partners', tags: ['partner'], romance_ab: 80, romance_ba: 80 });
    const all = watch(() => { kiss(a, b, [w]); caught(a, b, w, 'dawn'); caught(a, b, w, 'outdoors'); caught(a, b, w, 'found'); });
    for (const m of all.memories) expect(m.description, m.description).not.toMatch(/naked|undress|bed\b|sex|lust|pleasure/i);
  });
});
