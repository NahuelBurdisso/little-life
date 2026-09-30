import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog, agentStates, agents, conversationQueue, locations, needs, relationships, worldState,
} from '../../../db/schema';
import { RENDEZVOUS_TOPIC } from '../../../ai/prompts';
import { nudgeRouter } from '../../../routers/nudge';
import { gameMinutes } from '../../gameClock';
import { setRuleOverrides } from '../../worldRules';
import {
  RENDEZVOUS_QUEUE_PRIORITY, RENDEZVOUS_TRIGGER, onRendezvousConversationEnded, pendingRendezvousPartner,
} from '../rendezvous';
import { clearIntimacy, ensureAgentIntimacy, getPairIntimacy, setStay, updatePairIntimacy } from '../state';
import { KISSED_TAG } from '../kiss';

/**
 * The player's `arrange_rendezvous` nudge. It rides the same invitation the evening pass
 * makes, so every gate of the adult layer holds: the rule, the one age gate, a first kiss
 * behind them, nobody already spoken for tonight. And the one who is asked can still say no.
 */

const TIME = { day: 40, hour: 14, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
const caller = () => nudgeRouter.createCaller({} as never);

let homeId: number;
let farId: number;
const made: number[] = [];

function setClock(): void {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time: TIME, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time: TIME, day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertLocation(name: string): number {
  return db.insert(locations).values({
    name, type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

/** A woman (`a`) and a man (`b`); `a` is the lower id and aches more by default. */
function couple(opts: {
  tags?: string[]; aOver?: Partial<typeof agents.$inferInsert>; bOver?: Partial<typeof agents.$inferInsert>;
  longingA?: number; longingB?: number; romanceB?: number; trustB?: number;
} = {}) {
  const a = insertAgent(`Arr A${made.length}`, { gender: 'female', ...opts.aOver });
  const b = insertAgent(`Arr B${made.length}`, { gender: 'male', ...opts.bOver });
  db.insert(relationships).values({
    agent_a: a, agent_b: b, friendship_ab: 70, friendship_ba: 70,
    romance_ab: 80, romance_ba: opts.romanceB ?? 80, trust_ab: 70, trust_ba: opts.trustB ?? 60,
    familiarity: 80, interaction_count: 40, last_interaction: 0, average_interaction_sentiment: 0.5,
    tags: opts.tags ?? [KISSED_TAG], status: 'romantic_interest', created_at: 0, last_updated: 0,
  }).run();
  ensureAgentIntimacy(a).longing = opts.longingA ?? 70;
  ensureAgentIntimacy(b).longing = opts.longingB ?? 30;
  return { a, b };
}

const arrange = (a: number, b: number, initiatorId?: number) =>
  caller().execute({ action: { type: 'arrange_rendezvous', agentA: a, agentB: b, ...(initiatorId != null ? { initiatorId } : {}) } });
const queued = (a: number, b: number) => db.select().from(conversationQueue).all()
  .filter((q) => q.participants.includes(a) && q.participants.includes(b));
const pending = (a: number, b: number) => getPairIntimacy(a, b)?.pendingRendezvous;
const reasonOf = (r: unknown) => (r as { reason?: string }).reason ?? '';
const feed = () => db.select().from(activityLog).all()
  .map((r) => (r.template_data as { description?: string } | null)?.description ?? '');

describe('the arrange_rendezvous nudge', () => {
  beforeAll(() => {
    setClock();
    homeId = insertLocation('Arrange Cottage');
    farId = insertLocation('Arrange Farm');
  });

  beforeEach(() => {
    clearIntimacy();
    setClock();
    setRuleOverrides({ adultContent: true });
    db.delete(conversationQueue).run();
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    db.delete(conversationQueue).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(needs).where(inArray(needs.agent_id, made)).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(inArray(locations.id, [homeId, farId])).run();
    clearIntimacy();
  });

  describe('is refused', () => {
    it('when the adult content rule is off', async () => {
      setRuleOverrides({ adultContent: false });
      const { a, b } = couple();
      const r = await arrange(a, b);
      expect(r.success).toBe(false);
      expect(reasonOf(r)).toMatch(/turned off/);
      expect(pending(a, b)).toBeUndefined();
      expect(queued(a, b)).toHaveLength(0);
    });

    it('for a minor and an adult, however much they have kissed, and says nothing about why', async () => {
      const { a, b } = couple({ aOver: { age: 16 }, longingA: 100 });
      const r = await arrange(a, b);
      expect(r.success).toBe(false);
      expect(reasonOf(r)).toBe('That is not something you can arrange for them.');
      expect(pending(a, b)).toBeUndefined();
      expect(queued(a, b)).toHaveLength(0);
      // Either order, and two minors.
      expect((await arrange(b, a)).success).toBe(false);
      const kids = couple({ aOver: { age: 16 }, bOver: { age: 17 } });
      expect((await arrange(kids.a, kids.b)).success).toBe(false);
      expect(queued(kids.a, kids.b)).toHaveLength(0);
    });

    it('for two people who are not drawn to each other', async () => {
      const { a, b } = couple({ bOver: { gender: 'female' } });
      const r = await arrange(a, b);
      expect(r.success).toBe(false);
      expect(pending(a, b)).toBeUndefined();
    });

    it("when they haven't kissed yet", async () => {
      const { a, b } = couple({ tags: [] });
      const r = await arrange(a, b);
      expect(r.success).toBe(false);
      expect(reasonOf(r)).toBe("They haven't even kissed yet.");
      expect(queued(a, b)).toHaveLength(0);
    });

    it('when either already has an evening planned, with anyone', async () => {
      const first = couple();
      updatePairIntimacy(first.a, first.b, (p) => { p.pendingRendezvous = { initiatorId: first.a, since: NOW }; });
      const r = await arrange(first.a, first.b);
      expect(r.success).toBe(false);
      expect(reasonOf(r)).toMatch(/already has an evening planned/);

      // ...including a pending with somebody else entirely.
      const second = couple();
      updatePairIntimacy(second.a, first.b, (p) => { p.pendingRendezvous = { initiatorId: second.a, since: NOW }; });
      const r2 = await arrange(second.a, second.b);
      expect(r2.success).toBe(false);
      expect(queued(second.a, second.b)).toHaveLength(0);

      // ...and a guest who is staying the night.
      const third = couple();
      setStay(third.a, { locationId: homeId, hostId: third.b, until: NOW + 600 });
      expect((await arrange(third.a, third.b)).success).toBe(false);
    });

    it('when one of them is asleep', async () => {
      const { a, b } = couple({ bOver: { current_action: { type: 'sleeping' } } });
      const r = await arrange(a, b);
      expect(r.success).toBe(false);
      expect(reasonOf(r)).toMatch(/sleeping/);
    });

    it('when the one chosen to ask is neither of them', async () => {
      const { a, b } = couple();
      const stranger = insertAgent('Arr Stranger');
      const r = await arrange(a, b, stranger);
      expect(r.success).toBe(false);
      expect(pending(a, b)).toBeUndefined();
    });
  });

  describe('is accepted', () => {
    it('together and free: the rendezvous conversation is queued on its own trigger, asked by the one who aches more', async () => {
      const { a, b } = couple({ longingA: 30, longingB: 80 });
      const r = await arrange(a, b);
      expect(r).toMatchObject({ success: true });
      expect(pending(a, b)).toEqual({ initiatorId: b, since: NOW });
      const q = queued(a, b);
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({
        participants: [b, a], tier: 'llm_deep', topic: RENDEZVOUS_TOPIC, trigger_reason: RENDEZVOUS_TRIGGER,
        priority: RENDEZVOUS_QUEUE_PRIORITY,
      });
    });

    it('the player may choose who asks', async () => {
      const { a, b } = couple({ longingA: 30, longingB: 80 });
      await arrange(a, b, a);
      expect(pending(a, b)?.initiatorId).toBe(a);
      expect(queued(a, b)[0].participants).toEqual([a, b]);
    });

    it('apart: the invitation is pending and the asker walks over (nothing queued until they meet)', async () => {
      const { a, b } = couple({ bOver: { current_location: farId, position: { x: 500, y: 0 } } });
      const r = await arrange(a, b);
      expect(r.success).toBe(true);
      expect(pendingRendezvousPartner(a)).toBe(b);
      expect(queued(a, b)).toHaveLength(0);
    });

    it('clears a refusal\'s wait: the player is asking again on purpose', async () => {
      const { a, b } = couple();
      updatePairIntimacy(a, b, (p) => { p.rendezvousRetryAfter = NOW + 2 * 24 * 60; });
      expect((await arrange(a, b)).success).toBe(true);
      expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBeUndefined();
    });

    it('logs a second-person, discreet feed row', async () => {
      const { a, b } = couple();
      const nameA = db.select().from(agents).where(eq(agents.id, a)).get()!.name;
      const nameB = db.select().from(agents).where(eq(agents.id, b)).get()!.name;
      await arrange(a, b);
      // The one who aches more (a) asks, so it names them first.
      expect(feed()).toContain(`You arranged for ${nameA} and ${nameB} to find a quiet moment.`);
    });

    it('when one of them is already talking it waits, and says so', async () => {
      const { a, b } = couple({ aOver: { current_action: { type: 'talking' } } });
      const r = await arrange(a, b) as { success: boolean; queued?: boolean; message?: string };
      expect(r.success).toBe(true);
      expect(r.queued).toBe(true);
      expect(r.message).toMatch(/busy talking/);
      // Pending, but the conversation is not seated over the top of the other one.
      expect(pending(a, b)).toBeDefined();
      expect(queued(a, b)).toHaveLength(0);
    });
  });

  describe('the other can still say no', () => {
    const noTalk = (asker: number, other: number) => ({
      agentId: asker, perpetratorId: other, conversationId: 9_100 + asker, summary: RENDEZVOUS_TOPIC,
      messages: [
        { speakerId: asker, text: 'Would you spend the evening with me, somewhere quiet?' },
        { speakerId: other, text: "No, I can't. Forgive me." },
      ],
    });

    it('a no in the conversation ends the invitation, as it always does', async () => {
      const { a, b } = couple();
      await arrange(a, b);
      await onRendezvousConversationEnded(noTalk(a, b), { llm: false });
      expect(pending(a, b)).toBeUndefined();
      expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBeGreaterThan(NOW);
    });

    it('and a character that would never says no whatever the player arranged', async () => {
      const { a, b } = couple({ romanceB: 5, trustB: 0, longingB: 0 });
      await arrange(a, b);
      const yes = {
        ...noTalk(a, b),
        messages: [
          { speakerId: a, text: 'Would you spend the evening with me, somewhere quiet?' },
          { speakerId: b, text: 'Yes, I would love to.' },
        ],
      };
      await onRendezvousConversationEnded(yes, { llm: false });
      expect(pending(a, b)?.agreed).not.toBe(true);
      expect(pending(a, b)).toBeUndefined();
    });
  });
});
