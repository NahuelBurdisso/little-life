import { router, publicProcedure } from '../trpc';
import { db, sqlite } from '../db';
import { generateFromSliders } from '../lib/setupGenerator';
import { AGENT_SEEDS } from '../data/agents';
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
  shared_knowledge,
  agentStates,
  relationshipEvents,
  interactions,
  interactionParticipants,
  goals,
  aspirations,
  interactionCooldowns,
} from '../db/schema';
import { DEFAULT_MAP_WIDTH, DEFAULT_MAP_HEIGHT, generateLocationsForAgentCount, generateHomes, getPublicBuildings, generateCollisionGridForLocations } from '../data/maps';
import { CONVERSATION_TEMPLATES } from '../data/templates';
import { CONFIG } from '../lib/constants';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logActivity } from '../lib/activityLogger';
import { startTickLoop, stopTickLoopAndWait } from '../engine/tick';
import { taskRunner } from '../ai/taskRunner';
import { memoryService, reflectionTrigger, reflectionRunner, selfDescriptionGenerator } from '../lib/memory/instance';
import { planCache, planLLMQueue, replanEvaluator } from '../lib/planning/instance';
import { clearEffectivePersonalities, clearAgentStatesCache } from '../lib/states';
import { perceptionSystem } from '../lib/perception/instance';
import { emitter } from '../engine/emitter';
import { WorldGenConfigObjectSchema } from '../lib/worldgen/config';
import { generateWorld } from '../lib/worldgen';

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
  aspiration: z.object({
    type: z.string(),
    intensity: z.number(),
  }).optional(),
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

// Dynamic rules — accepts any key/value pairs from the config registry
const RulesConfigSchema = z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]));

const SetupConfigSchema = z.object({
  agents: z.array(AgentConfigSchema),
  relationships: z.array(RelationshipConfigSchema),
  world: WorldConfigSchema,
  rules: RulesConfigSchema,
  worldgen: WorldGenConfigObjectSchema.default({
    sizeTier: 'auto',
    overrides: {},
  }),
});

// ─── Table reset order (reverse-dependency) ───────────────────────────────────

const ALL_TABLES = [
  interactionCooldowns,
  interactionParticipants,
  interactions,
  goals,
  aspirations,
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
  shared_knowledge,
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

// ─── Helper: clear all tables ─────────────────────────────────────────────────

/** Clear all tables in reverse-dependency order */
function clearAllTables() {
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  for (const table of ALL_TABLES) {
    db.delete(table).run();
  }
  sqlite.exec('PRAGMA foreign_keys = ON;');
}

// ─── Helper: seed world from config ──────────────────────────────────────────

function seedWorld(config: z.infer<typeof SetupConfigSchema>): { agentCount: number; locationCount: number } {
  const now = Date.now();

  // 2. Generate locations dynamically — enough homes for all agent assignments
  let homesNeeded = Math.ceil(config.agents.length / 2);
  for (const agent of config.agents) {
    const match = agent.homeName.match(/Home (\d+)/);
    if (match) homesNeeded = Math.max(homesNeeded, Number(match[1]));
  }
  const dynamicLocations = generateLocationsForAgentCount(config.agents.length, homesNeeded);
  const homesRaw = generateHomes(homesNeeded);
  const publicRaw = getPublicBuildings();
  const allRawBuildings = [...homesRaw, ...publicRaw];
  const dynamicCollisionGrid = generateCollisionGridForLocations(allRawBuildings);

  const locationMap = new Map<string, number>();
  for (const loc of dynamicLocations) {
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

    const homeLoc = dynamicLocations.find((l) => l.name === agentCfg.homeName)!;
    const isAtWork =
      workplaceId !== null &&
      config.world.startHour >= agentCfg.schedule.workStart &&
      config.world.startHour < agentCfg.schedule.workEnd;

    const startLocationId = isAtWork ? workplaceId! : homeId;
    const startLoc = isAtWork
      ? dynamicLocations.find((l) => l.name === agentCfg.workplaceName)
      : homeLoc;
    const startAction = isAtWork
      ? { type: 'working', taskDescription: 'daily work' }
      : { type: 'idle' };

    // Prefer seed-defined sprite keys (match files in public/sprites/agents/).
    // Fallback: bare slug from name (strip non-alphanum, collapse repeats).
    const seedMatch = AGENT_SEEDS.find(s => s.name === agentCfg.name);
    const fallbackSlug = agentCfg.name
      .toLowerCase()
      .replace(/^dr\.?\s+/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const spriteSheet = seedMatch?.spriteSheet ?? fallbackSlug;
    const portraitSprite = seedMatch?.portraitSprite ?? `${fallbackSlug}_portrait`;

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

    // Insert aspiration for this agent
    const aspConfig = agentCfg.aspiration ?? { type: 'freedom', intensity: 0.5 };
    db.insert(aspirations).values({
      agent_id: inserted.id,
      type: aspConfig.type,
      intensity: aspConfig.intensity,
      status: 'active',
      adopted_at: 0,
      trigger: 'initial',
    }).run();
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
      money: (config.rules.startingMoney as number) ?? 50,
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
    const memCount = agentCfg.backstoryMemories.length;
    for (let i = 0; i < memCount; i++) {
      db.insert(memories).values({
        agent_id: agentId,
        description: agentCfg.backstoryMemories[i],
        type: 'experience',
        importance: 8,
        emotional_valence: 0.3,
        embedding: null,
        depth: 0,
        created_at: 0 - (memCount - i) * 1000,
        last_accessed: 0,
        metadata: { tags: ['backstory'] },
        is_active: 1,
        parent_ids: [],
      }).run();
    }
  }

  // 7b. Seed initial drama shared_knowledge (only if matching agents exist)
  const diegoId = agentMap.get('Diego Santos');
  const luciaId = agentMap.get('Lucia Fernandez');
  const marcoId = agentMap.get('Marco Rivera');
  const rosaId = agentMap.get('Rosa Chen');
  const carlosId = agentMap.get('Carlos Mendez');
  const rayId = agentMap.get('Ray Kowalski');

  if (diegoId && luciaId && marcoId && rosaId) {
    db.insert(shared_knowledge).values({
      type: 'crush', subject_id: diegoId, target_id: luciaId,
      content: 'Diego Santos has a crush on Lucia Fernandez',
      sensitivity: 2, known_by: [diegoId, marcoId],
      created_at: 0, is_active: true, source: 'backstory',
    }).run();
    db.insert(shared_knowledge).values({
      type: 'crush', subject_id: luciaId, target_id: diegoId,
      content: 'Lucia Fernandez has a crush on Diego Santos',
      sensitivity: 2, known_by: [luciaId, rosaId],
      created_at: 0, is_active: true, source: 'backstory',
    }).run();
  }

  if (carlosId && marcoId) {
    db.insert(shared_knowledge).values({
      type: 'financial', subject_id: carlosId, target_id: null,
      content: 'Carlos Mendez is struggling with money',
      sensitivity: 1, known_by: [carlosId, marcoId],
      created_at: 0, is_active: true, source: 'backstory',
    }).run();
  }

  if (rayId && marcoId) {
    db.insert(shared_knowledge).values({
      type: 'secret_told', subject_id: rayId, target_id: marcoId,
      content: 'Ray Kowalski told Marco he was forced out of the city police after a disciplinary hearing — he hit a suspect during interrogation',
      sensitivity: 3, known_by: [rayId, marcoId],
      created_at: 0, is_active: true, source: 'backstory',
    }).run();
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
    tick_speed: (config.rules.tickSpeed as number) ?? 1,
    is_paused: false,
    last_tick_completed: now,
    current_tick_phase: 0,
    tick_id: 'init',
    pending_transitions: [],
    tax_pool: 0,
    map_width: DEFAULT_MAP_WIDTH,
    map_height: DEFAULT_MAP_HEIGHT,
    collision_grid: dynamicCollisionGrid,
    setup_config: config as any,
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
  logActivity({
    type: 'system',
    templateData: { message: `Little Life begins. Day ${config.world.startDay}, ${seasonLabel} ${dayPhase}. ${agentMap.size} residents start their day.` },
  });

  return { agentCount: agentMap.size, locationCount: locationMap.size };
}

// ─── Helper: reload memory service caches ─────────────────────────────────────

/** Clear MemoryService caches so they reload lazily on next access. */
function reloadMemoryService() {
  memoryService.clear();
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const setupRouter = router({
  initialize: publicProcedure
    .input(SetupConfigSchema)
    .mutation(async ({ input }) => {
      clearAllTables();
      const result = seedWorld(input);
      return { ok: true, ...result };
    }),

  restart: publicProcedure.mutation(async () => {
    const world = db.select({ setup_config: worldState.setup_config }).from(worldState).limit(1).get();
    if (!world?.setup_config) {
      throw new Error('No saved setup config — use Reset to Wizard instead');
    }
    const config = SetupConfigSchema.parse(world.setup_config);

    await stopTickLoopAndWait();
    await Promise.race([
      taskRunner.drain(),
      new Promise(resolve => setTimeout(resolve, 10_000)),
    ]);
    taskRunner.resetSlots();

    clearAllTables();
    seedWorld(config);

    clearEffectivePersonalities();
    clearAgentStatesCache();
    reloadMemoryService();
    reflectionTrigger.clear();
    reflectionRunner.clearQueue();
    selfDescriptionGenerator.clear();
    planCache.clear();
    planLLMQueue.clear();
    replanEvaluator.clear();
    perceptionSystem.clear();
    startTickLoop();
    emitter.markAllDirty();
    emitter.flush();

    return { ok: true };
  }),

  generateDrama: publicProcedure
    .input(z.object({
      drama: z.number().min(0).max(10),
      romance: z.number().min(0).max(10),
      crime: z.number().min(0).max(10),
      trust: z.number().min(0).max(10),
    }))
    .query(({ input }) => {
      const agents = AGENT_SEEDS.map(seed => ({
        name: seed.name,
        age: seed.age,
        personality: seed.personality as Record<string, number>,
        salary: seed.salary,
        job: seed.job,
      }));
      return generateFromSliders(input, agents);
    }),

  resetToWizard: publicProcedure.mutation(async () => {
    await stopTickLoopAndWait();
    await Promise.race([
      taskRunner.drain(),
      new Promise(resolve => setTimeout(resolve, 10_000)),
    ]);
    taskRunner.resetSlots();

    clearAllTables();

    // Insert minimal worldState for wizard detection (totalTicks === 0, is_paused)
    db.insert(worldState).values({
      time: { day: 0, hour: 8, minute: 0, totalTicks: 0, seasonDay: 0, season: 'spring' },
      day_phase: 'morning',
      weather: 'clear',
      weather_duration: 6,
      tick_speed: 0,
      is_paused: true,
      last_tick_completed: 0,
      current_tick_phase: 0,
      tick_id: 'reset',
      pending_transitions: [],
      tax_pool: 0,
      map_width: DEFAULT_MAP_WIDTH,
      map_height: DEFAULT_MAP_HEIGHT,
      collision_grid: '',
      setup_config: null,
    }).run();

    // Minimal scheduler state
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

    clearEffectivePersonalities();
    clearAgentStatesCache();
    memoryService.clear();
    reflectionTrigger.clear();
    reflectionRunner.clearQueue();
    selfDescriptionGenerator.clear();
    planCache.clear();
    planLLMQueue.clear();
    replanEvaluator.clear();
    perceptionSystem.clear();

    // Do NOT restart tick loop — leave paused for wizard
    emitter.markAllDirty();
    emitter.flush();

    return { ok: true };
  }),
});
