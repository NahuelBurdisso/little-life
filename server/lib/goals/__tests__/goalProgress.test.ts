import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray, and, desc } from 'drizzle-orm';

vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed (test: LLM disabled)'); });

import { db } from '../../../db';
import { activityLog, agents, goals, locations, needs, worldState } from '../../../db/schema';
import { CONFIG } from '../../constants';
import { simEvents } from '../../simEvents';
import {
  completionAt, describeGoal, goalProgressGain, recordGoalOutcome, GOAL_OUTCOME_GAINS,
} from '../goalProgress';
import { goalsTick, initGoalProgressListenersForTest } from '../../../engine/systems/goals';

/**
 * Goals used to advance on ANY friendly chat with their target — a revenge plot included —
 * and never complete (a 30-day soak finished none). Progress is now goal-type aware and a goal
 * that reaches `completion_at` completes with a feed row, a memory event and a mood lift.
 */

describe('goalProgressGain (pure)', () => {
  it('only the outcomes a goal type lists move it', () => {
    expect(goalProgressGain('revenge', 'warm_chat')).toBe(0);
    expect(goalProgressGain('revenge', 'flirt')).toBe(0);
    expect(goalProgressGain('revenge', 'insulted_target')).toBeGreaterThan(0);
    expect(goalProgressGain('seduce', 'fought_target')).toBe(0);
    expect(goalProgressGain('seduce', 'flirt')).toBeGreaterThan(0);
    expect(goalProgressGain('befriend', 'warm_chat')).toBeGreaterThan(0);
    expect(goalProgressGain('protect', 'comforted')).toBeGreaterThan(goalProgressGain('protect', 'warm_chat'));
    expect(goalProgressGain('nonsense_type', 'warm_chat')).toBe(0);
  });

  it('clamps intensity so one outcome can neither vanish nor finish a goal alone', () => {
    const base = GOAL_OUTCOME_GAINS.befriend.warm_chat!;
    expect(goalProgressGain('befriend', 'warm_chat', 0)).toBeCloseTo(base * 0.5);
    expect(goalProgressGain('befriend', 'warm_chat', 10)).toBeCloseTo(base * 1.5);
    // No hostile-goal outcome finishes a revenge on its own at top intensity.
    for (const gain of Object.values(GOAL_OUTCOME_GAINS.revenge)) expect(gain! * 1.5).toBeLessThan(completionAt('revenge'));
  });

  it('names the target in the goal phrase, and keeps an LLM goal its own words', () => {
    expect(describeGoal({ type: 'revenge', description: null }, 'Marco')).toBe('getting even with Marco');
    expect(describeGoal({ type: 'revenge', description: null }, null)).toBe('getting revenge');
    expect(describeGoal({ type: 'custom', description: 'Open a bakery' }, 'Marco')).toBe('Open a bakery');
  });
});

const TIME = { day: 6, hour: 12, minute: 0, totalTicks: 6 * 1440 + 720, seasonDay: 6, season: 'spring' };
const NOW = 6 * 1440 + 720;
const made: number[] = [];
let homeId: number;

function insertAgent(name: string): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female',
    personality: {
      honesty: 50, aggression: 50, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: NOW,
  }).run();
  made.push(id);
  return id;
}

function insertGoal(agentId: number, type: string, targetId: number | null): number {
  return db.insert(goals).values({
    agent_id: agentId, type, target_id: targetId ?? undefined, motivation: 'test', priority: 0.5,
    progress: 0, status: 'active', created_at: NOW,
  }).returning({ id: goals.id }).get().id;
}

const goalRow = (id: number) => db.select().from(goals).where(eq(goals.id, id)).get()!;

describe('recordGoalOutcome / completion', () => {
  let ana: number;
  let ben: number;

  beforeAll(() => {
    const existing = db.select().from(worldState).get();
    if (existing) db.update(worldState).set({ time: TIME, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    else {
      db.insert(worldState).values({
        time: TIME, day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1,
        is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
        pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
      }).run();
    }
    homeId = db.insert(locations).values({
      name: 'Progress Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    ana = insertAgent('Ana Grudge');
    ben = insertAgent('Ben Target');
  });

  afterAll(() => {
    db.delete(goals).where(inArray(goals.agent_id, made)).run();
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  it('a warm chat does nothing for a revenge; hostile outcomes finish it with a feed row, memory event and mood lift', () => {
    const revenge = insertGoal(ana, 'revenge', ben);
    const emit = vi.spyOn(simEvents, 'emit');

    expect(recordGoalOutcome(ana, ben, 'warm_chat', 1.5)).toBe(0);
    expect(goalRow(revenge).progress).toBe(0);

    recordGoalOutcome(ana, ben, 'insulted_target');
    expect(goalRow(revenge).status).toBe('active');
    recordGoalOutcome(ana, ben, 'fought_target');
    recordGoalOutcome(ana, ben, 'rumor_spread');
    const done = goalRow(revenge);
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(1);
    expect(done.completed_at).toBe(NOW);

    // MemoryObserver records "I accomplished my goal: …" from this event.
    expect(emit).toHaveBeenCalledWith('goal:completed', expect.objectContaining({
      agentId: ana, goalType: 'revenge', description: 'getting even with Ben', victimId: ben,
    }));
    emit.mockRestore();

    const row = db.select().from(activityLog)
      .where(and(eq(activityLog.type, 'goal_completed'), eq(activityLog.initiator_id, ana)))
      .orderBy(desc(activityLog.id)).get();
    expect(row?.template_data).toMatchObject({ agent: 'Ana Grudge', goal_description: 'getting even with Ben' });

    const mods = db.select().from(needs).where(eq(needs.agent_id, ana)).get()!.mood_modifiers;
    expect(mods.find((m) => m.source === 'goal_completed')?.value).toBeGreaterThan(0);

    // Completed once: more outcomes don't re-complete or re-log it.
    expect(recordGoalOutcome(ana, ben, 'fought_target')).toBe(0);
  });

  it('only advances goals aimed at that person', () => {
    const other = insertAgent('Cal Bystander');
    const befriendCal = insertGoal(ana, 'befriend', other);
    recordGoalOutcome(ana, ben, 'warm_chat');
    expect(goalRow(befriendCal).progress).toBe(0);
    recordGoalOutcome(ana, other, 'warm_chat');
    expect(goalRow(befriendCal).progress).toBeGreaterThan(0);
  });

  it('the conversation listener sorts chats by goal type: warm helps befriend, not revenge', () => {
    initGoalProgressListenersForTest();
    const dee = insertAgent('Dee Friend');
    const befriend = insertGoal(ben, 'befriend', dee);
    const revenge = insertGoal(ben, 'revenge', dee);

    simEvents.emit('conversation:ended', { agentId: ben, perpetratorId: dee, sentiment: 0.6, turns: 4 });
    expect(goalRow(befriend).progress).toBeGreaterThan(0);
    expect(goalRow(revenge).progress).toBe(0);

    simEvents.emit('conversation:ended', { agentId: ben, perpetratorId: dee, sentiment: -0.6, turns: 4 });
    expect(goalRow(revenge).progress).toBeGreaterThan(0);

    // An insult beat (either conversation tier emits it) counts for the insulter.
    const before = goalRow(revenge).progress;
    simEvents.emit('interaction:completed', { agentId: ben, perpetratorId: ben, victimId: dee, action: 'insult' });
    expect(goalRow(revenge).progress).toBeGreaterThan(before);
  });

  it('a warm chat with someone who is down counts as comfort for a protect goal', () => {
    initGoalProgressListenersForTest();
    const eve = insertAgent('Eve Sad');
    const protect = insertGoal(ana, 'protect', eve);
    simEvents.emit('conversation:ended', { agentId: ana, perpetratorId: eve, sentiment: 0.4, partnerState: 'grieving' });
    expect(goalRow(protect).progress).toBeCloseTo(GOAL_OUTCOME_GAINS.protect.comforted!, 5);
  });

  it('the target recovering completes a protect goal the owner put work into, and abandons an idle one', () => {
    const fay = insertAgent('Fay Better');
    const gus = insertAgent('Gus Idle');
    const helped = insertGoal(fay, 'protect', ben);
    db.update(goals).set({ progress: 0.4 }).where(eq(goals.id, helped)).run();
    const idle = insertGoal(gus, 'protect', ben);
    const emit = vi.spyOn(simEvents, 'emit');

    goalsTick(); // Ben has no distress state: "target_recovered" fires for both

    expect(goalRow(helped).status).toBe('completed');
    expect(goalRow(idle).status).toBe('abandoned');
    // The owner remembers giving up (MemoryObserver: "I gave up on my goal: looking after Ben").
    expect(emit).toHaveBeenCalledWith('goal:abandoned', expect.objectContaining({
      agentId: gus, description: 'looking after Ben',
    }));
    emit.mockRestore();
  });
});
