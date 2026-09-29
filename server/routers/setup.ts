import { router, publicProcedure } from '../trpc';
import { db, sqlite } from '../db';
import { generateFromSliders } from '../lib/setupGenerator';
import { forkRng } from '../lib/worldgen/rng';
import { clamp } from '../lib/utils';
import { AGENT_SEEDS } from '../data/agents';
import {
  agents,
  needs,
  economy,
  relationships,
  conversationSchedulerState,
  memories,
  locations,
  worldState,
  templates,
  shared_knowledge,
  aspirations,
} from '../db/schema';
import { ALL_TABLES } from '../db/worldTables';
import { MIN_WIDTH, MIN_HEIGHT, MAX_AGENTS } from '../lib/worldgen/config';
import { CONVERSATION_TEMPLATES } from '../data/templates';
import { CONFIG } from '../lib/constants';
import { startingTreasury, moneyTargetFor } from '../lib/townTreasury';
import { queueMaxWait } from '../lib/conversationPacing';
import { gameMinutes } from '../lib/gameClock';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logActivity } from '../lib/activityLogger';
import { startTickLoop, stopTickLoopAndWait } from '../engine/tick';
import { taskRunner } from '../ai/taskRunner';
import { emitter } from '../engine/emitter';
import { WorldGenConfigObjectSchema } from '../lib/worldgen/config';
import { generateWorld } from '../lib/worldgen';
import { buildSocialEdges } from '../lib/worldgen/social';
import { buildStartingTies } from '../lib/startingTies';
import { startingNeeds } from '../lib/startingNeeds';
import { saveWorldCaches } from '../engine/worldCaches';
import { resetWorldRuntime } from '../engine/worldRuntime';

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
  wakeTime: z.number().int().min(0).max(23),
  sleepTime: z.number().int().min(0).max(23),
  workStart: z.number().int().min(0).max(23),
  workEnd: z.number().int().min(0).max(23),
  lunchTime: z.number().int().min(0).max(23),
  freeTimePreferences: z.array(z.string()),
});

const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  age: z.number().int().min(16).max(99),
  gender: z.string(),
  bio: z.string().max(500),
  traits: z.array(z.string().max(30)).max(8),
  job: z.string().min(1),
  jobTitle: z.string().min(1).max(50),
  salary: z.number().min(0).max(500),
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
  agentAName: z.string().min(1),
  agentBName: z.string().min(1),
  friendshipAB: z.number().min(-100).max(100),
  friendshipBA: z.number().min(-100).max(100),
  romanceAB: z.number().min(0).max(100),
  romanceBA: z.number().min(0).max(100),
  trustAB: z.number().min(-100).max(100),
  trustBA: z.number().min(-100).max(100),
  familiarity: z.number().min(0).max(100),
  status: z.string(),
  tags: z.array(z.string()),
});

const WorldConfigSchema = z.object({
  season: z.enum(['spring', 'summer', 'autumn', 'winter']),
  weather: z.enum(['sunny', 'cloudy', 'rainy', 'stormy', 'foggy', 'snowy', 'windy', 'hot']),
  startHour: z.number().int().min(0).max(23),
  startDay: z.number().int().min(1).max(28),
});

// Dynamic rules — accepts any key/value pairs from the config registry
const RulesConfigSchema = z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]));

/**
 * The wizard's drama/romance/crime/trust sliders, on the 0-100 scale the UI
 * uses. `generateFromSliders` works on 0-10, so `seedWorld` divides.
 *
 * Optional: `restart` replays a `setup_config` saved before this field existed,
 * and the schema is also what the Start button posts.
 */
const ScenarioSlidersSchema = z.object({
  drama: z.number().min(0).max(100),
  romance: z.number().min(0).max(100),
  crime: z.number().min(0).max(100),
  trust: z.number().min(0).max(100),
  /**
   * Its own seed rather than the worldgen one: the Preview step runs before the
   * World Layout step, so at preview time `worldgen.seed` may still be
   * unresolved and Start would then build a different scenario than the one the
   * player was shown.
   */
  seed: z.string().min(1).max(64),
});

const SetupConfigSchema = z.object({
  agents: z.array(AgentConfigSchema),
  relationships: z.array(RelationshipConfigSchema),
  world: WorldConfigSchema,
  rules: RulesConfigSchema,
  scenario: ScenarioSlidersSchema.optional(),
  worldgen: WorldGenConfigObjectSchema.default({
    sizeTier: 'auto',
    overrides: {},
    socialPlacement: true,
    // Spelled out because an outer `.default()` does not run the inner schema's
    // defaults — without it a config posted with no `worldgen` would carry no
    // `layoutStyle` at all. Grid, like every world saved before the option.
    layoutStyle: 'grid',
  }),
});

/**
 * What social home placement reads from an agent — the first of the lenient
 * agent shapes `previewWorld` validates against, instead of the full
 * `AgentConfigSchema`. The preview runs on every wizard edit, and validating the
 * whole config there turned an unrelated field — a blank or 501-character bio —
 * into a raw Zod error on the World Layout step, which the wizard then held on
 * to as a Start blocker. The preview only needs what it reads; `initialize`
 * still validates everything.
 */
const PlacementAgentSchema = z.object({
  // Same bounds as AgentConfigSchema.name: an agent the preview places is one
  // Start can seed.
  name: z.string().min(1).max(50),
  homeName: z.string(),
  workplaceName: z.string().nullable().optional(),
});
/** Plus what `buildScenario` reads, typed like `AgentConfigSchema` on these
 *  fields (so a well-typed cast builds the same scenario `initialize` would);
 *  their bounds are left to `initialize`. */
const ScenarioAgentSchema = PlacementAgentSchema.extend({
  age: z.number(),
  salary: z.number(),
  job: z.string(),
  personality: PersonalityConfigSchema,
});
/**
 * The wire shape: `homeName` (the homes-only fallback needs it) plus every field
 * the two schemas above read, unvalidated — each is checked by `safeParse` in
 * the handler. Everything else the wizard sends is stripped.
 */
const PreviewAgentInputSchema = z.object({
  homeName: z.string(),
  name: z.unknown(),
  workplaceName: z.unknown(),
  age: z.unknown(),
  salary: z.unknown(),
  job: z.unknown(),
  personality: z.unknown(),
});
/** What `buildSocialEdges` reads from a relationship row. */
const PlacementRelationshipSchema = RelationshipConfigSchema.pick({
  agentAName: true,
  agentBName: true,
  friendshipAB: true,
  friendshipBA: true,
  romanceAB: true,
  romanceBA: true,
  status: true,
  tags: true,
});

// ─── Table reset order: `ALL_TABLES` in db/worldTables.ts (shared with lib/saves.ts) ───

// ─── Helper: job-based starting money ────────────────────────────────────────

const JOB_STARTING_MONEY: Record<string, number> = {
  farmer: 80, farmhand: 40, bartender: 60, shopkeeper: 120,
  retired: 90, doctor: 100, medical_assistant: 55, mayor: 150,
  baker: 65, handyperson: 25, shop_assistant: 35, musician: 20,
  constable: 70,
};

function getJobStartingMoney(job: string, defaultMoney: number): number {
  return JOB_STARTING_MONEY[job] ?? defaultMoney;
}

const JOB_STARTING_INVENTORY: Record<string, Array<{ itemId: string; quantity: number; acquiredAt: number }>> = {
  farmer: [{ itemId: 'food_raw', quantity: 10, acquiredAt: 0 }],
  farmhand: [{ itemId: 'food_raw', quantity: 3, acquiredAt: 0 }],
  shopkeeper: [{ itemId: 'food_prepared', quantity: 5, acquiredAt: 0 }, { itemId: 'food_raw', quantity: 8, acquiredAt: 0 }],
  doctor: [{ itemId: 'medicine', quantity: 4, acquiredAt: 0 }],
  medical_assistant: [{ itemId: 'medicine', quantity: 2, acquiredAt: 0 }],
  baker: [{ itemId: 'food_raw', quantity: 6, acquiredAt: 0 }, { itemId: 'food_prepared', quantity: 4, acquiredAt: 0 }],
  bartender: [{ itemId: 'drink', quantity: 8, acquiredAt: 0 }, { itemId: 'food_raw', quantity: 3, acquiredAt: 0 }],
};

function getJobStartingInventory(job: string): Array<{ itemId: string; quantity: number; acquiredAt: number }> {
  return JOB_STARTING_INVENTORY[job] ?? [];
}

// ─── Helper: determine day phase from hour ────────────────────────────────────

function getDayPhase(hour: number): string {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

// ─── Helper: clear all tables ─────────────────────────────────────────────────

/** Delete every row in reverse-dependency order. The caller owns the
 *  `foreign_keys` pragma, which SQLite ignores inside a transaction — so this is
 *  split out for `replaceWorld`, which needs the delete to be part of one. */
function deleteAllRows() {
  for (const table of ALL_TABLES) {
    db.delete(table).run();
  }
}

/** Clear all tables in reverse-dependency order */
export function clearAllTables() {
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  try {
    deleteAllRows();
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON;');
  }
}

// ─── Helper: scenario generation ─────────────────────────────────────────────

/**
 * Run the drama generator for a wizard config. Shared by `seedWorld` and the
 * `generateDrama` preview endpoint so the preview cannot drift from what Start
 * actually builds — they must stay a single call site with the same inputs.
 *
 * The UI sliders are 0-100; `generateFromSliders` is specified on 0-10.
 */
function buildScenario(
  scenario: z.infer<typeof ScenarioSlidersSchema>,
  agents: ReadonlyArray<z.infer<typeof ScenarioAgentSchema>>,
) {
  return generateFromSliders(
    {
      drama: scenario.drama / 10,
      romance: scenario.romance / 10,
      crime: scenario.crime / 10,
      trust: scenario.trust / 10,
    },
    agents.map((a) => ({
      name: a.name,
      age: a.age,
      personality: a.personality as unknown as Record<string, number>,
      salary: a.salary,
      job: a.job,
    })),
    forkRng(scenario.seed, 'scenario').next,
  );
}

/**
 * The worldgen `social` option for a wizard config: the relationship graph —
 * config rows plus the scenario's romance threads and rival pairs — as named
 * edges for the homes stage. Shared by `replaceWorld` and `previewWorld` so the
 * World Layout preview places households exactly as Start will.
 */
function buildWorldgenSocial(
  agents: ReadonlyArray<{ name: string; homeName: string }>,
  relationships: ReadonlyArray<z.infer<typeof PlacementRelationshipSchema>>,
  scenario: ReturnType<typeof buildScenario> | null,
) {
  return { edges: buildSocialEdges(relationships, scenario, agents) };
}

/** Whether a raw, unparsed `setup_config` states `worldgen.socialPlacement`. */
function hasSocialPlacementKey(raw: unknown): boolean {
  const worldgen = (raw as { worldgen?: unknown } | null)?.worldgen;
  return typeof worldgen === 'object' && worldgen !== null && 'socialPlacement' in worldgen;
}

// ─── Helper: seed world from config ──────────────────────────────────────────

/**
 * Persist `config` plus an already-generated world.
 *
 * `genResult` is a parameter rather than something this function produces,
 * because `generateWorld` throws (unfittable content, dimensions cap) and every
 * caller clears the database first — so generating in here meant a failed
 * generation left an empty database behind. `replaceWorld` now generates before
 * it destroys anything.
 */
function seedWorld(
  config: z.infer<typeof SetupConfigSchema>,
  genResult: ReturnType<typeof generateWorld>,
  /**
   * The scenario the sliders describe: secrets, romance threads, rivalries,
   * starting money and starting mood — `buildScenario(config.scenario,
   * config.agents)`, or null when no sliders were posted. Seeded, so the
   * wizard's Preview step, the Start that follows it and any later `restart` of
   * the saved config all produce the same town. Indices below are positions in
   * `config.agents`, which is exactly the array handed to the generator.
   *
   * A parameter because `replaceWorld` needs it *before* generating the world
   * (its romance threads and rivalries decide who lives next to whom), and
   * building it twice would be two chances for the placement and the seeded
   * relationships to disagree.
   */
  scenario: ReturnType<typeof buildScenario> | null,
): { agentCount: number; locationCount: number } {
  const now = Date.now();

  const dynamicLocations = genResult.locations;
  const dynamicCollisionGrid = genResult.collisionGrid;

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
  /** Who starts inside each location, flushed to `current_occupants` after the loop. */
  const startOccupants = new Map<number, number[]>();

  for (const agentCfg of config.agents) {
    const homeId = locationMap.get(agentCfg.homeName);
    if (homeId === undefined) {
      throw new Error(`Home location not found: ${agentCfg.homeName}`);
    }
    const workplaceId = agentCfg.workplaceName
      ? (locationMap.get(agentCfg.workplaceName) ?? null)
      : null;

    const homeLoc = dynamicLocations.find((l) => l.name === agentCfg.homeName)!;
    // Shift windows may wrap past midnight. `ScheduleSchema` bounds workStart and
    // workEnd to 0-23 with no ordering constraint, so a night shift — the natural
    // configuration for The Dive, whose operating hours are 18→2 — made
    // `start >= 18 && start < 2` unsatisfiable and always spawned the agent at
    // home. No shipped agent has workStart > workEnd, so this is latent, but the
    // wizard lets the user create one.
    const { workStart, workEnd } = agentCfg.schedule;
    const h = config.world.startHour;
    const withinShift = workStart <= workEnd
      ? h >= workStart && h < workEnd
      : h >= workStart || h < workEnd;
    const isAtWork = workplaceId !== null && withinShift;

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
    startOccupants.set(startLocationId, [
      ...(startOccupants.get(startLocationId) ?? []),
      inserted.id,
    ]);

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

  // 3b. Register the starting occupants.
  //
  // Worldgen emits every location with `current_occupants: []`, and movement.ts
  // only maintains the list on a location *change* — so until an agent first
  // walked somewhere else, every building in a freshly seeded world reported
  // itself as empty while agents were standing in it. Anything reading occupancy
  // (the location panel, the loneliness check in states.ts, the crowding metrics
  // in autoplay) saw a ghost town for the first stretch of every new game.
  for (const [locationId, occupantIds] of startOccupants) {
    db.update(locations)
      .set({ current_occupants: occupantIds })
      .where(eq(locations.id, locationId))
      .run();
  }

  // 4. Insert needs + economy for each agent
  for (let agentIdx = 0; agentIdx < config.agents.length; agentIdx++) {
    const agentCfg = config.agents[agentIdx];
    const agentId = agentMap.get(agentCfg.name)!;
    const scenarioMood = scenario?.moodAdjustments[agentIdx];

    db.insert(needs).values({
      agent_id: agentId,
      ...startingNeeds(),
      mood: scenarioMood?.mood ?? 55 + Math.floor(Math.random() * 25),
      stress: scenarioMood?.stress ?? 10 + Math.floor(Math.random() * 20),
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
      // The crime slider decides inequality: it flattens everyone toward 60-80
      // at low crime and pulls the tails apart at high crime. Falls back to the
      // job table when no scenario was posted.
      money:
        scenario?.economyAdjustments[agentIdx] ??
        getJobStartingMoney(agentCfg.job, (config.rules.startingMoney as number) ?? 50),
      daily_expenses:
        CONFIG.ECONOMY.DAILY_EXPENSES.min +
        Math.floor(
          Math.random() *
            (CONFIG.ECONOMY.DAILY_EXPENSES.max - CONFIG.ECONOMY.DAILY_EXPENSES.min)
        ),
      inventory: getJobStartingInventory(agentCfg.job),
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

  // 6. Insert relationships from config, with the scenario folded in.
  //
  // Rows are staged in a map first because the scenario's trust delta, romance
  // threads and rival pairs all edit pairs that may or may not appear in
  // `config.relationships`, and `idx_relationships_pair` is unique — a second
  // INSERT for the same pair would throw and roll the whole seed back.
  interface StagedRel {
    agent_a: number;
    agent_b: number;
    friendship_ab: number;
    friendship_ba: number;
    romance_ab: number;
    romance_ba: number;
    trust_ab: number;
    trust_ba: number;
    familiarity: number;
    tags: string[];
    status: string;
  }
  const staged = new Map<string, StagedRel>();
  const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

  /**
   * Fetch or create the row for a pair, always stored with `agent_a < agent_b`.
   * Every reader normalises with Math.min/Math.max before querying, so a row
   * stored the other way round is invisible to the engine.
   */
  const relFor = (x: number, y: number): StagedRel => {
    const key = pairKey(x, y);
    const existing = staged.get(key);
    if (existing) return existing;
    const fresh: StagedRel = {
      agent_a: Math.min(x, y),
      agent_b: Math.max(x, y),
      friendship_ab: 0,
      friendship_ba: 0,
      romance_ab: 0,
      romance_ba: 0,
      trust_ab: 0,
      trust_ba: 0,
      familiarity: 5,
      tags: [],
      status: 'acquaintance',
    };
    staged.set(key, fresh);
    return fresh;
  };

  // 6a. Structural ties first: housemates, coworkers and next-door neighbours
  //     already know each other (lib/startingTies.ts has the why). Staged before
  //     the authored rows so those overwrite the values, and before the scenario
  //     so the trust slider calibrates these too and a scenario rivalry can
  //     still sour a household.
  const homeDoors = new Map<string, { x: number; y: number }>();
  for (const loc of dynamicLocations) {
    if (loc.type === 'home') homeDoors.set(loc.name, loc.entry_point);
  }
  const structuralTags = new Map<string, string[]>();
  for (const tie of buildStartingTies(config.agents, homeDoors)) {
    const aId = agentMap.get(tie.a);
    const bId = agentMap.get(tie.b);
    if (aId === undefined || bId === undefined) continue;
    const row = relFor(aId, bId);
    const flipped = aId > bId;
    row.friendship_ab = flipped ? tie.friendshipBA : tie.friendshipAB;
    row.friendship_ba = flipped ? tie.friendshipAB : tie.friendshipBA;
    row.trust_ab = flipped ? tie.trustBA : tie.trustAB;
    row.trust_ba = flipped ? tie.trustAB : tie.trustBA;
    row.familiarity = tie.familiarity;
    row.status = tie.status;
    row.tags = [...tie.tags];
    structuralTags.set(pairKey(aId, bId), tie.tags);
  }

  // 6b. Authored rows (wizard / saved config). Their values win outright; only
  //     the structural tags are kept alongside theirs, since "they share a house"
  //     is still true of two rivals.
  for (const relCfg of config.relationships) {
    const agentAId = agentMap.get(relCfg.agentAName);
    const agentBId = agentMap.get(relCfg.agentBName);
    if (agentAId === undefined || agentBId === undefined) continue;

    const row = relFor(agentAId, agentBId);
    // `*AB` in the config means "A's feeling toward B". If the config listed the
    // pair in the opposite order to the canonical one, the directional halves
    // swap with it.
    const flipped = agentAId > agentBId;
    row.friendship_ab = flipped ? relCfg.friendshipBA : relCfg.friendshipAB;
    row.friendship_ba = flipped ? relCfg.friendshipAB : relCfg.friendshipBA;
    row.romance_ab = flipped ? relCfg.romanceBA : relCfg.romanceAB;
    row.romance_ba = flipped ? relCfg.romanceAB : relCfg.romanceBA;
    row.trust_ab = flipped ? relCfg.trustBA : relCfg.trustAB;
    row.trust_ba = flipped ? relCfg.trustAB : relCfg.trustBA;
    row.familiarity = relCfg.familiarity;
    row.tags = [...new Set([...relCfg.tags, ...(structuralTags.get(pairKey(agentAId, agentBId)) ?? [])])];
    row.status = relCfg.status;
  }

  if (scenario) {
    const idOf = (agentIdx: number): number | undefined =>
      agentMap.get(config.agents[agentIdx]?.name ?? '');

    /** Write a directional field, respecting canonical pair order. */
    const setDirectional = (
      row: StagedRel,
      from: number,
      field: 'friendship' | 'romance' | 'trust',
      apply: (current: number) => number,
    ) => {
      const key = (from === row.agent_a ? `${field}_ab` : `${field}_ba`) as keyof StagedRel;
      (row[key] as number) = apply(row[key] as number);
    };

    // The trust slider shifts the whole town's baseline, so it only touches
    // pairs that already exist — it is a calibration, not a relationship source.
    if (scenario.trustDelta !== 0) {
      for (const row of staged.values()) {
        row.trust_ab = clamp(row.trust_ab + scenario.trustDelta, -100, 100);
        row.trust_ba = clamp(row.trust_ba + scenario.trustDelta, -100, 100);
      }
    }

    for (const thread of scenario.romanceThreads) {
      for (const rv of thread.romance_values) {
        const from = idOf(rv.from);
        const to = idOf(rv.to);
        if (from === undefined || to === undefined || from === to) continue;
        const row = relFor(from, to);
        setDirectional(row, from, 'romance', () => clamp(rv.value, 0, 100));
        row.familiarity = Math.max(row.familiarity, 40);
        if (!row.tags.includes('romantic')) row.tags.push('romantic');
      }
      for (const fd of thread.friendship_deltas) {
        const from = idOf(fd.from);
        const to = idOf(fd.to);
        if (from === undefined || to === undefined || from === to) continue;
        setDirectional(relFor(from, to), from, 'friendship', (c) => clamp(c + fd.delta, -100, 100));
      }
      for (const td of thread.trust_deltas) {
        const from = idOf(td.from);
        const to = idOf(td.to);
        if (from === undefined || to === undefined || from === to) continue;
        setDirectional(relFor(from, to), from, 'trust', (c) => clamp(c + td.delta, -100, 100));
      }
    }

    for (const [ai, bi] of scenario.rivalPairs) {
      const a = idOf(ai);
      const b = idOf(bi);
      if (a === undefined || b === undefined || a === b) continue;
      const row = relFor(a, b);
      row.friendship_ab = clamp(Math.min(row.friendship_ab, -35), -100, 100);
      row.friendship_ba = clamp(Math.min(row.friendship_ba, -35), -100, 100);
      row.trust_ab = clamp(Math.min(row.trust_ab, -30), -100, 100);
      row.trust_ba = clamp(Math.min(row.trust_ba, -30), -100, 100);
      row.familiarity = Math.max(row.familiarity, 45);
      row.status = 'rival';
      if (!row.tags.includes('rival')) row.tags.push('rival');
    }
  }

  for (const row of staged.values()) {
    db.insert(relationships).values({
      ...row,
      interaction_count: 0,
      // Wall-clock column (Date.now()); decay reads the game-minute one below.
      last_interaction: now,
      // The decay clock: game time, starting with the world (inserted below).
      last_interaction_minute: gameMinutes({ day: config.world.startDay, hour: config.world.startHour, minute: 0 }),
      average_interaction_sentiment: 0,
      created_at: now,
      last_updated: now,
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
      created_at: now, is_active: true, source: 'backstory',
    }).run();
    db.insert(shared_knowledge).values({
      type: 'crush', subject_id: luciaId, target_id: diegoId,
      content: 'Lucia Fernandez has a crush on Diego Santos',
      sensitivity: 2, known_by: [luciaId, rosaId],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  if (carlosId && marcoId) {
    db.insert(shared_knowledge).values({
      type: 'financial', subject_id: carlosId, target_id: null,
      content: 'Carlos Mendez is struggling with money',
      sensitivity: 1, known_by: [carlosId, marcoId],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  if (rayId && marcoId) {
    db.insert(shared_knowledge).values({
      type: 'secret_told', subject_id: rayId, target_id: marcoId,
      content: 'Ray Kowalski told Marco he was forced out of the city police after a disciplinary hearing — he hit a suspect during interrogation',
      sensitivity: 3, known_by: [rayId, marcoId],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  // 7c. Scenario secrets. The block above is keyed to the default cast's names
  // and produces nothing for an edited or renamed town; these come from the
  // drama/crime sliders and work for any cast.
  if (scenario) {
    const idOfAgent = (agentIdx: number | null): number | undefined =>
      agentIdx === null ? undefined : agentMap.get(config.agents[agentIdx]?.name ?? '');

    const scenarioSecrets = [
      ...scenario.secrets,
      ...scenario.romanceThreads.flatMap((t) => (t.secret ? [t.secret] : [])),
    ];

    for (const secret of scenarioSecrets) {
      const subjectId = idOfAgent(secret.subject_index);
      if (subjectId === undefined) continue;
      const targetId = idOfAgent(secret.target_index) ?? null;

      const knownBy = [
        ...new Set(
          secret.known_by_indices
            .map((i) => idOfAgent(i))
            .filter((id): id is number => id !== undefined),
        ),
      ];
      // The generator decides who knows (setupGenerator.ts): for a sighting —
      // "A saw B sneaking out" — the fact is about B and only A knows, so B must
      // NOT be added here. This used to push the subject unconditionally, which
      // told every person who was seen that they had been seen (B17). Only a
      // secret nobody would know falls back to its subject.
      if (knownBy.length === 0) knownBy.push(subjectId);

      db.insert(shared_knowledge).values({
        type: secret.type,
        subject_id: subjectId,
        target_id: targetId,
        content: secret.content,
        sensitivity: secret.sensitivity,
        known_by: knownBy,
        // `now`, not 0: gossipTick expires theft/rumor/seduction/confession on
        // `Date.now() - created_at`, so a 0 here deactivates the secret on the
        // first pass — it reads as ~57 years old.
        created_at: now,
        is_active: true,
        source: 'backstory',
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

  // 9. Create worldState. The rules are read back from `setup_config` (below),
  // through lib/worldRules.ts: a copy in the clock JSON would not survive the
  // first tick, which rebuilds `time` field by field.
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
    },
    day_phase: dayPhase,
    weather: config.world.weather,
    weather_duration: 6,
    tick_speed: (config.rules.tickSpeed as number) ?? 1,
    is_paused: false,
    last_tick_completed: now,
    current_tick_phase: 0,
    tick_id: 'init',
    pending_transitions: [],
    // The town's opening reserve (townTreasury.ts): wages are paid from it.
    tax_pool: startingTreasury(config.agents.length, CONFIG.ECONOMY.TREASURY_START_PER_CAPITA),
    // The residents' economy rows were written above (every table was cleared).
    money_target_per_capita: moneyTargetFor(
      db.select({ money: economy.money }).from(economy).all().map((e) => e.money),
      CONFIG.ECONOMY.MONEY_TARGET_RANGE,
    ),
    map_width: genResult.dimensions.width,
    map_height: genResult.dimensions.height,
    collision_grid: dynamicCollisionGrid,
    road_tiles: genResult.roads,
    terrain_tiles: genResult.terrainTiles,
    setup_config: config as any,
  }).run();

  // 10. Create conversationSchedulerState singleton
  db.insert(conversationSchedulerState).values({
    active_llm_conversations: [],
    max_concurrent_llm: CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM,
    max_queue_size: CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE,
    max_turns_deep: CONFIG.CONVERSATIONS.MAX_TURNS_DEEP,
    max_turns_standard: CONFIG.CONVERSATIONS.MAX_TURNS_STANDARD,
    template_fallback_after_ms: queueMaxWait(CONFIG.CONVERSATIONS.QUEUE_MAX_WAIT_GAME_MINUTES),
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

/**
 * Tear the running world down, seed a new one from `config`, and start it.
 *
 * `initialize` and `restart` both replace the world wholesale, and both have to
 * do the same eleven things to do it safely. `initialize` did two of them —
 * `clearAllTables()` and `seedWorld()` — so the world the wizard's Start button
 * generated was persisted correctly and then never ticked: `resetToWizard`
 * deliberately leaves the loop stopped on the way in, and nothing started it
 * again. `nudge.setPaused` only flips a DB column, and nothing reads that column
 * while the loop is down, so the only ways out were the TopBar Restart button
 * and a server restart. It never reproduced from a cold boot, because
 * `server/index.ts` starts the loop and nothing had stopped it.
 *
 * It also skipped every cache clear, which matters for the same reason it
 * matters in `restart`: `invalidateCostMap` in particular guards a map keyed on
 * season alone, which is read out of range when the new world has a different
 * size.
 *
 * Failure used to be unrecoverable. `clearAllTables()` ran first and
 * `startTickLoop()` last, so anything that threw in between — `generateWorld`
 * on unfittable content, or the `Home location not found` guard in `seedWorld` —
 * left an empty database with no `worldState` row and a permanently stopped tick
 * loop. Since `initialize` routes through here too, a first-run failure bricked
 * the app. Three things now prevent that:
 *   1. the world is generated *before* anything is destroyed, and from inside
 *      the `try`, so a worldgen throw still runs the recovery in the `finally`;
 *   2. the clear and the seed are one sqlite transaction, so a mid-seed throw
 *      rolls back to the previous world rather than half a new one;
 *   3. the tick loop restarts from a `finally`.
 */
async function replaceWorld(
  config: z.infer<typeof SetupConfigSchema>,
): Promise<{ agentCount: number; locationCount: number }> {
  await stopTickLoopAndWait();
  await Promise.race([
    taskRunner.drain(),
    new Promise(resolve => setTimeout(resolve, 10_000)),
  ]);
  taskRunner.resetSlots();
  // Checkpoint the outgoing world's in-memory state (never throws). On success
  // the rows are wiped with the world; on a rolled-back seed they come back
  // with it, and `restoreWorldCaches` below reloads them — so a failed replace
  // no longer costs the old world its hobbies, favors, tension and the rest.
  saveWorldCaches();

  try {
    // Generate first: this is the throwing step, and the database is still
    // intact if it does, so the caller gets the worldgen error and keeps its old
    // world. It has to sit *inside* the `try` — the tick loop is already stopped
    // and the task runner already reset by this point, so a throw from out here
    // skipped the `finally` entirely and left the simulation permanently frozen
    // against the old world with no client signal. Since `initialize` routes
    // through here, that bricked the app on a first-run worldgen failure.
    //
    // The scenario is built first because worldgen needs it: its romance
    // threads and rival pairs are part of the relationship graph the homes
    // stage places households by. The same object is then seeded below.
    const scenario = config.scenario ? buildScenario(config.scenario, config.agents) : null;
    const genResult = generateWorld(config.worldgen, config.agents.length, {
      agents: config.agents,
      social: buildWorldgenSocial(config.agents, config.relationships, scenario),
    });
    // Writeback the resolved seed so worldState.setup_config is deterministic for restart.
    config.worldgen = { ...config.worldgen, seed: genResult.seed };

    // `sqlite.transaction` wraps the clear and the seed together so neither can
    // be observed half-applied.
    //
    // The delete order is freed with `defer_foreign_keys`, not by toggling
    // `foreign_keys` around the outside. `foreign_keys` is ignored mid
    // transaction, so it has to be set before BEGIN — which would also disable
    // checking for every INSERT `seedWorld` makes, letting a bad home /
    // workplace / current_location reference commit silently and surface much
    // later. `defer_foreign_keys` is honoured mid transaction, permits arbitrary
    // delete order, auto-resets at commit (and at rollback), and still enforces
    // every constraint at COMMIT — which is exactly what this wants.
    return sqlite.transaction(() => {
      sqlite.exec('PRAGMA defer_foreign_keys = ON;');
      deleteAllRows();
      return seedWorld(config, genResult, scenario);
    })();
  } finally {
    // Everything before `startTickLoop()` is wrapped so that nothing in here can
    // skip the restart. The zone reconstruction below does real DB I/O and can
    // throw on its own (SQLITE_BUSY past the 3s `busy_timeout` in `db/index.ts`
    // while a concurrent tRPC handler holds the write lock); a throw out of a
    // `finally` replaces the original error AND skips the rest of the block,
    // which is the same permanent freeze this rewrite exists to prevent, through
    // a different door.
    //
    // It is a `catch`, not an inner `finally`: an inner `finally` would let the
    // throw keep propagating out of the outer `finally`, which is exactly the
    // failure mode. Swallowing and logging is correct here — a stale cache or a
    // stale zone index degrades the new world, a stopped tick loop bricks it. The
    // ordering is unchanged on the happy path, so the caches are still cleared
    // before any tick can observe them.
    try {
      // Every service cache and per-agent map, then the snapshot restore and
      // zone reconstruction for whatever world the DB now holds — the freshly
      // seeded one on success, the checkpoint taken above if the seed rolled back.
      resetWorldRuntime();
    } catch (err) {
      console.error('[setup] replaceWorld cache reset failed (tick loop still restarts):', err);
    }

    // Unconditional: on the failure path this is what stops a thrown seed from
    // leaving the simulation permanently frozen. `startTickLoop` is idempotent
    // and `gameTick` no-ops when there is no world row or the world is paused,
    // so it is safe even when the rollback restored the wizard placeholder.
    startTickLoop();
    emitter.markAllDirty();
    emitter.flush();
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const setupRouter = router({
  initialize: publicProcedure
    .input(SetupConfigSchema)
    .mutation(async ({ input }) => {
      const result = await replaceWorld(input);
      return { ok: true, ...result };
    }),

  restart: publicProcedure.mutation(async () => {
    const world = db.select({ setup_config: worldState.setup_config }).from(worldState).limit(1).get();
    if (!world?.setup_config) {
      throw new Error('No saved setup config — use Reset to Wizard instead');
    }
    const config = SetupConfigSchema.parse(world.setup_config);
    // A config saved before social home placement existed has no
    // `socialPlacement` key, and the schema's `.default(true)` would switch it
    // on here — relabelling the homes of a world the player already knows, from
    // the same seed. So the missing key is read off the raw JSON, before the
    // parse filled it in, and means "off". Configs posted by the wizard since
    // carry the key explicitly (the schema default writes it into the persisted
    // config), so this only ever matches legacy saves.
    if (!hasSocialPlacementKey(world.setup_config)) {
      config.worldgen = { ...config.worldgen, socialPlacement: false };
    }

    await replaceWorld(config);

    return { ok: true };
  }),

  /**
   * Preview for the wizard's Scenario/Preview steps. Takes the wizard's own
   * agent list — it used to run against `AGENT_SEEDS`, so a renamed or edited
   * cast was previewed as the default one — and the same seed the Start button
   * will post, so this returns the exact scenario the world will be seeded with.
   */
  generateDrama: publicProcedure
    .input(z.object({
      scenario: ScenarioSlidersSchema,
      agents: z.array(AgentConfigSchema).min(2),
    }))
    .query(({ input }) => buildScenario(input.scenario, input.agents)),

  previewWorld: publicProcedure
    .input(
      WorldGenConfigObjectSchema.extend({
        // Capped server-side too. The wizard enforces MAX_AGENTS, but this is a
        // public procedure and an unbounded count was the only way to drive the
        // worldgen expand ladder from the network.
        agentCount: z.number().int().min(1).max(MAX_AGENTS),
        previewAgentHomes: z
          .array(z.object({ homeName: z.string() }))
          .optional(),
        /**
         * The wizard's full cast, relationships and scenario sliders, so the
         * preview places households by the same relationship graph Start will.
         * `agents` supersedes `previewAgentHomes` when present (it carries the
         * names and workplaces the social placement needs, and the fields
         * `buildScenario` reads); the scenario only applies with `agents`,
         * since its romance threads and rivalries are indices into that list.
         *
         * Deliberately loose here and narrowed in the handler — see
         * `PlacementAgentSchema` for why a full-config validation was wrong.
         */
        agents: z.array(PreviewAgentInputSchema).max(MAX_AGENTS).optional(),
        relationships: z.array(z.unknown()).max(MAX_AGENTS * MAX_AGENTS).optional(),
        scenario: ScenarioSlidersSchema.optional(),
      }).refine(
        (cfg) => cfg.sizeTier !== 'custom' || !!cfg.customDimensions,
        { message: "sizeTier='custom' requires customDimensions" },
      ),
    )
    .mutation(({ input }) => {
      const { agentCount, previewAgentHomes, agents, relationships, scenario, ...cfg } = input;
      if (!agents) return generateWorld(cfg, agentCount, { agents: previewAgentHomes });

      // An agent without a usable name can't be placed socially: preview the
      // homes alone rather than fail. Start validates the full config, and the
      // wizard shows its error in the footer next to the Start button.
      const placement = z.array(PlacementAgentSchema).safeParse(agents);
      if (!placement.success) {
        return generateWorld(cfg, agentCount, {
          agents: agents.map((a) => ({ homeName: a.homeName })),
        });
      }
      // Likewise the scenario: without the fields it is built from, place by
      // the relationship rows alone.
      const scenarioAgents = z.array(ScenarioAgentSchema).safeParse(agents);
      const built = scenario && scenarioAgents.success && agents.length > 0
        ? buildScenario(scenario, scenarioAgents.data)
        : null;
      // A malformed row drops out rather than failing the whole preview.
      const rels = (relationships ?? []).flatMap((r) => {
        const parsed = PlacementRelationshipSchema.safeParse(r);
        return parsed.success ? [parsed.data] : [];
      });
      return generateWorld(cfg, agentCount, {
        agents: placement.data,
        social: buildWorldgenSocial(placement.data, rels, built),
      });
    }),

  resetToWizard: publicProcedure.mutation(async () => {
    await stopTickLoopAndWait();
    await Promise.race([
      taskRunner.drain(),
      new Promise(resolve => setTimeout(resolve, 10_000)),
    ]);
    taskRunner.resetSlots();
    // As in `replaceWorld`: a rolled-back reset gets its state back below.
    saveWorldCaches();

    try {
      // Same transaction protection as `replaceWorld`, for the same reason: left
      // unwrapped, a throw in either insert cleared every table and left no
      // `worldState` row behind — the same brick, via a less likely path, since
      // the values below are all static literals.
      sqlite.transaction(() => {
        sqlite.exec('PRAGMA defer_foreign_keys = ON;');
        deleteAllRows();

        // Insert minimal worldState for wizard detection (totalTicks === 0, is_paused)
        db.insert(worldState).values({
          time: { day: 0, hour: 8, minute: 0, totalTicks: 0, seasonDay: 0, season: 'spring' },
          day_phase: 'morning',
          // 'sunny', not 'clear': every weather table in the client and the engine
          // is keyed to the eight values in `WorldConfigSchema`, and 'clear' is not
          // one of them — it only ever fell through the `?? sunny` guards.
          weather: 'sunny',
          weather_duration: 6,
          tick_speed: 0,
          is_paused: true,
          last_tick_completed: 0,
          current_tick_phase: 0,
          tick_id: 'reset',
          pending_transitions: [],
          tax_pool: 0,
          map_width: MIN_WIDTH,
          map_height: MIN_HEIGHT,
          collision_grid: '',
          road_tiles: [],
          terrain_tiles: [],
          setup_config: null,
        }).run();

        // Minimal scheduler state
        db.insert(conversationSchedulerState).values({
          active_llm_conversations: [],
          max_concurrent_llm: CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM,
          max_queue_size: CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE,
          max_turns_deep: CONFIG.CONVERSATIONS.MAX_TURNS_DEEP,
          max_turns_standard: CONFIG.CONVERSATIONS.MAX_TURNS_STANDARD,
          template_fallback_after_ms: queueMaxWait(CONFIG.CONVERSATIONS.QUEUE_MAX_WAIT_GAME_MINUTES),
          stats: {
            llmConversationsTotal: 0,
            templateConversationsTotal: 0,
            averageResponseTimeMs: 0,
            queueTimeoutsTotal: 0,
          },
        }).run();
      })();
    } finally {
      // Symmetric with `replaceWorld`. Unwrapped, a throw from the transaction
      // above skipped every cache clear and both emitter calls, leaving the old
      // world in the DB with the tick loop already stopped, every module cache
      // stale, and no signal to the client. The clears are all in-memory and
      // idempotent, so running them on the failure path is strictly better than
      // skipping them: the DB has rolled back to the previous world, but these
      // caches would otherwise still describe it only by accident.
      //
      // The clears are wrapped exactly as in `replaceWorld`: unwrapped, a throw from
      // any one of them would replace the original transaction error AND skip the
      // emitter calls below, so the client would never learn the world was reset
      // while the tick loop is already stopped.
      try {
        resetWorldRuntime();
      } catch (err) {
        console.error('[setup] resetToWizard cache reset failed (client is still notified):', err);
      }

      // Unconditional, and deliberately OUTSIDE the try above: this is the only
      // signal the client gets that the world is gone.
      // Do NOT restart tick loop — leave paused for wizard
      emitter.markAllDirty();
      emitter.flush();
    }

    return { ok: true };
  }),
});
