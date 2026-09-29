import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  agents, agentStates, aspirations, conversationQueue, conversations, economy, locations, needs, relationships,
  worldState,
} from '../../db/schema';
import {
  NEWCOMER_TIE_SCALE, createResident, findHousing, rehomeCouple, retireResident, townEdgePoint,
} from '../residents';
import { processAgentDeath } from '../lifeEventsEngine';
import { memoryService } from '../memory/instance';
import { simEvents } from '../simEvents';
import { CONFIG } from '../constants';
import { MAX_AGENTS } from '../worldgen/config';
import { jobSalary } from '../../data/jobs';
import { nudgeRouter } from '../../routers/nudge';
import { milestonesTick, clearMilestones } from '../milestonesEngine';
import { DAY, NOW, TIME, freshTown, insertResident, relate, type Town } from './populationFixtures';

/**
 * The resident lifecycle (lib/residents.ts): one factory every newcomer comes
 * out of complete, one way out that leaves no ghost behind.
 */

let town: Town;
let recorded: Array<{ agentId: number; type: string; description: string; importance?: number }>;

beforeEach(() => {
  town = freshTown();
  recorded = [];
  vi.spyOn(memoryService, 'record').mockImplementation((agentId, type, description, _m, _v, importance) => {
    recorded.push({ agentId, type, description, importance });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('townEdgePoint', () => {
  it('is the road tile nearest the map border, in pixels', () => {
    // Tiles: (20,10) is 10 from the top, (20,28) 1 from the bottom, (5,15) 5 from the left.
    expect(townEdgePoint({ map_width: 40, map_height: 30, road_tiles: [{ x: 20, y: 10 }, { x: 20, y: 28 }, { x: 5, y: 15 }] }))
      .toEqual({ x: 20 * 32 + 16, y: 28 * 32 + 16 });
  });

  it('falls back to the middle of the southern border without roads', () => {
    expect(townEdgePoint({ map_width: 40, map_height: 30, road_tiles: [] })).toEqual({ x: 20 * 32 + 16, y: 27 * 32 + 16 });
  });
});

describe('findHousing', () => {
  it('prefers an empty house, then a spare bed, then the tavern', () => {
    const locs = db.select().from(locations).all();
    const [h1, h2, h3] = town.homes;
    expect(findHousing(locs, [{ home: h1 }, { home: h2 }])?.location.id).toBe(h3);
    // Every house has someone in it: the big one has room.
    expect(findHousing(locs, [{ home: h1 }, { home: h2 }, { home: h3 }])?.location.id).toBe(h1);
    const full = [h1, h1, h2, h2, h3, h3, h3, h3].map((home) => ({ home }));
    expect(findHousing(locs, full)).toMatchObject({ lodging: true, location: { id: town.tavern } });
    expect(findHousing(locs, [{ home: h1 }, { home: h2 }, { home: h3 }], { emptyOnly: true })).toBeNull();
  });
});

describe('createResident', () => {
  it('builds a complete resident: rows, ties, aspiration, backstory, a named home', () => {
    const [h1, h2, h3] = town.homes;
    const baker = insertResident('Alice Moore', h1, { workplace: town.bakery }, { job: 'baker' });
    insertResident('Bob Grey', h2);
    const arrived = vi.fn();
    simEvents.on('life:arrived', arrived);

    const res = createResident({ name: 'Tomas Ortega', job: 'baker', source: 'player' });
    simEvents.off('life:arrived', arrived);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res).toMatchObject({ homeId: h3, lodging: false, workplaceId: town.bakery, jobTitle: 'Baker' });

    const row = db.select().from(agents).where(eq(agents.id, res.agentId)).get()!;
    for (const key of ['bio', 'traits', 'personality', 'age', 'gender', 'schedule', 'home', 'workplace', 'position'] as const) {
      expect(row[key], key).not.toBeNull();
    }
    expect(row.is_active).toBe(true);
    expect(row.current_location).toBe(h3);
    expect(db.select().from(locations).where(eq(locations.id, h3)).get()!.current_occupants).toContain(res.agentId);

    const n = db.select().from(needs).where(eq(needs.agent_id, res.agentId)).get()!;
    expect(n.mood).toBeGreaterThan(0);
    const econ = db.select().from(economy).where(eq(economy.agent_id, res.agentId)).get()!;
    expect(econ).toMatchObject({ job: 'baker', job_title: 'Baker', salary: jobSalary('baker') });
    const asp = db.select().from(aspirations).where(eq(aspirations.agent_id, res.agentId)).all();
    expect(asp).toHaveLength(1);
    expect(asp[0].status).toBe('active');

    // A light coworker tie with the baker already there.
    const tie = db.select().from(relationships).where(or(
      and(eq(relationships.agent_a, baker), eq(relationships.agent_b, res.agentId)),
      and(eq(relationships.agent_a, res.agentId), eq(relationships.agent_b, baker)),
    )).get()!;
    expect(tie.tags).toContain('coworkers');
    expect(tie.friendship_ab).toBeGreaterThan(10);
    expect(tie.friendship_ab).toBeLessThanOrEqual(Math.round(40 * NEWCOMER_TIE_SCALE.friendship));
    expect(tie.familiarity).toBeGreaterThanOrEqual(5);

    // The house is theirs now, by name; the backstory is a first-person memory.
    expect(res.homeName).toBe("Tomas' cottage");
    const backstory = recorded.find((r) => r.agentId === res.agentId);
    expect(backstory?.importance).toBe(8);
    expect(backstory?.description).toMatch(/^I left my old life behind .* to work as a baker\./);
    expect(backstory?.description).toContain('Alice');
    expect(arrived).toHaveBeenCalledWith(expect.objectContaining({ agentId: res.agentId, source: 'player' }));
  });

  it('walks in from the town edge when asked to', () => {
    const res = createResident({ name: 'Ada Finch', job: 'retired', arriveAt: 'edge', source: 'town' });
    if (!res.ok) throw new Error(res.reason);
    const row = db.select().from(agents).where(eq(agents.id, res.agentId)).get()!;
    const world = db.select().from(worldState).get()!;
    expect(row.position).toEqual(townEdgePoint(world));
    expect(row.current_action).toMatchObject({ type: 'walking' });
    expect(row.current_destination).toMatchObject({ locationId: res.homeId });
    expect(row.current_location).toBeNull();
    expect(row.workplace).toBeNull();
  });

  it('lodges at the tavern when every house is full, and refuses when only an empty house will do', () => {
    const [h1, h2, h3] = town.homes;
    for (const [i, home] of [h1, h1, h2, h2, h3, h3, h3, h3].entries()) insertResident(`Full ${i}`, home);
    expect(createResident({ name: 'Picky Pete', job: 'farmhand', emptyHomeOnly: true, source: 'town' }))
      .toEqual({ ok: false, reason: 'No available housing' });
    const res = createResident({ name: 'Lodger Lou', job: 'farmhand', source: 'player' });
    expect(res).toMatchObject({ ok: true, lodging: true, homeId: town.tavern, homeName: 'The Tavern' });
  });

  it('respects the one population cap', () => {
    expect(CONFIG.MAX_AGENTS).toBe(MAX_AGENTS);
    for (let i = 0; i < CONFIG.MAX_AGENTS; i++) insertResident(`Resident ${i}`, town.tavern);
    expect(createResident({ name: 'One Too Many', job: 'farmer', source: 'player' }))
      .toEqual({ ok: false, reason: `Maximum agents reached (${CONFIG.MAX_AGENTS})` });
  });
});

describe('retireResident', () => {
  it('frees the home and clears every trace of them in the running town', () => {
    const [h1] = town.homes;
    const friend = insertResident('Friend Fay', h1);
    const res = createResident({ name: 'Leaving Lena', job: 'baker', source: 'player' });
    if (!res.ok) throw new Error(res.reason);
    const id = res.agentId;
    relate(friend, id, { friendship_ab: 60, friendship_ba: 60 });
    db.update(agents).set({ current_action: { type: 'talking' } }).where(eq(agents.id, friend)).run();
    const convoId = db.insert(conversations).values({
      participants: [id, friend], messages: [], trigger_reason: 'test', status: 'active',
      started_at: Date.now(), topic: null, sentiment: 0, max_turns: 4,
    }).returning({ id: conversations.id }).get().id;
    db.insert(conversationQueue).values({
      participants: [id, friend], tier: 'template', priority: 1, trigger_reason: 'test', topic: null,
      queued_at: Date.now(), max_wait: 60_000,
    }).run();
    db.insert(agentStates).values({ agent_id: id, type: 'sad', severity: 0.5, started_at: NOW, duration: 60, source: 'test' }).run();
    const departed = vi.fn();
    simEvents.on('life:departed', departed);

    expect(retireResident(id, 'left')).toBe(true);
    simEvents.off('life:departed', departed);

    const row = db.select().from(agents).where(eq(agents.id, id)).get()!;
    expect(row.is_active).toBe(false);
    expect(row.daily_plan).toBeNull();
    expect(row.action_queue).toEqual([]);
    for (const l of db.select().from(locations).all()) expect(l.current_occupants).not.toContain(id);
    expect(db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all()).toHaveLength(0);
    expect(db.select().from(conversationQueue).all().filter((q) => q.participants.includes(id))).toHaveLength(0);
    expect(db.select().from(conversations).where(eq(conversations.id, convoId)).get()!.status).toBe('ended');
    expect((db.select().from(agents).where(eq(agents.id, friend)).get()!.current_action as { type: string }).type).toBe('idle');
    // The bakery they took over goes to their friend.
    expect(db.select().from(locations).where(eq(locations.id, town.bakery)).get()!.owner).toBe(friend);
    // Their house is empty again.
    const living = db.select().from(agents).where(eq(agents.is_active, true)).all();
    expect(findHousing(db.select().from(locations).all(), living, { emptyOnly: true })?.location.id).toBe(res.homeId);
    expect(departed).toHaveBeenCalledWith(expect.objectContaining({ agentId: id, reason: 'left' }));
    // Only once.
    expect(retireResident(id, 'left')).toBe(false);
  });

  it('a death goes the same way out, and is announced as life:death', () => {
    const id = insertResident('Old Otto', town.homes[0]);
    const died = vi.fn();
    simEvents.on('life:death', died);
    processAgentDeath(id, 'Old Otto', 'old_age', NOW);
    simEvents.off('life:death', died);
    const row = db.select().from(agents).where(eq(agents.id, id)).get()!;
    expect(row.is_active).toBe(false);
    expect((row.current_action as { type: string }).type).toBe('dead');
    expect(died).toHaveBeenCalledWith(expect.objectContaining({ agentId: id, cause: 'old_age' }));
  });

  it('nudge.remove_agent retires through the factory (queued chats go too)', async () => {
    const a = insertResident('Removed Rita', town.homes[0]);
    const b = insertResident('Staying Sam', town.homes[1]);
    db.insert(conversationQueue).values({
      participants: [a, b], tier: 'template', priority: 1, trigger_reason: 'test', topic: null,
      queued_at: Date.now(), max_wait: 60_000,
    }).run();
    const res = await nudgeRouter.createCaller({} as never).execute({ action: { type: 'remove_agent', agentId: a } });
    expect(res.success).toBe(true);
    expect(db.select().from(conversationQueue).all().filter((q) => q.participants.includes(a))).toHaveLength(0);
  });

  it('nudge.introduce_agent builds its newcomer with the factory', async () => {
    const res = await nudgeRouter.createCaller({} as never).execute({
      action: { type: 'introduce_agent', name: 'Nora Vance', bio: '', traits: ['caring'], job: 'baker' },
    });
    expect(res.success).toBe(true);
    const id = (res as { agentId: number }).agentId;
    expect(db.select().from(aspirations).where(eq(aspirations.agent_id, id)).all()).toHaveLength(1);
    expect(recorded.some((r) => r.agentId === id && /old life/.test(r.description))).toBe(true);
  });
});

describe('married couples move in together', () => {
  it('into the larger house, freeing the other', () => {
    const [small, , big] = town.homes; // capacity 2 and 4
    const a = insertResident('Harold Pickett', small);
    const b = insertResident('Violet Stroud', big);
    const moved = rehomeCouple(a, b);
    expect(moved).toMatchObject({ moverId: a, hostId: b, homeId: big, leftHomeId: small });
    expect(db.select().from(agents).where(eq(agents.id, a)).get()!.home).toBe(big);
    const living = db.select().from(agents).where(eq(agents.is_active, true)).all();
    expect(findHousing(db.select().from(locations).all(), living, { emptyOnly: true })?.location.id).toBe(small);
    // Renamed for the household now living there.
    expect(db.select().from(locations).where(eq(locations.id, big)).get()!.name).toMatch(/house/);
    // Already together: nothing to do.
    expect(rehomeCouple(a, b)).toBeNull();
  });

  it('stays put when neither house has room', () => {
    const [h1, h2] = town.homes; // both capacity 2
    const a = insertResident('Ada A', h1);
    insertResident('Ada Sister', h1);
    const b = insertResident('Bert B', h2);
    insertResident('Bert Brother', h2);
    expect(rehomeCouple(a, b)).toBeNull();
  });

  it('happens at the wedding', () => {
    clearMilestones();
    const [small, , big] = town.homes;
    const a = insertResident('Cora Lowry', small);
    const b = insertResident('Silas Thorne', big);
    relate(a, b, {
      friendship_ab: 80, friendship_ba: 80, romance_ab: 90, romance_ba: 90, trust_ab: 70, trust_ba: 70,
      tags: ['partner', 'engaged'], status: 'partners', status_since_minute: NOW - 10 * DAY,
    });
    // First pass starts the engagement clock; a day later at noon, the wedding.
    milestonesTick({ ...TIME, hour: 12 }, NOW);
    milestonesTick({ ...TIME, day: TIME.day + 1, hour: 12 }, NOW + DAY + 12 * 60);
    const rel = db.select().from(relationships).get()!;
    expect(rel.tags).toContain('married');
    expect(db.select().from(agents).where(eq(agents.id, a)).get()!.home).toBe(big);
    clearMilestones();
  });
});
