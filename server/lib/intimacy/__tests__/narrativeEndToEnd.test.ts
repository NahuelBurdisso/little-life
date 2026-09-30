import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';

vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed (test: LLM disabled)'); });

import { db } from '../../../db';
import {
  activityLog, agentStates, agents, goals, locations, needs, relationshipEvents, relationships, shared_knowledge, worldState,
} from '../../../db/schema';
import { goalsTick } from '../../../engine/systems/goals';
import { detectStoryArcs, resetChronicleCache } from '../../chronicle';
import { arcsForPaper, gatherMaterial } from '../../gazette';
import { buildRecap, type RecapRow } from '../../recap';
import { gameMinutes } from '../../gameClock';
import { MARRIED_TAG } from '../../marriage';
import { simEvents } from '../../simEvents';
import { setRuleOverrides } from '../../worldRules';
import { registerKissListener } from '../kiss';
import { registerReactionListeners } from '../reactions';
import { clearIntimacy } from '../state';
import { beginTryst, startSneakHome, trystPass } from '../tryst';

/**
 * The audit's end-to-end check (Task 25): one affair, from the night to the discovery, read through
 * every story layer on the real DB. While nobody but the two knows, the player's Stories tab has the
 * triangle and the Town Crier has nothing (not the row, not the arc); once two people beyond them
 * know, the paper may print it (discreetly, the prompt sees to that), the recap carries it, the wife
 * who saw it is heartbroken with a weight-9 memory and a revenge goal aimed at her husband.
 */

const TIME = { day: 40, hour: 20, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
const DAY = 24 * 60;
const at = (minutes: number) => {
  const total = NOW + minutes;
  const rem = total % DAY;
  return { ...TIME, day: Math.floor(total / DAY), hour: Math.floor(rem / 60), minute: rem % 60, totalTicks: total };
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

function insertLocation(name: string, x: number): number {
  const id = db.insert(locations).values({
    name, type: 'home', position: { x, y: 0, width: 96, height: 96 }, entry_point: { x, y: 96 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  madeLocations.push(id);
  return id;
}

function insertAgent(name: string, home: number, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
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

function relate(x: number, y: number, tags: string[], status = 'partners'): void {
  db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 70, friendship_ba: 70,
    romance_ab: 80, romance_ba: 80, trust_ab: 70, trust_ba: 70, familiarity: 80, interaction_count: 40,
    last_interaction: 0, average_interaction_sentiment: 0.5, tags, status, created_at: 0, last_updated: 0,
  }).run();
}

const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const locOf = (id: number) => db.select().from(locations).where(eq(locations.id, id)).get()!;

describe('one affair through every story layer', () => {
  beforeAll(() => {
    registerKissListener();
    registerReactionListeners();
    setClock();
    setRuleOverrides({ adultContent: true });
  });

  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    clearIntimacy();
    resetChronicleCache();
    setRuleOverrides({ adultContent: true });
    setClock();
    if (madeAgents.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, madeAgents)).run();
    db.delete(activityLog).run();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    setRuleOverrides({ adultContent: false });
    db.delete(goals).where(inArray(goals.agent_id, madeAgents)).run();
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, madeAgents), inArray(shared_knowledge.target_id, madeAgents))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, madeAgents), inArray(relationshipEvents.agent_b, madeAgents))).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, madeAgents)).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, madeAgents), inArray(relationships.agent_b, madeAgents))).run();
    db.delete(needs).where(inArray(needs.agent_id, madeAgents)).run();
    db.delete(activityLog).run();
    db.delete(agents).where(inArray(agents.id, madeAgents)).run();
    db.delete(locations).where(inArray(locations.id, madeLocations)).run();
    clearIntimacy();
    resetChronicleCache();
  });

  it('is invisible to the paper while secret, printed and recapped once it is out, and costs the wife her peace', () => {
    // The host (a widow-to-be, single) and the husband (guest, married to the wife, who lives in his house).
    const hostHome = insertLocation('Widow Rows', 200);
    const marriedHome = insertLocation('Married Farm', 400);
    const lover = insertAgent('Lena Host', hostHome, { gender: 'female' });
    const husband = insertAgent('Hugo Guest', marriedHome, { gender: 'male', current_location: hostHome });
    const wife = insertAgent('Wanda Wife', marriedHome, { gender: 'female' });
    const snoop = insertAgent('Sven Snoop', insertLocation('Snoop Cottage', 700), { gender: 'male' });
    relate(husband, wife, ['partner', MARRIED_TAG]);
    relate(lover, husband, ['kissed']);
    // The wife and the neighbour are asleep at their own homes for the evening.
    db.update(agents).set({ current_action: { type: 'sleeping' } }).where(inArray(agents.id, [wife, snoop])).run();

    // ── The night ──
    expect(beginTryst(load(lover), load(husband), locOf(hostHome), at(0), () => 0)).toBe(true);
    trystPass(at(60), () => 0);

    // The player's tab has the triangle, marked secret; the paper has nothing to print about it.
    resetChronicleCache();
    const triangle = detectStoryArcs().find((a) => a.kind === 'love_triangle' && a.participants.includes(lover));
    expect(triangle).toBeDefined();
    expect(triangle!.secret).toBe(true);
    expect(triangle!.summary).toBe('Lena Host and Hugo Guest are involved, though Hugo Guest is with Wanda Wife.');
    expect(arcsForPaper(detectStoryArcs())).toEqual([]);
    expect(gatherMaterial(0)).toMatchObject({ items: [], events: [], arcs: [] });
    const rows = () => db.select().from(activityLog).all() as unknown as RecapRow[];
    const recap = () => buildRecap({ sinceMinute: -1, untilMinute: 100 * DAY, rows: rows() });
    expect(recap().bullets).toEqual([]);

    // ── The morning: the wife and a neighbour are about when the guest walks home ──
    db.update(agents).set({ is_active: true, current_location: hostHome, current_action: { type: 'idle' } })
      .where(inArray(agents.id, [wife, snoop])).run();
    db.update(agents).set({ current_action: { type: 'idle' } }).where(inArray(agents.id, [lover, husband])).run();
    const memories: Array<{ agentId: number; description: string; importance: number }> = [];
    const onMemory = (m: (typeof memories)[number]) => memories.push(m);
    simEvents.on('life:milestone', onMemory);
    try { startSneakHome(husband, NOW + 600); } finally { simEvents.off('life:milestone', onMemory); }

    // The feed: being seen is a row (and one only); the paper may print it, discreetly worded.
    const caught = db.select().from(activityLog).all().filter((r) => r.type === 'caught');
    expect(caught).toHaveLength(1);
    const { items } = gatherMaterial(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/saw Hugo Guest slipping out of Lena Host's house at dawn/);
    expect(items[0]).not.toMatch(/night|bed|kiss/i);

    // Two people beyond the pair hold it now: the triangle is no longer a secret, and the paper is handed it.
    resetChronicleCache();
    const out = detectStoryArcs().find((a) => a.kind === 'love_triangle' && a.participants.includes(lover));
    expect(out).toBeDefined();
    expect(out!.secret).toBeUndefined();
    expect(arcsForPaper(detectStoryArcs()).map((a) => a.summary)).toContain(
      'Lena Host and Hugo Guest are involved, though Hugo Guest is with Wanda Wife.',
    );
    // The recap carries being seen, with the hush icon, and nothing of the night itself.
    const bullets = recap().bullets;
    expect(bullets.map((b) => b.icon)).toEqual(['🤫']);
    expect(bullets[0].text).toMatch(/slipping out of Lena Host's house at dawn\.$/);

    // The wife: heartbroken on the spot, about her husband; a memory that weighs 9; nobody but the
    // witnesses and the two were given memories of it.
    expect(db.select().from(agentStates).where(eq(agentStates.agent_id, wife)).all().filter((s) => s.type === 'heartbroken'))
      .toEqual([expect.objectContaining({ target_agent_id: husband })]);
    expect(memories.find((m) => m.agentId === wife)).toMatchObject({ importance: 9 });
    expect(memories.find((m) => m.agentId === snoop)).toMatchObject({ importance: 6 });
    expect(new Set(memories.map((m) => m.agentId))).toEqual(new Set([wife, snoop, husband, lover]));

    // ...and the goals phase, reading `known_by`, sets her on the revenge against him (not the lover).
    goalsTick();
    const revenge = db.select().from(goals).where(and(eq(goals.agent_id, wife), eq(goals.type, 'revenge'))).all();
    expect(revenge.map((g) => g.target_id)).toEqual([husband]);
    expect(db.select().from(goals).where(and(eq(goals.agent_id, lover), eq(goals.type, 'revenge'))).all()).toEqual([]);
  });
});
