import { mutation } from "../_generated/server";
import { loadMap } from "./loadMap";
import { AGENT_SEEDS, createAgents } from "./agents";
import { seedRelationships } from "./relationships";
import { seedMemories } from "./memories";
import { CONVERSATION_TEMPLATES } from "../../data/templates/conversations";
import { CONFIG } from "../engine/constants";

const ALL_TABLES = [
  "agents",
  "needs",
  "economy",
  "economyTransactions",
  "relationships",
  "relationshipEvents",
  "conversations",
  "conversationQueue",
  "conversationSchedulerState",
  "memories",
  "locations",
  "worldState",
  "worldEvents",
  "templates",
  "templateUsage",
  "activityLog",
] as const;

export const resetWorld = mutation({
  args: {},
  handler: async (ctx) => {
    // Delete all records from all tables
    for (const tableName of ALL_TABLES) {
      const records = await ctx.db.query(tableName).collect();
      for (const record of records) {
        await ctx.db.delete(record._id);
      }
    }

    const now = Date.now();

    // Insert locations
    const mapData = loadMap();
    const locationsByName = new Map<string, any>();

    for (const loc of mapData.locations) {
      const locId = await ctx.db.insert("locations", {
        name: loc.name,
        type: loc.type,
        position: loc.position,
        entryPoint: loc.entryPoint,
        owner: null,
        capacity: loc.capacity,
        currentOccupants: [],
        operatingHours: loc.operatingHours,
        services: loc.services,
        description: loc.description,
      });
      locationsByName.set(loc.name, locId);
    }

    // Create agents
    const agentMap = await createAgents(ctx, locationsByName);

    // Set owners
    const ownershipMap: [string, string][] = [
      ["Rosa's General Store", "Rosa Chen"],
      ["The Rusty Lantern", "Marco Rivera"],
      ["Dr. Chen's Clinic", "Dr. Sofia Petrov"],
      ["Town Hall", "Thomas Park"],
      ["Green Acres Farm", "Elena Voss"],
    ];

    for (const [locName, agentName] of ownershipMap) {
      const locId = locationsByName.get(locName);
      const ownerId = agentMap.get(agentName);
      if (locId && ownerId) {
        await ctx.db.patch(locId, { owner: ownerId });
      }
    }

    // Seed relationships
    await seedRelationships(ctx, agentMap, AGENT_SEEDS);

    // Seed memories
    await seedMemories(ctx, agentMap, AGENT_SEEDS);

    // Insert templates
    for (const template of CONVERSATION_TEMPLATES) {
      await ctx.db.insert("templates", {
        category: template.category,
        conditions: template.conditions,
        variants: template.variants,
        cooldownPerPair: template.cooldownPerPair,
      });
    }

    // Create worldState
    await ctx.db.insert("worldState", {
      time: {
        day: 1,
        hour: 7,
        minute: 0,
        totalTicks: 0,
        seasonDay: 1,
        season: "spring",
      },
      dayPhase: "morning",
      weather: "sunny",
      weatherDuration: 4,
      tickSpeed: CONFIG.DEFAULT_TICK_SPEED,
      isPaused: true,
      lastTickCompleted: now,
      currentTickPhase: 0,
      tickId: "reset",
      pendingTransitions: [],
      taxPool: 0,
      mapWidth: mapData.mapWidth,
      mapHeight: mapData.mapHeight,
      collisionGrid: mapData.collisionGrid,
    });

    // Create conversationSchedulerState
    await ctx.db.insert("conversationSchedulerState", {
      activeLLMConversations: [],
      maxConcurrentLLM: CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM,
      maxQueueSize: CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE,
      maxTurnsDeep: CONFIG.CONVERSATIONS.MAX_TURNS_DEEP,
      maxTurnsStandard: CONFIG.CONVERSATIONS.MAX_TURNS_STANDARD,
      templateFallbackAfterMs: CONFIG.CONVERSATIONS.TEMPLATE_FALLBACK_MS,
      stats: {
        llmConversationsTotal: 0,
        templateConversationsTotal: 0,
        averageResponseTimeMs: 0,
        queueTimeoutsTotal: 0,
      },
    });

    // Activity log
    await ctx.db.insert("activityLog", {
      type: "system",
      message: "World has been reset. Day 1 begins anew in Spring. 12 residents are waking up.",
      agentIds: [],
      timestamp: now,
      realTimestamp: now,
    });

    return { status: "reset_complete" as const };
  },
});
