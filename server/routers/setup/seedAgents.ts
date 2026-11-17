/**
 * The location inserts and seeding steps 3-5: the town's places and people. Locations, agents with their
 * aspirations, starting occupants, needs and economy rows, and workplace owners.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, aspirations, economy, locations, needs } from '../../db/schema';
import { AGENT_SEEDS } from '../../data/agents';
import { ambitionText } from '../../data/ambitions';
import { CONFIG } from '../../lib/constants';
import { HOOK_VALUES } from '../../lib/dramaHooks';
import { startingMoodModifiers, startingNeeds } from '../../lib/startingNeeds';
import { forkRng } from '../../lib/worldgen/rng';
import type { SeedContext } from './seedContext';

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

/** Insert every generated location, unowned (owners are set at step 5), and fill `ctx.locationMap`. */
export function insertLocations(ctx: SeedContext): void {
  const { locationMap } = ctx;
  const dynamicLocations = ctx.genResult.locations;

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
}

/**
 * Step 3: insert each agent with its aspiration and fill `ctx.agentMap`.
 * Returns who starts inside each location, for `registerStartOccupants`.
 * Throws when an agent's home is not a generated location; the caller's
 * transaction rolls the whole seed back.
 */
export function insertAgents(ctx: SeedContext): Map<number, number[]> {
  const { config, scenario, locationMap, agentMap } = ctx;
  const dynamicLocations = ctx.genResult.locations;

  // 3. Insert agents, build name → ID map
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

    // Insert aspiration for this agent. The opening hooks' challenger wants the
    // mayor's chair: a `power` ambition whose words (election.ts MAYOR_WORDS)
    // put them on the ballot when the campaign opens.
    const campaign = scenario?.hooks.campaign;
    const challenger = campaign != null && config.agents[campaign.challenger]?.name === agentCfg.name;
    const aspConfig = challenger
      ? { type: 'power', intensity: 0.9 }
      : agentCfg.aspiration ?? { type: 'freedom', intensity: 0.5 };
    db.insert(aspirations).values({
      agent_id: inserted.id,
      type: aspConfig.type,
      intensity: aspConfig.intensity,
      status: 'active',
      adopted_at: 0,
      trigger: 'initial',
      description: challenger ? campaign!.ambition : ambitionText(aspConfig.type),
    }).run();
  }

  return startOccupants;
}

/** Step 3b: write each location's starting occupants, as collected by `insertAgents`. */
export function registerStartOccupants(startOccupants: ReadonlyMap<number, number[]>): void {
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
}

/**
 * Step 4: one needs row and one economy row per agent, in cast order. The
 * seeded draws stay in exactly this order (mood, stress, work performance,
 * daily expenses), each only when its fallback is reached.
 */
export function insertNeedsAndEconomy(ctx: SeedContext): void {
  const { config, scenario, agentMap, startMinute, genResult } = ctx;
  // Seeded from the world seed like the rest of the world: these were plain
  // Math.random(), so the same seed gave the same town with different moods,
  // stress, work performance and daily expenses. One stream for the whole
  // step, drawn in the order the Math.random() calls were (a draw happens
  // only when the scenario gives no value).
  const rng = forkRng(genResult.seed, 'needs');

  // 4. Insert needs + economy for each agent
  // The crime slider decides inequality: it flattens everyone toward 60-80 at
  // low crime and pulls the tails apart at high crime. Falls back to the job
  // table when no scenario was posted. A hook debtor starts nearly broke: the
  // debt is real, and `in_debt` (then `pay_debt`) is a few days away.
  const startingMoneyFor = (agentIdx: number): number => {
    const money = scenario?.economyAdjustments[agentIdx]
      ?? getJobStartingMoney(config.agents[agentIdx].job, (config.rules.startingMoney as number) ?? 50);
    return scenario?.hooks.debt?.debtor === agentIdx ? Math.min(money, HOOK_VALUES.debtorMoney) : money;
  };
  for (let agentIdx = 0; agentIdx < config.agents.length; agentIdx++) {
    const agentCfg = config.agents[agentIdx];
    const agentId = agentMap.get(agentCfg.name)!;
    const scenarioMood = scenario?.moodAdjustments[agentIdx];

    db.insert(needs).values({
      agent_id: agentId,
      ...startingNeeds(),
      // The hooks' lonely and bored residents (lib/dramaHooks.ts).
      ...scenario?.hooks.needs[agentIdx],
      mood: scenarioMood?.mood ?? 55 + Math.floor(rng.next() * 25),
      stress: scenarioMood?.stress ?? 10 + Math.floor(rng.next() * 20),
      decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES },
      thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
      // The seeded `mood` above only lasts until the needs phase rebuilds it on
      // the first tick; a troubled start is carried by a modifier instead.
      mood_modifiers: startingMoodModifiers(scenarioMood?.mood, startMinute),
      last_updated: 0,
    }).run();

    db.insert(economy).values({
      agent_id: agentId,
      job: agentCfg.job,
      job_title: agentCfg.jobTitle,
      salary: agentCfg.salary,
      work_performance: 70 + Math.floor(rng.next() * 20),
      money: startingMoneyFor(agentIdx),
      daily_expenses:
        CONFIG.ECONOMY.DAILY_EXPENSES.min +
        Math.floor(
          rng.next() *
            (CONFIG.ECONOMY.DAILY_EXPENSES.max - CONFIG.ECONOMY.DAILY_EXPENSES.min)
        ),
      inventory: getJobStartingInventory(agentCfg.job),
      last_payday: 0,
      production_remainder: 0,
    }).run();
  }
}

/** Step 5: hand each owner-type agent's workplace to them, first come first served. */
export function assignLocationOwners(ctx: SeedContext): void {
  const { config, locationMap, agentMap } = ctx;

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
}
