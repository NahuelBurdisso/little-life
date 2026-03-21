import { mutation } from "../_generated/server";
import { loadMap } from "./loadMap";
import { AGENT_SEEDS, createAgents } from "./agents";
import { seedRelationships } from "./relationships";
import { seedMemories } from "./memories";
import { CONVERSATION_TEMPLATES } from "../../data/templates/conversations";
import { CONFIG } from "../engine/constants";
import { Id } from "../_generated/dataModel";

export const initialize = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Check if worldState already exists — return early if so
    const existingWorld = await ctx.db.query("worldState").first();
    if (existingWorld) {
      return { status: "already_initialized" as const };
    }

    const now = Date.now();

    // 2. Insert locations from loadMap
    const mapData = loadMap();
    const locationsByName = new Map<string, Id<"locations">>();

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

    // 3. Create agents (returns name -> ID map)
    const agentMap = await createAgents(ctx, locationsByName);

    // Set owners for relevant locations
    const rosaId = agentMap.get("Rosa Chen");
    const marcoId = agentMap.get("Marco Rivera");
    const sofiaId = agentMap.get("Dr. Sofia Petrov");
    const thomasId = agentMap.get("Thomas Park");
    const elenaId = agentMap.get("Elena Voss");

    const shopId = locationsByName.get("Rosa's General Store");
    const tavernId = locationsByName.get("The Rusty Lantern");
    const clinicId = locationsByName.get("Dr. Chen's Clinic");
    const townHallId = locationsByName.get("Town Hall");
    const farmId = locationsByName.get("Green Acres Farm");

    if (shopId && rosaId) {
      await ctx.db.patch(shopId, { owner: rosaId });
    }
    if (tavernId && marcoId) {
      await ctx.db.patch(tavernId, { owner: marcoId });
    }
    if (clinicId && sofiaId) {
      await ctx.db.patch(clinicId, { owner: sofiaId });
    }
    if (townHallId && thomasId) {
      await ctx.db.patch(townHallId, { owner: thomasId });
    }
    if (farmId && elenaId) {
      await ctx.db.patch(farmId, { owner: elenaId });
    }

    // 4. Seed relationships
    await seedRelationships(ctx, agentMap, AGENT_SEEDS);

    // 5. Seed memories
    await seedMemories(ctx, agentMap, AGENT_SEEDS);

    // 6. Insert template records
    for (const template of CONVERSATION_TEMPLATES) {
      await ctx.db.insert("templates", {
        category: template.category,
        conditions: template.conditions,
        variants: template.variants,
        cooldownPerPair: template.cooldownPerPair,
      });
    }

    // 7. Create worldState singleton
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
      tickId: "init",
      pendingTransitions: [],
      taxPool: 0,
      mapWidth: mapData.mapWidth,
      mapHeight: mapData.mapHeight,
      collisionGrid: mapData.collisionGrid,
    });

    // 8. Create conversationSchedulerState singleton
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

    // 9. Insert initial activity log entry
    await ctx.db.insert("activityLog", {
      type: "system",
      message: "Little Life has been initialized. Day 1 begins in Spring with sunny weather. 12 residents are waking up.",
      agentIds: [],
      timestamp: now,
      realTimestamp: now,
    });

    return { status: "initialized" as const };
  },
});
