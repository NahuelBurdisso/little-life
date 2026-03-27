import { db, sqlite } from '../db';
import {
  agents,
  needs,
  economy,
  economyTransactions,
  relationships,
  relationshipEvents,
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
  facts,
  agentStates,
} from '../db/schema';
import { AGENT_SEEDS } from '../data/agents';
import { LOCATIONS, MAP_WIDTH, MAP_HEIGHT, COLLISION_GRID } from '../data/maps';
import { getRelationshipSeeds } from '../data/relationships';
import { getMemorySeeds } from '../data/memories';
import { CONVERSATION_TEMPLATES } from '../data/templates';
import { CONFIG } from '../lib/constants';
import { eq } from 'drizzle-orm';
import { logActivity } from '../lib/activityLogger';

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

function resetAll() {
  console.log('[seed] Resetting all tables...');
  // Use raw SQL for efficient truncation — delete in reverse-dependency order
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  for (const table of ALL_TABLES) {
    db.delete(table).run();
  }
  sqlite.exec('PRAGMA foreign_keys = ON;');
  console.log('[seed] All tables cleared.');
}

function isSeeded(): boolean {
  const existing = db.select().from(worldState).limit(1).all();
  return existing.length > 0;
}

function seed() {
  const now = Date.now(); // wall-clock only — used for last_tick_completed, real_timestamp

  // 1. Insert locations, build name -> ID map
  console.log('[seed] Inserting locations...');
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
  console.log(`[seed] Inserted ${locationMap.size} locations.`);

  // 2. Insert agents, build name -> ID map
  console.log('[seed] Inserting agents...');
  const agentMap = new Map<string, number>();

  for (const seed of AGENT_SEEDS) {
    const homeId = locationMap.get(seed.homeName);
    if (homeId === undefined) {
      throw new Error(`Home location not found: ${seed.homeName}`);
    }
    const workplaceId = seed.workplaceName
      ? locationMap.get(seed.workplaceName) ?? null
      : null;

    // Find home entry point for start position
    const homeLoc = LOCATIONS.find((l) => l.name === seed.homeName)!;
    const startX = homeLoc.entry_point.x;
    const startY = homeLoc.entry_point.y;

    // Start agents at their workplace if 9AM is during work hours, else at home
    const isAtWork = workplaceId && 9 >= seed.schedule.workStart && 9 < seed.schedule.workEnd;
    const startLocationId = isAtWork ? workplaceId : homeId;
    const startLoc = isAtWork
      ? LOCATIONS.find((l) => l.name === seed.workplaceName)
      : homeLoc;
    const startAction = isAtWork ? { type: "working", taskDescription: "daily work" } : { type: "idle" };

    const inserted = db
      .insert(agents)
      .values({
        name: seed.name,
        bio: seed.bio,
        traits: seed.traits,
        personality: seed.personality,
        age: seed.age,
        gender: seed.gender,
        sprite_sheet: seed.spriteSheet,
        portrait_sprite: seed.portraitSprite,
        position: { x: startLoc?.entry_point.x ?? startX, y: startLoc?.entry_point.y ?? startY },
        current_destination: null,
        current_location: startLocationId,
        current_action: startAction,
        action_started: 0,
        action_duration: null,
        action_queue: [],
        current_path: null,
        schedule: seed.schedule,
        home: homeId,
        workplace: workplaceId,
        created_at: 0,
        is_active: true,
      })
      .returning({ id: agents.id })
      .get();

    agentMap.set(seed.name, inserted.id);
  }
  console.log(`[seed] Inserted ${agentMap.size} agents.`);

  // 3. Insert needs + economy for each agent — varied starting conditions
  console.log('[seed] Inserting needs and economy...');

  // Starting money varies by job type (some are richer, some struggling)
  const startingMoney: Record<string, number> = {
    farmer: 80, farmhand: 40, bartender: 60, shopkeeper: 120,
    retired: 90, doctor: 100, medical_assistant: 55, mayor: 150,
    baker: 65, handyperson: 25, shop_assistant: 35, musician: 20,
    constable: 70,
  };

  // Starting inventory by job
  const startingInventory: Record<string, Array<{ itemId: string; quantity: number; acquiredAt: number }>> = {
    farmer: [{ itemId: 'food_raw', quantity: 10, acquiredAt: 0 }],
    farmhand: [{ itemId: 'food_raw', quantity: 3, acquiredAt: 0 }],
    shopkeeper: [{ itemId: 'food_prepared', quantity: 5, acquiredAt: 0 }, { itemId: 'food_raw', quantity: 8, acquiredAt: 0 }],
    doctor: [{ itemId: 'medicine', quantity: 4, acquiredAt: 0 }],
    medical_assistant: [{ itemId: 'medicine', quantity: 2, acquiredAt: 0 }],
    baker: [{ itemId: 'food_raw', quantity: 6, acquiredAt: 0 }, { itemId: 'food_prepared', quantity: 4, acquiredAt: 0 }],
    bartender: [{ itemId: 'drink', quantity: 8, acquiredAt: 0 }, { itemId: 'food_raw', quantity: 3, acquiredAt: 0 }],
  };

  for (const seed of AGENT_SEEDS) {
    const agentId = agentMap.get(seed.name)!;

    // Needs vary more — some agents start in worse shape for early drama
    const isLowMood = ['Carlos Mendez', 'Thomas Park', 'Lucia Fernandez'].includes(seed.name);
    const isHighEnergy = ['Elena Voss', 'Priya Sharma', 'Omar Hassan'].includes(seed.name);

    db.insert(needs).values({
      agent_id: agentId,
      hunger: 50 + Math.floor(Math.random() * 40),
      energy: isHighEnergy ? 85 + Math.floor(Math.random() * 10) : 55 + Math.floor(Math.random() * 30),
      social: 30 + Math.floor(Math.random() * 40),
      comfort: 50 + Math.floor(Math.random() * 30),
      fun: 30 + Math.floor(Math.random() * 40),
      mood: isLowMood ? 30 + Math.floor(Math.random() * 20) : 55 + Math.floor(Math.random() * 25),
      stress: isLowMood ? 40 + Math.floor(Math.random() * 20) : 10 + Math.floor(Math.random() * 20),
      decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES },
      thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
      mood_modifiers: [],
      last_updated: 0,
    }).run();

    db.insert(economy).values({
      agent_id: agentId,
      job: seed.job,
      job_title: seed.jobTitle,
      salary: seed.salary,
      work_performance: 70 + Math.floor(Math.random() * 20),
      money: startingMoney[seed.job] ?? CONFIG.ECONOMY.STARTING_MONEY,
      daily_expenses:
        CONFIG.ECONOMY.DAILY_EXPENSES.min +
        Math.floor(
          Math.random() *
            (CONFIG.ECONOMY.DAILY_EXPENSES.max - CONFIG.ECONOMY.DAILY_EXPENSES.min)
        ),
      inventory: startingInventory[seed.job] ?? [],
      last_payday: 0,
      production_remainder: 0,
    }).run();
  }

  // 4. Set location owners
  console.log('[seed] Setting location owners...');
  const ownershipMap: [string, string][] = [
    ["Rosa's General Store", "Rosa Chen"],
    ["The Rusty Lantern", "Marco Rivera"],
    ["Dr. Petrov's Clinic", "Dr. Sofia Petrov"],
    ["Town Hall", "Thomas Park"],
    ["Green Acres Farm", "Elena Voss"],
    ["Priya's Bakery", "Priya Sharma"],
    ["Carlos' Workshop", "Carlos Mendez"],
    ["Town Jail", "Ray Kowalski"],
  ];

  for (const [locName, agentName] of ownershipMap) {
    const locId = locationMap.get(locName);
    const ownerId = agentMap.get(agentName);
    if (locId !== undefined && ownerId !== undefined) {
      db.update(locations)
        .set({ owner: ownerId })
        .where(eq(locations.id, locId))
        .run();
    }
  }

  // 5. Insert relationships
  console.log('[seed] Inserting relationships...');
  const relSeeds = getRelationshipSeeds(agentMap);
  for (const rel of relSeeds) {
    db.insert(relationships).values(rel).run();
  }
  console.log(`[seed] Inserted ${relSeeds.length} relationships.`);

  // 6. Insert memories
  console.log('[seed] Inserting memories...');
  const memSeeds = getMemorySeeds(agentMap);
  for (const mem of memSeeds) {
    db.insert(memories).values(mem).run();
  }
  console.log(`[seed] Inserted ${memSeeds.length} memories.`);

  // 7. Insert templates
  console.log('[seed] Inserting templates...');
  for (const tmpl of CONVERSATION_TEMPLATES) {
    db.insert(templates).values({
      category: tmpl.category,
      conditions: tmpl.conditions,
      variants: tmpl.variants,
      cooldown_per_pair: tmpl.cooldownPerPair,
    }).run();
  }
  console.log(`[seed] Inserted ${CONVERSATION_TEMPLATES.length} templates.`);

  // 8. Create worldState singleton — start mid-morning for immediate activity
  console.log('[seed] Creating worldState...');
  db.insert(worldState).values({
    time: {
      day: 1,
      hour: 9,
      minute: 0,
      totalTicks: 0,
      seasonDay: 1,
      season: "spring",
    },
    day_phase: "morning",
    weather: "sunny",
    weather_duration: 6,
    tick_speed: CONFIG.DEFAULT_TICK_SPEED,
    is_paused: true,
    last_tick_completed: now,
    current_tick_phase: 0,
    tick_id: "init",
    pending_transitions: [],
    tax_pool: 0,
    map_width: MAP_WIDTH,
    map_height: MAP_HEIGHT,
    collision_grid: COLLISION_GRID,
  }).run();

  // 9. Create conversationSchedulerState singleton
  console.log('[seed] Creating conversationSchedulerState...');
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

  // 10. Insert initial activity log entry
  console.log('[seed] Creating initial activity log...');
  logActivity({
    type: 'system',
    templateData: { message: `Little Life begins. Day 1, Spring morning. ${agentMap.size} residents start their day.` },
  });

  // 11. Seed initial drama — pre-existing conditions for early story hooks
  console.log('[seed] Seeding initial drama...');
  // facts is already imported from schema at the top

  // Diego has a crush on Lucia (already in relationships, but make it a known fact)
  const diegoId = agentMap.get('Diego Santos');
  const luciaId = agentMap.get('Lucia Fernandez');
  if (diegoId && luciaId) {
    db.insert(facts).values({
      type: 'crush', subject_id: diegoId, target_id: luciaId,
      content: 'Diego Santos has a crush on Lucia Fernandez',
      sensitivity: 2, known_by: [diegoId, agentMap.get('Marco Rivera')!],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
    db.insert(facts).values({
      type: 'crush', subject_id: luciaId, target_id: diegoId,
      content: 'Lucia Fernandez has a crush on Diego Santos',
      sensitivity: 2, known_by: [luciaId, agentMap.get('Rosa Chen')!],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  // Carlos is struggling financially (he starts with $25)
  const carlosId = agentMap.get('Carlos Mendez');
  if (carlosId) {
    db.insert(facts).values({
      type: 'financial', subject_id: carlosId, target_id: null,
      content: 'Carlos Mendez is struggling with money',
      sensitivity: 1, known_by: [carlosId, agentMap.get('Marco Rivera')!],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  // Ray has a mysterious past — people are curious
  const rayId = agentMap.get('Ray Kowalski');
  if (rayId) {
    db.insert(facts).values({
      type: 'secret_told', subject_id: rayId, target_id: agentMap.get('Marco Rivera') ?? null,
      content: 'Ray Kowalski told Marco he was forced out of the city police after a disciplinary hearing — he hit a suspect during interrogation',
      sensitivity: 3, known_by: [rayId, agentMap.get('Marco Rivera')!],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  console.log('[seed] Seeding complete!');
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

const isReset = process.argv.includes('--reset');

if (isReset) {
  resetAll();
}

if (!isReset && isSeeded()) {
  console.log('[seed] Database already seeded. Use --reset to re-seed.');
  process.exit(0);
}

seed();
