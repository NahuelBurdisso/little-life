import { router, publicProcedure } from '../trpc';
import { db, sqlite } from '../db';
import { generateFromSliders } from '../lib/setupGenerator';
import { forkRng } from '../lib/worldgen/rng';
import {
  conversationSchedulerState,
  worldState,
} from '../db/schema';
import { ALL_TABLES } from '../db/worldTables';
import { MIN_WIDTH, MIN_HEIGHT, MAX_AGENTS } from '../lib/worldgen/config';
import { CONFIG } from '../lib/constants';
import { queueMaxWait } from '../lib/conversationPacing';
import { z } from 'zod';
import { startTickLoop, stopTickLoopAndWait } from '../engine/tick';
import { taskRunner } from '../ai/taskRunner';
import { emitter } from '../engine/emitter';
import { WorldGenConfigObjectSchema } from '../lib/worldgen/config';
import { generateWorld } from '../lib/worldgen';
import { buildSocialEdges } from '../lib/worldgen/social';
import { saveWorldCaches } from '../engine/worldCaches';
import { resetWorldRuntime, retireOutgoingWorldTasks } from '../engine/worldRuntime';
import { nameHomes } from '../lib/homeNames';
import { createSeedContext } from './setup/seedContext';
import {
  assignLocationOwners,
  insertAgents,
  insertLocations,
  insertNeedsAndEconomy,
  registerStartOccupants,
} from './setup/seedAgents';
import { seedOrientations, seedRelationships } from './setup/seedRelationships';
import {
  seedBackstoryMemories,
  seedDefaultCastDrama,
  seedHookHistory,
  seedScenarioSecrets,
} from './setup/seedKnowledge';
import { insertSchedulerState, insertWorldState, logWorldCreated } from './setup/seedWorldState';

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
  // Optional: the opening hooks read it (a married couple is a man and a
  // woman), but they only shape the scenario, never the home placement this
  // preview is for, so a cast without it still previews the same map.
  gender: z.string().optional(),
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
  gender: z.unknown(),
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
      homeName: a.homeName,
      gender: a.gender,
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

// The steps live in ./setup/ (seedContext, seedAgents, seedRelationships,
// seedKnowledge, seedWorldState); these two types are all they import back.

/** A validated wizard config, as `seedWorld` and its steps read it. */
export type SetupConfig = z.infer<typeof SetupConfigSchema>;

/** The scenario `buildScenario` builds, as `seedWorld` and its steps read it. */
export type Scenario = ReturnType<typeof buildScenario>;

/**
 * Persist `config` plus an already-generated world.
 *
 * `genResult` is a parameter rather than something this function produces,
 * because `generateWorld` throws (unfittable content, dimensions cap) and every
 * caller clears the database first — so generating in here meant a failed
 * generation left an empty database behind. `replaceWorld` now generates before
 * it destroys anything.
 *
 * The steps below run in a fixed order: row ids are autoincrement, later steps
 * resolve names through the maps earlier ones fill, and step 4 draws from
 * `Math.random()` in cast order.
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
  const ctx = createSeedContext(config, genResult, scenario);

  insertLocations(ctx);
  const startOccupants = insertAgents(ctx);
  registerStartOccupants(startOccupants);
  insertNeedsAndEconomy(ctx);
  assignLocationOwners(ctx);
  const { stagedRows, adultIds } = seedRelationships(ctx);
  seedOrientations(ctx, stagedRows);
  seedBackstoryMemories(ctx);
  seedDefaultCastDrama(ctx, adultIds);
  if (scenario) seedScenarioSecrets(ctx, scenario, adultIds);

  // 8. (no conversation-template rows: chats are played from data/smallTalkScripts.ts and
  //    nothing reads the `templates` table any more — see the note on it in schema.ts.)

  const dayPhase = insertWorldState(ctx);
  insertSchedulerState();

  // 10b. The opening hooks' history, after the world row: the relationship_events
  //      trigger stamps each row with the world clock's game minute.
  if (scenario) seedHookHistory(config, scenario.hooks, ctx.agentMap, ctx.now, ctx.startMinute);

  logWorldCreated(ctx, dayPhase);

  return { agentCount: ctx.agentMap.size, locationCount: ctx.locationMap.size };
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
  retireOutgoingWorldTasks();
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
      const seeded = seedWorld(config, genResult, scenario);
      // After the seed, which places people by the worldgen labels: name the
      // houses after who lives in them (ids unchanged; lib/homeNames.ts).
      nameHomes(sqlite);
      return seeded;
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
    retireOutgoingWorldTasks();
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
