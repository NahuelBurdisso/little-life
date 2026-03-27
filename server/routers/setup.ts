import { router, publicProcedure } from '../trpc';
import { db, sqlite } from '../db';
import {
  agents,
  needs,
  economy,
  relationships,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  memories,
  locations,
  worldState,
  worldEvents,
  templates,
  templateUsage,
  activityLog,
  economyTransactions,
  facts,
  agentStates,
  relationshipEvents,
} from '../db/schema';
import { LOCATIONS, MAP_WIDTH, MAP_HEIGHT, COLLISION_GRID } from '../data/maps';
import { CONVERSATION_TEMPLATES } from '../data/templates';
import { CONFIG } from '../lib/constants';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

// ─── Input schema ─────────────────────────────────────────────────────────────

const PersonalityConfigSchema = z.object({
  honesty: z.number(),
  aggression: z.number(),
  warmth: z.number(),
  impulsiveness: z.number(),
  vanity: z.number(),
  curiosity: z.number(),
  loyalty: z.number(),
  morality: z.number(),
  sensuality: z.number(),
  neuroticism: z.number(),
});

const ScheduleSchema = z.object({
  wakeTime: z.number(),
  sleepTime: z.number(),
  workStart: z.number(),
  workEnd: z.number(),
  lunchTime: z.number(),
  freeTimePreferences: z.array(z.string()),
});

const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number(),
  gender: z.string(),
  bio: z.string(),
  traits: z.array(z.string()),
  job: z.string(),
  jobTitle: z.string(),
  salary: z.number(),
  homeName: z.string(),
  workplaceName: z.string().nullable(),
  schedule: ScheduleSchema,
  personality: PersonalityConfigSchema,
  backstoryMemories: z.array(z.string()),
});

const RelationshipConfigSchema = z.object({
  agentAName: z.string(),
  agentBName: z.string(),
  friendshipAB: z.number(),
  friendshipBA: z.number(),
  romanceAB: z.number(),
  romanceBA: z.number(),
  trustAB: z.number(),
  trustBA: z.number(),
  familiarity: z.number(),
  status: z.string(),
  tags: z.array(z.string()),
});

const WorldConfigSchema = z.object({
  season: z.enum(['spring', 'summer', 'autumn', 'winter']),
  weather: z.string(),
  startHour: z.number(),
  startDay: z.number(),
});

const RulesConfigSchema = z.object({
  deathEnabled: z.boolean(),
  sicknessRate: z.enum(['off', 'low', 'medium', 'high']),
  contagionRate: z.enum(['off', 'low', 'medium', 'high']),
  dramaIntensity: z.enum(['low', 'medium', 'high', 'chaos']),
  startingMoney: z.number(),
  llmModel: z.string(),
  llmTemperature: z.number(),
  llmMaxTokens: z.number(),
  tickSpeed: z.number(),
});

const SetupConfigSchema = z.object({
  agents: z.array(AgentConfigSchema),
  relationships: z.array(RelationshipConfigSchema),
  world: WorldConfigSchema,
  rules: RulesConfigSchema,
});

// ─── Table reset order (reverse-dependency) ───────────────────────────────────

const ALL_TABLES = [
  activityLog,
  templateUsage,
  templates,
  worldEvents,
  worldState,
  memories,
  conversationSchedulerState,
  conversationQueue,
  conversations,
  relationshipEvents,
  relationships,
  economyTransactions,
  economy,
  facts,
  agentStates,
  needs,
  agents,
  locations,
] as const;

// ─── Helper: determine day phase from hour ────────────────────────────────────

function getDayPhase(hour: number): string {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const setupRouter = router({
  initialize: publicProcedure
    .input(SetupConfigSchema)
    .mutation(async ({ input }) => {
      const now = Date.now();
      const config = input;

      // 1. Reset all tables
      sqlite.exec('PRAGMA foreign_keys = OFF;');
      for (const table of ALL_TABLES) {
        db.delete(table).run();
      }
      sqlite.exec('PRAGMA foreign_keys = ON;');

      // 2. Insert locations, build name → ID map
      const locationMap = new Map<string, number>();
      for (const loc of LOCATIONS) {
        const inserted = db
          .insert(locations)
          .values({
            name: loc.name,
            type: loc.type,
            position: loc.position,
            entry_point: loc.entry_point,
            owner: null,
            capacity: loc.capacity,
            current_occupants: loc.current_occupants,
            operating_hours: loc.operating_hours,
            services: loc.services,
            description: loc.description,
          })
          .returning({ id: locations.id })
          .get();
        locationMap.set(loc.name, inserted.id);
      }

      // 3. Insert agents, build name → ID map
      const agentMap = new Map<string, number>();

      for (const agentCfg of config.agents) {
        const homeId = locationMap.get(agentCfg.homeName);
        if (homeId === undefined) {
          throw new Error(`Home location not found: ${agentCfg.homeName}`);
        }
        const workplaceId = agentCfg.workplaceName
          ? (locationMap.get(agentCfg.workplaceName) ?? null)
          : null;

        const homeLoc = LOCATIONS.find((l) => l.name === agentCfg.homeName)!;
        const isAtWork =
          workplaceId !== null &&
          config.world.startHour >= agentCfg.schedule.workStart &&
          config.world.startHour < agentCfg.schedule.workEnd;

        const startLocationId = isAtWork ? workplaceId! : homeId;
        const startLoc = isAtWork
          ? LOCATIONS.find((l) => l.name === agentCfg.workplaceName)
          : homeLoc;
        const startAction = isAtWork
          ? { type: 'working', taskDescription: 'daily work' }
          : { type: 'idle' };

        // Derive sprite names from agent name (fallback to generic)
        const nameSlug = agentCfg.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const spriteSheet = `sprites/${nameSlug}.png`;
        const portraitSprite = `portraits/${nameSlug}.png`;

        const inserted = db
          .insert(agents)
          .values({
            name: agentCfg.name,
            bio: agentCfg.bio,
            traits: agentCfg.traits,
            personality: agentCfg.personality,
            age: agentCfg.age,
            gender: agentCfg.gender,
            sprite_sheet: spriteSheet,
            portrait_sprite: portraitSprite,
            position: {
              x: startLoc?.entry_point.x ?? homeLoc.entry_point.x,
              y: startLoc?.entry_point.y ?? homeLoc.entry_point.y,
            },
            current_destination: null,
            current_location: startLocationId,
            current_action: startAction,
            action_started: 0,
            action_duration: null,
            action_queue: [],
            current_path: null,
            schedule: agentCfg.schedule,
            home: homeId,
            workplace: workplaceId,
            created_at: 0,
            is_active: true,
          })
          .returning({ id: agents.id })
          .get();

        agentMap.set(agentCfg.name, inserted.id);
      }

      // 4. Insert needs + economy for each agent
      for (const agentCfg of config.agents) {
        const agentId = agentMap.get(agentCfg.name)!;

        db.insert(needs).values({
          agent_id: agentId,
          hunger: 50 + Math.floor(Math.random() * 40),
          energy: 55 + Math.floor(Math.random() * 35),
          social: 30 + Math.floor(Math.random() * 40),
          comfort: 50 + Math.floor(Math.random() * 30),
          fun: 30 + Math.floor(Math.random() * 40),
          mood: 55 + Math.floor(Math.random() * 25),
          stress: 10 + Math.floor(Math.random() * 20),
          decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES },
          thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
          mood_modifiers: [],
          last_updated: 0,
        }).run();

        db.insert(economy).values({
          agent_id: agentId,
          job: agentCfg.job,
          job_title: agentCfg.jobTitle,
          salary: agentCfg.salary,
          work_performance: 70 + Math.floor(Math.random() * 20),
          money: config.rules.startingMoney,
          daily_expenses:
            CONFIG.ECONOMY.DAILY_EXPENSES.min +
            Math.floor(
              Math.random() *
                (CONFIG.ECONOMY.DAILY_EXPENSES.max - CONFIG.ECONOMY.DAILY_EXPENSES.min)
            ),
          inventory: [],
          last_payday: 0,
          production_remainder: 0,
        }).run();
      }

      // 5. Set location owners — map job-based workplaces to their agent owners
      //    Ownership: whichever agent's workplaceName matches a location and their
      //    job is an "owner-type" job (shopkeeper, doctor, mayor, farmer, baker,
      //    bartender, handyperson, constable, retired).
      const ownerJobs = new Set([
        'shopkeeper', 'doctor', 'mayor', 'farmer', 'baker',
        'bartender', 'handyperson', 'constable', 'retired',
      ]);

      for (const agentCfg of config.agents) {
        if (agentCfg.workplaceName && ownerJobs.has(agentCfg.job)) {
          const locId = locationMap.get(agentCfg.workplaceName);
          const ownerId = agentMap.get(agentCfg.name);
          if (locId !== undefined && ownerId !== undefined) {
            // Only set owner if not already taken
            const existing = db
              .select({ owner: locations.owner })
              .from(locations)
              .where(eq(locations.id, locId))
              .get();
            if (existing && existing.owner === null) {
              db.update(locations)
                .set({ owner: ownerId })
                .where(eq(locations.id, locId))
                .run();
            }
          }
        }
      }

      // 6. Insert relationships from config
      for (const relCfg of config.relationships) {
        const agentAId = agentMap.get(relCfg.agentAName);
        const agentBId = agentMap.get(relCfg.agentBName);
        if (agentAId === undefined || agentBId === undefined) continue;

        db.insert(relationships).values({
          agent_a: agentAId,
          agent_b: agentBId,
          friendship_ab: relCfg.friendshipAB,
          friendship_ba: relCfg.friendshipBA,
          romance_ab: relCfg.romanceAB,
          romance_ba: relCfg.romanceBA,
          trust_ab: relCfg.trustAB,
          trust_ba: relCfg.trustBA,
          familiarity: relCfg.familiarity,
          interaction_count: 0,
          last_interaction: 0,
          average_interaction_sentiment: 0,
          tags: relCfg.tags,
          status: relCfg.status,
          created_at: 0,
          last_updated: 0,
        }).run();
      }

      // 7. Insert backstory memories from each agent's backstoryMemories
      for (const agentCfg of config.agents) {
        const agentId = agentMap.get(agentCfg.name)!;
        for (const memContent of agentCfg.backstoryMemories) {
          db.insert(memories).values({
            agent_id: agentId,
            content: memContent,
            type: 'backstory',
            importance: 6,
            emotional_valence: 0,
            embedding: null,
            related_agents: [],
            related_location: null,
            tags: ['backstory'],
            timestamp: 0,
            access_count: 0,
            last_accessed: 0,
          }).run();
        }
      }

      // 8. Insert conversation templates
      for (const tmpl of CONVERSATION_TEMPLATES) {
        db.insert(templates).values({
          category: tmpl.category,
          conditions: tmpl.conditions,
          variants: tmpl.variants,
          cooldown_per_pair: tmpl.cooldownPerPair,
        }).run();
      }

      // 9. Create worldState with rules embedded in time JSON
      const startHour = config.world.startHour;
      const dayPhase = getDayPhase(startHour);

      db.insert(worldState).values({
        time: {
          day: config.world.startDay,
          hour: startHour,
          minute: 0,
          totalTicks: 0,
          seasonDay: config.world.startDay,
          season: config.world.season,
          // Rules embedded so the simulation engine can read them
          rules: config.rules,
        } as any,
        day_phase: dayPhase,
        weather: config.world.weather,
        weather_duration: 6,
        tick_speed: config.rules.tickSpeed,
        is_paused: false,
        last_tick_completed: now,
        current_tick_phase: 0,
        tick_id: 'init',
        pending_transitions: [],
        tax_pool: 0,
        map_width: MAP_WIDTH,
        map_height: MAP_HEIGHT,
        collision_grid: COLLISION_GRID,
      }).run();

      // 10. Create conversationSchedulerState singleton
      db.insert(conversationSchedulerState).values({
        active_llm_conversations: [],
        max_concurrent_llm: CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM,
        max_queue_size: CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE,
        max_turns_deep: CONFIG.CONVERSATIONS.MAX_TURNS_DEEP,
        max_turns_standard: CONFIG.CONVERSATIONS.MAX_TURNS_STANDARD,
        template_fallback_after_ms: CONFIG.CONVERSATIONS.TEMPLATE_FALLBACK_MS,
        stats: {
          llmConversationsTotal: 0,
          templateConversationsTotal: 0,
          averageResponseTimeMs: 0,
          queueTimeoutsTotal: 0,
        },
      }).run();

      // 11. Create initial activity log entry
      const seasonLabel =
        config.world.season.charAt(0).toUpperCase() + config.world.season.slice(1);
      db.insert(activityLog).values({
        type: 'system',
        message: `Little Life begins. Day ${config.world.startDay}, ${seasonLabel} ${dayPhase}. ${agentMap.size} residents start their day.`,
        agent_ids: [],
        timestamp: 0,
        real_timestamp: now,
      }).run();

      return { ok: true, agentCount: agentMap.size, locationCount: locationMap.size };
    }),
});
