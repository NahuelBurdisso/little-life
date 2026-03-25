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
} from '../db/schema';
import { AGENT_SEEDS } from '../data/agents';
import { LOCATIONS, MAP_WIDTH, MAP_HEIGHT, COLLISION_GRID } from '../data/maps';
import { getRelationshipSeeds } from '../data/relationships';
import { getMemorySeeds } from '../data/memories';
import { CONVERSATION_TEMPLATES } from '../data/templates';
import { CONFIG } from '../lib/constants';
import { eq } from 'drizzle-orm';

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

    const inserted = db
      .insert(agents)
      .values({
        name: seed.name,
        bio: seed.bio,
        traits: seed.traits,
        age: seed.age,
        gender: seed.gender,
        sprite_sheet: seed.spriteSheet,
        portrait_sprite: seed.portraitSprite,
        position: { x: startX, y: startY },
        current_destination: null,
        current_location: homeId,
        current_action: { type: "sleeping" },
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

  // 3. Insert needs + economy for each agent
  console.log('[seed] Inserting needs and economy...');
  for (const seed of AGENT_SEEDS) {
    const agentId = agentMap.get(seed.name)!;

    db.insert(needs).values({
      agent_id: agentId,
      hunger: 70 + Math.floor(Math.random() * 20),
      energy: 80 + Math.floor(Math.random() * 15),
      social: 50 + Math.floor(Math.random() * 30),
      comfort: 60 + Math.floor(Math.random() * 25),
      fun: 50 + Math.floor(Math.random() * 30),
      mood: 60 + Math.floor(Math.random() * 20),
      stress: 10 + Math.floor(Math.random() * 15),
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
      money: CONFIG.ECONOMY.STARTING_MONEY + Math.floor(Math.random() * 20),
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

  // 4. Set location owners
  console.log('[seed] Setting location owners...');
  const ownershipMap: [string, string][] = [
    ["Rosa's General Store", "Rosa Chen"],
    ["The Rusty Lantern", "Marco Rivera"],
    ["Dr. Chen's Clinic", "Dr. Sofia Petrov"],
    ["Town Hall", "Thomas Park"],
    ["Green Acres Farm", "Elena Voss"],
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

  // 8. Create worldState singleton
  console.log('[seed] Creating worldState...');
  db.insert(worldState).values({
    time: {
      day: 1,
      hour: 7,
      minute: 0,
      totalTicks: 0,
      seasonDay: 1,
      season: "spring",
    },
    day_phase: "morning",
    weather: "sunny",
    weather_duration: 4,
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
  db.insert(activityLog).values({
    type: "system",
    message:
      "Little Life has been initialized. Day 1 begins in Spring with sunny weather. 12 residents are waking up.",
    agent_ids: [],
    timestamp: 0,
    real_timestamp: now,
  }).run();

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
