import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import {
  agents,
  needs,
  economy,
  locations,
  conversations,
  conversationQueue,
  worldState,
  worldEvents,
  economyTransactions,
} from '../db/schema';
import { logActivity } from '../lib/activityLogger';
import { eq, and, ne } from 'drizzle-orm';
import { emitter } from '../engine/emitter';
import { z } from 'zod';
import { CONFIG } from '../lib/constants';

const VALID_SPEEDS = [0, 0.5, 1, 2, 4];

const EVENT_DEFS: Record<
  string,
  {
    name: string;
    description: string;
    duration: number;
    effects: Record<string, number>;
  }
> = {
  festival: {
    name: 'Town Festival',
    description: 'Everyone gathers in the square for food and music!',
    duration: 4,
    effects: { social_boost: 20, fun_boost: 15, shop_prices: 0.7 },
  },
  market_day: {
    name: 'Market Day',
    description: 'Special prices at all shops today.',
    duration: 8,
    effects: { shop_prices: 0.5 },
  },
  storm: {
    name: 'Heavy Storm',
    description: 'A fierce storm rolls in. Best to stay indoors.',
    duration: 3,
    effects: { mood_outdoor: -15, force_indoors: 1 },
  },
  sickness: {
    name: 'Flu Outbreak',
    description: 'A cold is spreading. Energy drains faster.',
    duration: 24,
    effects: { energy_drain: 1.5, doctor_demand: 2 },
  },
  harvest: {
    name: 'Harvest Bounty',
    description: 'The farm is overflowing! Food prices drop.',
    duration: 12,
    effects: { farm_production: 2.0, food_prices: 0.6 },
  },
};

function getActionType(currentAction: Record<string, any> | null): string | null {
  if (!currentAction) return null;
  if (typeof currentAction === 'object' && 'type' in currentAction) {
    return currentAction.type as string;
  }
  return typeof currentAction === 'string' ? currentAction : null;
}

const nudgeInput = z.object({
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('suggest_talk'), agentA: z.number(), agentB: z.number(), topic: z.string().optional() }),
    z.object({ type: z.literal('suggest_go_to'), agentId: z.number(), locationId: z.number() }),
    z.object({ type: z.literal('trigger_event'), eventType: z.string() }),
    z.object({ type: z.literal('give_money'), agentId: z.number(), amount: z.number() }),
    z.object({ type: z.literal('change_speed'), speed: z.number() }),
    z.object({ type: z.literal('toggle_pause') }),
    z.object({ type: z.literal('introduce_agent'), name: z.string(), bio: z.string(), traits: z.array(z.string()), job: z.string() }),
    z.object({ type: z.literal('remove_agent'), agentId: z.number() }),
    z.object({ type: z.literal('tell_secret'), agentId: z.number(), targetId: z.number(), factId: z.number() }),
    z.object({ type: z.literal('force_confront'), agentA: z.number(), agentB: z.number() }),
  ]),
});

export const nudgeRouter = router({
  execute: publicProcedure
    .input(nudgeInput)
    .mutation(({ input }) => {
      const { action } = input;

      const world = db.select().from(worldState).get();
      if (!world) throw new Error('World not initialized');

      const now = (world.time as any).totalTicks as number;

      switch (action.type) {
        // ─── suggest_talk ──────────────────────────────────────────────────
        case 'suggest_talk': {
          const { agentA: agentAId, agentB: agentBId, topic } = action;

          const agentA = db.select().from(agents).where(eq(agents.id, agentAId)).get();
          const agentB = db.select().from(agents).where(eq(agents.id, agentBId)).get();

          if (!agentA || !agentA.is_active) {
            return { success: false, reason: 'Agent A not found or inactive' };
          }
          if (!agentB || !agentB.is_active) {
            return { success: false, reason: 'Agent B not found or inactive' };
          }

          if (getActionType(agentA.current_action) === 'sleeping') {
            return { success: false, reason: `${agentA.name} is sleeping` };
          }
          if (getActionType(agentB.current_action) === 'sleeping') {
            return { success: false, reason: `${agentB.name} is sleeping` };
          }

          // Check not already in conversation together
          const activeConvos = db
            .select()
            .from(conversations)
            .where(eq(conversations.status, 'active'))
            .all();

          const alreadyTalking = activeConvos.some((c) => {
            const parts = c.participants as number[];
            return parts.includes(agentAId) && parts.includes(agentBId);
          });
          if (alreadyTalking) {
            return {
              success: false,
              reason: `${agentA.name} and ${agentB.name} are already in conversation`,
            };
          }

          // Calculate midpoint
          const posA = agentA.position as { x: number; y: number };
          const posB = agentB.position as { x: number; y: number };
          const midX = (posA.x + posB.x) / 2;
          const midY = (posA.y + posB.y) / 2;

          // Queue conversation
          db.insert(conversationQueue)
            .values({
              participants: [agentAId, agentBId],
              tier: 'llm_deep',
              priority: CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY,
              trigger_reason: 'player_nudge',
              topic: topic ?? null,
              queued_at: now,
              max_wait: CONFIG.CONVERSATIONS.PLAYER_NUDGE_MAX_WAIT_MS,
            })
            .run();

          // Set both agents walking toward midpoint
          const existingQueueA = (agentA.action_queue as Record<string, any>[]) ?? [];
          db.update(agents)
            .set({
              current_action: { type: 'walking', to: { x: midX, y: midY } },
              current_destination: { x: midX, y: midY },
              current_path: null,
              action_started: now,
              action_duration: null,
              action_queue: [
                { type: 'talking', target: agentBId },
                ...existingQueueA,
              ],
            })
            .where(eq(agents.id, agentAId))
            .run();

          const existingQueueB = (agentB.action_queue as Record<string, any>[]) ?? [];
          db.update(agents)
            .set({
              current_action: { type: 'walking', to: { x: midX, y: midY } },
              current_destination: { x: midX, y: midY },
              current_path: null,
              action_started: now,
              action_duration: null,
              action_queue: [
                { type: 'talking', target: agentAId },
                ...existingQueueB,
              ],
            })
            .where(eq(agents.id, agentBId))
            .run();

          logActivity({
            type: 'player_nudge',
            agents: [agentAId, agentBId],
            templateData: { description: `Player suggested ${agentA.name} and ${agentB.name} talk${topic ? ` about "${topic}"` : ''}` },
          });

          emitter.markDirty('agents.all');
          emitter.flush();
          return { success: true };
        }

        // ─── suggest_go_to ─────────────────────────────────────────────────
        case 'suggest_go_to': {
          const { agentId, locationId } = action;

          const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
          if (!agent || !agent.is_active) {
            return { success: false, reason: 'Agent not found or inactive' };
          }
          if (getActionType(agent.current_action) === 'sleeping') {
            return { success: false, reason: `${agent.name} is sleeping` };
          }

          const location = db.select().from(locations).where(eq(locations.id, locationId)).get();
          if (!location) {
            return { success: false, reason: 'Location not found' };
          }

          const entryPoint = location.entry_point as { x: number; y: number };
          db.update(agents)
            .set({
              current_action: { type: 'walking', to: { x: entryPoint.x, y: entryPoint.y } },
              current_destination: {
                x: entryPoint.x,
                y: entryPoint.y,
                locationId,
              },
              current_path: null,
              action_started: now,
              action_duration: null,
            })
            .where(eq(agents.id, agentId))
            .run();

          logActivity({
            type: 'player_nudge',
            initiator: agentId,
            templateData: { description: `Player sent ${agent.name} to ${location.name}` },
          });

          emitter.markDirty('agents.all');
          emitter.flush();
          return { success: true };
        }

        // ─── trigger_event ─────────────────────────────────────────────────
        case 'trigger_event': {
          const { eventType } = action;
          const eventDef = EVENT_DEFS[eventType];
          if (!eventDef) {
            return { success: false, reason: `Unknown event type: ${eventType}` };
          }

          const activeEvents = db
            .select()
            .from(worldEvents)
            .where(eq(worldEvents.is_active, true))
            .all();

          if (activeEvents.some((e) => e.type === eventType)) {
            return {
              success: false,
              reason: `A "${eventDef.name}" event is already active`,
            };
          }

          if (activeEvents.length >= CONFIG.EVENTS.MAX_CONCURRENT_EVENTS) {
            return {
              success: false,
              reason: `Maximum concurrent events reached (${CONFIG.EVENTS.MAX_CONCURRENT_EVENTS})`,
            };
          }

          db.insert(worldEvents)
            .values({
              type: eventType,
              name: eventDef.name,
              description: eventDef.description,
              started_at: now,
              duration: eventDef.duration,
              effects: eventDef.effects,
              location_id: null,
              triggered_by: 'player',
              is_active: true,
            })
            .run();

          logActivity({
            type: 'player_event',
            templateData: { description: `Player triggered: ${eventDef.name}` },
          });

          emitter.markDirty('world.state');
          emitter.flush();
          return { success: true };
        }

        // ─── give_money ────────────────────────────────────────────────────
        case 'give_money': {
          const { agentId, amount } = action;

          if (typeof amount !== 'number' || amount < 1 || amount > 500) {
            return { success: false, reason: 'Amount must be between 1 and 500' };
          }

          const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
          if (!agent || !agent.is_active) {
            return { success: false, reason: 'Agent not found or inactive' };
          }

          const econ = db
            .select()
            .from(economy)
            .where(eq(economy.agent_id, agentId))
            .get();
          if (!econ) {
            return { success: false, reason: 'Economy record not found' };
          }

          db.update(economy)
            .set({ money: econ.money + amount })
            .where(eq(economy.id, econ.id))
            .run();

          db.insert(economyTransactions)
            .values({
              from_agent: null,
              to_agent: agentId,
              amount,
              reason: 'player_gift',
              items_exchanged: null,
              location_id: null,
              timestamp: now,
            })
            .run();

          logActivity({
            type: 'player_gift',
            initiator: agentId,
            templateData: { description: `Player gave ${agent.name} $${amount}` },
          });

          emitter.markDirty('agents.all');
          emitter.flush();
          return { success: true };
        }

        // ─── change_speed ──────────────────────────────────────────────────
        case 'change_speed': {
          const { speed } = action;

          if (!VALID_SPEEDS.includes(speed)) {
            return {
              success: false,
              reason: `Invalid speed. Must be one of: ${VALID_SPEEDS.join(', ')}`,
            };
          }

          db.update(worldState)
            .set({
              tick_speed: speed,
              is_paused: speed === 0,
            })
            .where(eq(worldState.id, world.id))
            .run();

          emitter.markDirty('world.state');
          emitter.flush();
          return { success: true };
        }

        // ─── toggle_pause ──────────────────────────────────────────────────
        case 'toggle_pause': {
          const newPaused = !world.is_paused;

          db.update(worldState)
            .set({
              is_paused: newPaused,
              tick_speed: newPaused ? 0 : 1,
            })
            .where(eq(worldState.id, world.id))
            .run();

          emitter.markDirty('world.state');
          emitter.flush();
          return { success: true };
        }

        // ─── introduce_agent ───────────────────────────────────────────────
        case 'introduce_agent': {
          const { name, bio, traits, job } = action;

          const activeAgents = db
            .select()
            .from(agents)
            .where(eq(agents.is_active, true))
            .all();

          if (activeAgents.length >= CONFIG.MAX_AGENTS) {
            return {
              success: false,
              reason: `Maximum agents reached (${CONFIG.MAX_AGENTS})`,
            };
          }

          // Find available home
          const homes = db
            .select()
            .from(locations)
            .where(eq(locations.type, 'home'))
            .all();

          const availableHome = homes.find(
            (h) => (h.current_occupants as number[]).length < h.capacity
          );
          if (!availableHome) {
            return { success: false, reason: 'No available housing' };
          }

          // Find workplace
          const workplaces = db
            .select()
            .from(locations)
            .where(
              and(
                ne(locations.type, 'home'),
                ne(locations.type, 'park'),
                ne(locations.type, 'plaza')
              )
            )
            .all();

          const workplace =
            workplaces.find(
              (w) =>
                w.type.toLowerCase().includes(job.toLowerCase()) ||
                w.name.toLowerCase().includes(job.toLowerCase())
            ) ?? workplaces[0] ?? null;

          const homeEntry = availableHome.entry_point as { x: number; y: number };

          // Create agent
          const result = db
            .insert(agents)
            .values({
              name,
              bio,
              traits,
              age: 25,
              gender: 'neutral',
              sprite_sheet: 'default',
              portrait_sprite: 'default',
              position: { x: homeEntry.x, y: homeEntry.y },
              current_destination: null,
              current_location: availableHome.id,
              current_action: { type: 'idle' },
              action_started: now,
              action_duration: null,
              action_queue: [],
              current_path: null,
              schedule: {
                wakeTime: 7,
                sleepTime: 23,
                workStart: 9,
                workEnd: 17,
                lunchTime: 12,
                freeTimePreferences: ['socializing', 'shopping'],
              },
              home: availableHome.id,
              workplace: workplace ? workplace.id : null,
              created_at: now,
              is_active: true,
            })
            .run();

          const agentId = Number(result.lastInsertRowid);

          // Add agent to home occupants
          const occupants = availableHome.current_occupants as number[];
          db.update(locations)
            .set({
              current_occupants: [...occupants, agentId],
            })
            .where(eq(locations.id, availableHome.id))
            .run();

          // Create needs record
          db.insert(needs)
            .values({
              agent_id: agentId,
              hunger: 80,
              energy: 80,
              social: 80,
              comfort: 80,
              fun: 80,
              mood: 80,
              stress: 10,
              decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES },
              thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
              mood_modifiers: [],
              last_updated: now,
            })
            .run();

          // Create economy record
          db.insert(economy)
            .values({
              agent_id: agentId,
              job,
              job_title: job,
              salary: 20,
              work_performance: 0.7,
              money: CONFIG.ECONOMY.STARTING_MONEY,
              daily_expenses: CONFIG.ECONOMY.DAILY_EXPENSES.min,
              inventory: [],
              last_payday: now,
              production_remainder: 0,
            })
            .run();

          // Trigger new_arrival world event
          db.insert(worldEvents)
            .values({
              type: 'new_arrival',
              name: 'New Arrival',
              description: `${name} has moved to town!`,
              started_at: now,
              duration: 1,
              effects: {},
              location_id: availableHome.id,
              triggered_by: 'player',
              is_active: true,
            })
            .run();

          logActivity({
            type: 'player_introduce',
            initiator: agentId,
            templateData: { description: `Player introduced ${name} to the town` },
          });

          emitter.markDirty('agents.all');
          emitter.markDirty('world.state');
          emitter.flush();
          return { success: true };
        }

        // ─── remove_agent ──────────────────────────────────────────────────
        case 'remove_agent': {
          const { agentId } = action;

          const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
          if (!agent) {
            return { success: false, reason: 'Agent not found' };
          }
          if (!agent.is_active) {
            return { success: false, reason: 'Agent is already inactive' };
          }

          // Deactivate agent
          db.update(agents)
            .set({ is_active: false })
            .where(eq(agents.id, agentId))
            .run();

          // End any active conversations involving this agent
          const activeConvos = db
            .select()
            .from(conversations)
            .where(eq(conversations.status, 'active'))
            .all();

          for (const convo of activeConvos) {
            const parts = convo.participants as number[];
            if (parts.includes(agentId)) {
              db.update(conversations)
                .set({ status: 'ended', ended_at: now })
                .where(eq(conversations.id, convo.id))
                .run();
            }
          }

          // Remove from location currentOccupants
          if (agent.current_location) {
            const location = db
              .select()
              .from(locations)
              .where(eq(locations.id, agent.current_location))
              .get();
            if (location) {
              const occupants = (location.current_occupants as number[]).filter(
                (id) => id !== agentId
              );
              db.update(locations)
                .set({ current_occupants: occupants })
                .where(eq(locations.id, location.id))
                .run();
            }
          }

          logActivity({
            type: 'player_remove',
            initiator: agentId,
            templateData: { description: `Player removed ${agent.name} from the town` },
          });

          emitter.markDirty('agents.all');
          emitter.markDirty('conversations');
          emitter.flush();
          return { success: true };
        }

        // ─── tell_secret ────────────────────────────────────────────────────
        case 'tell_secret': {
          const { agentId, targetId, factId } = action;
          const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
          const target = db.select().from(agents).where(eq(agents.id, targetId)).get();
          if (!agent || !target) return { success: false, reason: 'Agent not found' };

          const { shared_knowledge } = await import('../db/schema');
          const fact = db.select().from(shared_knowledge).where(eq(shared_knowledge.id, factId)).get();
          if (!fact) return { success: false, reason: 'Fact not found' };

          const knownBy = fact.known_by as number[];
          if (!knownBy.includes(targetId)) {
            db.update(shared_knowledge)
              .set({ known_by: [...new Set([...knownBy, targetId])] })
              .where(eq(shared_knowledge.id, factId))
              .run();
          }

          // Queue dramatic conversation about this fact
          db.insert(conversationQueue).values({
            participants: [agentId, targetId],
            tier: 'llm_deep',
            priority: CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY,
            trigger_reason: 'player_tell_secret',
            topic: `revealing: ${fact.content}`,
            queued_at: now,
            max_wait: CONFIG.CONVERSATIONS.PLAYER_NUDGE_MAX_WAIT_MS,
          }).run();

          logActivity({
            type: 'player_nudge',
            agents: [agentId, targetId],
            templateData: { description: `Player made ${agent.name} reveal a secret to ${target.name}` },
          });

          emitter.markDirty('agents.all');
          emitter.flush();
          return { success: true };
        }

        // ─── force_confront ─────────────────────────────────────────────────
        case 'force_confront': {
          const { agentA: aId, agentB: bId } = action;
          const agentA = db.select().from(agents).where(eq(agents.id, aId)).get();
          const agentB = db.select().from(agents).where(eq(agents.id, bId)).get();
          if (!agentA || !agentB) return { success: false, reason: 'Agent not found' };

          // Queue deep confrontation conversation
          db.insert(conversationQueue).values({
            participants: [aId, bId],
            tier: 'llm_deep',
            priority: CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY + 50,
            trigger_reason: 'player_confront',
            topic: 'confrontation',
            queued_at: now,
            max_wait: CONFIG.CONVERSATIONS.PLAYER_NUDGE_MAX_WAIT_MS,
          }).run();

          // Walk both to midpoint
          const posA = agentA.position as { x: number; y: number };
          const posB = agentB.position as { x: number; y: number };
          const midX = (posA.x + posB.x) / 2;
          const midY = (posA.y + posB.y) / 2;

          db.update(agents).set({
            current_action: { type: 'walking', to: { x: midX, y: midY } },
            current_destination: { x: midX, y: midY },
            current_path: null,
            action_started: now,
            action_duration: null,
            action_queue: [{ type: 'talking', target: bId }],
          }).where(eq(agents.id, aId)).run();

          db.update(agents).set({
            current_action: { type: 'walking', to: { x: midX, y: midY } },
            current_destination: { x: midX, y: midY },
            current_path: null,
            action_started: now,
            action_duration: null,
            action_queue: [{ type: 'talking', target: aId }],
          }).where(eq(agents.id, bId)).run();

          logActivity({
            type: 'player_nudge',
            agents: [aId, bId],
            templateData: { description: `Player forced a confrontation between ${agentA.name} and ${agentB.name}` },
          });

          emitter.markDirty('agents.all');
          emitter.flush();
          return { success: true };
        }

        // ─── Unknown ───────────────────────────────────────────────────────
        default:
          return { success: false, reason: `Unknown action type: ${(action as any).type}` };
      }
    }),
});
