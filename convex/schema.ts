import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // 1. agents
  agents: defineTable({
    name: v.string(),
    bio: v.string(),
    traits: v.array(v.string()),
    age: v.number(),
    gender: v.string(),
    spriteSheet: v.string(),
    portraitSprite: v.string(),
    position: v.object({ x: v.number(), y: v.number() }),
    currentDestination: v.union(
      v.object({
        x: v.number(),
        y: v.number(),
        locationId: v.optional(v.id("locations")),
      }),
      v.null()
    ),
    currentLocation: v.union(v.id("locations"), v.null()),
    currentAction: v.any(),
    actionStarted: v.number(),
    actionDuration: v.union(v.number(), v.null()),
    actionQueue: v.array(v.any()),
    currentPath: v.union(v.array(v.array(v.number())), v.null()),
    schedule: v.object({
      wakeTime: v.number(),
      sleepTime: v.number(),
      workStart: v.number(),
      workEnd: v.number(),
      lunchTime: v.number(),
      freeTimePreferences: v.array(v.string()),
    }),
    home: v.id("locations"),
    workplace: v.union(v.id("locations"), v.null()),
    createdAt: v.number(),
    isActive: v.boolean(),
  }),

  // 2. needs
  needs: defineTable({
    agentId: v.id("agents"),
    hunger: v.number(),
    energy: v.number(),
    social: v.number(),
    comfort: v.number(),
    fun: v.number(),
    mood: v.number(),
    stress: v.number(),
    decayRates: v.object({
      hunger: v.number(),
      energy: v.number(),
      social: v.number(),
      comfort: v.number(),
      fun: v.number(),
    }),
    thresholds: v.object({
      critical: v.number(),
      low: v.number(),
      satisfied: v.number(),
    }),
    moodModifiers: v.array(
      v.object({
        source: v.string(),
        value: v.number(),
        expiresAt: v.number(),
      })
    ),
    lastUpdated: v.number(),
  }).index("by_agentId", ["agentId"]),

  // 3. economy
  economy: defineTable({
    agentId: v.id("agents"),
    job: v.string(),
    jobTitle: v.string(),
    salary: v.number(),
    workPerformance: v.number(),
    money: v.number(),
    dailyExpenses: v.number(),
    inventory: v.array(
      v.object({
        itemId: v.string(),
        quantity: v.number(),
        acquiredAt: v.number(),
      })
    ),
    lastPayday: v.number(),
    productionRemainder: v.number(),
  }).index("by_agentId", ["agentId"]),

  // 4. economyTransactions
  economyTransactions: defineTable({
    fromAgent: v.union(v.id("agents"), v.null()),
    toAgent: v.union(v.id("agents"), v.null()),
    amount: v.number(),
    reason: v.string(),
    itemsExchanged: v.union(
      v.array(v.object({ itemId: v.string(), quantity: v.number() })),
      v.null()
    ),
    locationId: v.union(v.id("locations"), v.null()),
    timestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_toAgent", ["toAgent"]),

  // 5. relationships
  relationships: defineTable({
    agentA: v.id("agents"),
    agentB: v.id("agents"),
    friendshipAB: v.number(),
    friendshipBA: v.number(),
    romanceAB: v.number(),
    romanceBA: v.number(),
    trustAB: v.number(),
    trustBA: v.number(),
    familiarity: v.number(),
    interactionCount: v.number(),
    lastInteraction: v.number(),
    averageInteractionSentiment: v.number(),
    tags: v.array(v.string()),
    status: v.string(),
    createdAt: v.number(),
    lastUpdated: v.number(),
  })
    .index("by_agentA", ["agentA"])
    .index("by_agentB", ["agentB"])
    .index("by_pair", ["agentA", "agentB"]),

  // 6. relationshipEvents
  relationshipEvents: defineTable({
    agentA: v.id("agents"),
    agentB: v.id("agents"),
    eventType: v.string(),
    description: v.string(),
    friendshipDeltaAB: v.number(),
    friendshipDeltaBA: v.number(),
    romanceDeltaAB: v.number(),
    romanceDeltaBA: v.number(),
    trustDeltaAB: v.number(),
    trustDeltaBA: v.number(),
    sentiment: v.number(),
    processed: v.boolean(),
    timestamp: v.number(),
  }).index("by_processed", ["processed"]),

  // 7. conversations
  conversations: defineTable({
    participants: v.array(v.id("agents")),
    messages: v.array(v.any()),
    location: v.id("locations"),
    triggerReason: v.string(),
    topic: v.union(v.string(), v.null()),
    status: v.string(),
    startedAt: v.number(),
    endedAt: v.union(v.number(), v.null()),
    sentiment: v.number(),
    maxTurns: v.number(),
  }).index("by_status", ["status"]),

  // 8. conversationQueue
  conversationQueue: defineTable({
    participants: v.array(v.id("agents")),
    tier: v.string(),
    priority: v.number(),
    triggerReason: v.string(),
    topic: v.union(v.string(), v.null()),
    queuedAt: v.number(),
    maxWait: v.number(),
  }).index("by_priority", ["priority"]),

  // 9. conversationSchedulerState
  conversationSchedulerState: defineTable({
    activeLLMConversations: v.array(v.any()),
    maxConcurrentLLM: v.number(),
    maxQueueSize: v.number(),
    maxTurnsDeep: v.number(),
    maxTurnsStandard: v.number(),
    templateFallbackAfterMs: v.number(),
    stats: v.object({
      llmConversationsTotal: v.number(),
      templateConversationsTotal: v.number(),
      averageResponseTimeMs: v.number(),
      queueTimeoutsTotal: v.number(),
    }),
  }),

  // 10. memories
  memories: defineTable({
    agentId: v.id("agents"),
    content: v.string(),
    type: v.string(),
    importance: v.number(),
    emotional_valence: v.number(),
    embedding: v.array(v.float64()),
    relatedAgents: v.array(v.id("agents")),
    relatedLocation: v.union(v.id("locations"), v.null()),
    tags: v.array(v.string()),
    timestamp: v.number(),
    accessCount: v.number(),
    lastAccessed: v.number(),
  })
    .index("by_agentId", ["agentId"])
    .index("by_agentId_timestamp", ["agentId", "timestamp"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["agentId"],
    }),

  // 11. locations
  locations: defineTable({
    name: v.string(),
    type: v.string(),
    position: v.object({
      x: v.number(),
      y: v.number(),
      width: v.number(),
      height: v.number(),
    }),
    entryPoint: v.object({ x: v.number(), y: v.number() }),
    owner: v.union(v.id("agents"), v.null()),
    capacity: v.number(),
    currentOccupants: v.array(v.id("agents")),
    operatingHours: v.union(
      v.object({ open: v.number(), close: v.number() }),
      v.null()
    ),
    services: v.array(
      v.object({
        needSatisfied: v.string(),
        amount: v.number(),
        cost: v.number(),
        itemRequired: v.union(v.string(), v.null()),
      })
    ),
    description: v.string(),
  }),

  // 12. worldState
  worldState: defineTable({
    time: v.object({
      day: v.number(),
      hour: v.number(),
      minute: v.number(),
      totalTicks: v.number(),
      seasonDay: v.number(),
      season: v.string(),
    }),
    dayPhase: v.string(),
    weather: v.string(),
    weatherDuration: v.number(),
    tickSpeed: v.number(),
    isPaused: v.boolean(),
    lastTickCompleted: v.number(),
    currentTickPhase: v.number(),
    tickId: v.string(),
    pendingTransitions: v.array(v.any()),
    taxPool: v.number(),
    mapWidth: v.number(),
    mapHeight: v.number(),
    collisionGrid: v.string(),
  }),

  // 13. worldEvents
  worldEvents: defineTable({
    type: v.string(),
    name: v.string(),
    description: v.string(),
    startedAt: v.number(),
    duration: v.number(),
    effects: v.any(),
    locationId: v.union(v.id("locations"), v.null()),
    triggeredBy: v.string(),
    isActive: v.boolean(),
  }).index("by_isActive", ["isActive"]),

  // 14. templates
  templates: defineTable({
    category: v.string(),
    conditions: v.any(),
    variants: v.array(v.object({ text: v.string(), sentiment: v.number() })),
    cooldownPerPair: v.number(),
  }),

  // 15. templateUsage
  templateUsage: defineTable({
    templateCategory: v.string(),
    agentA: v.id("agents"),
    agentB: v.id("agents"),
    usedAt: v.number(),
  }).index("by_pair_category", ["agentA", "agentB", "templateCategory"]),

  // 16. activityLog
  activityLog: defineTable({
    type: v.string(),
    message: v.string(),
    agentIds: v.array(v.id("agents")),
    timestamp: v.number(),
    realTimestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_type", ["type", "timestamp"]),
});
