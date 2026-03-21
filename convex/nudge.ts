import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { CONFIG } from "./engine/constants";

// ---------------------------------------------------------------------------
// Event definitions for trigger_event
// ---------------------------------------------------------------------------

const EVENT_DEFS: Record<
  string,
  {
    name: string;
    description: string;
    duration: number;
    effects: Record<string, number>;
  }
> = {
  festival: {
    name: "Town Festival",
    description: "Everyone gathers in the square for food and music!",
    duration: 4,
    effects: { social_boost: 20, fun_boost: 15, shop_prices: 0.7 },
  },
  market_day: {
    name: "Market Day",
    description: "Special prices at all shops today.",
    duration: 8,
    effects: { shop_prices: 0.5 },
  },
  storm: {
    name: "Heavy Storm",
    description: "A fierce storm rolls in. Best to stay indoors.",
    duration: 3,
    effects: { mood_outdoor: -15, force_indoors: 1 },
  },
  sickness: {
    name: "Flu Outbreak",
    description: "A cold is spreading. Energy drains faster.",
    duration: 24,
    effects: { energy_drain: 1.5, doctor_demand: 2 },
  },
  harvest: {
    name: "Harvest Bounty",
    description: "The farm is overflowing! Food prices drop.",
    duration: 12,
    effects: { farm_production: 2.0, food_prices: 0.6 },
  },
};

// ---------------------------------------------------------------------------
// Valid speed values for change_speed
// ---------------------------------------------------------------------------

const VALID_SPEEDS = [0, 0.5, 1, 2, 4];

// ---------------------------------------------------------------------------
// Player nudge mutation — discriminated union on action.type
// ---------------------------------------------------------------------------

export const nudge = mutation({
  args: { action: v.any() },
  handler: async (ctx, { action }) => {
    const world = await ctx.db.query("worldState").first();
    if (!world) throw new Error("World not initialized");

    const now = world.time.totalTicks;
    const realNow = Date.now();

    switch (action.type) {
      // -------------------------------------------------------------------
      // suggest_talk
      // -------------------------------------------------------------------
      case "suggest_talk": {
        const { agentA: agentAId, agentB: agentBId, topic } = action;

        const agentA = await ctx.db.get(agentAId as Id<"agents">);
        const agentB = await ctx.db.get(agentBId as Id<"agents">);

        if (!agentA || !agentA.isActive) {
          return { success: false, reason: "Agent A not found or inactive" };
        }
        if (!agentB || !agentB.isActive) {
          return { success: false, reason: "Agent B not found or inactive" };
        }
        if (agentA.currentAction === "sleeping") {
          return { success: false, reason: `${agentA.name} is sleeping` };
        }
        if (agentB.currentAction === "sleeping") {
          return { success: false, reason: `${agentB.name} is sleeping` };
        }

        // Check not already in conversation together
        const activeConvos = await ctx.db
          .query("conversations")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .collect();

        const alreadyTalking = activeConvos.some(
          (c) =>
            c.participants.includes(agentAId) &&
            c.participants.includes(agentBId)
        );
        if (alreadyTalking) {
          return {
            success: false,
            reason: `${agentA.name} and ${agentB.name} are already in conversation`,
          };
        }

        // Calculate midpoint between the two agents
        const midX = (agentA.position.x + agentB.position.x) / 2;
        const midY = (agentA.position.y + agentB.position.y) / 2;

        // Queue conversation
        await ctx.db.insert("conversationQueue", {
          participants: [agentAId, agentBId],
          tier: "llm_deep",
          priority: CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY,
          triggerReason: "player_nudge",
          topic: topic ?? null,
          queuedAt: now,
          maxWait: CONFIG.CONVERSATIONS.PLAYER_NUDGE_MAX_WAIT_MS,
        });

        // Set both agents walking toward midpoint
        await ctx.db.patch(agentAId, {
          currentAction: "walking",
          currentDestination: { x: midX, y: midY },
          currentPath: null,
          actionQueue: [
            { type: "talking", target: agentBId },
            ...agentA.actionQueue,
          ],
        });

        await ctx.db.patch(agentBId, {
          currentAction: "walking",
          currentDestination: { x: midX, y: midY },
          currentPath: null,
          actionQueue: [
            { type: "talking", target: agentAId },
            ...agentB.actionQueue,
          ],
        });

        await ctx.db.insert("activityLog", {
          type: "player_nudge",
          message: `Player suggested ${agentA.name} and ${agentB.name} talk${topic ? ` about "${topic}"` : ""}`,
          agentIds: [agentAId, agentBId],
          timestamp: now,
          realTimestamp: realNow,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // suggest_go_to
      // -------------------------------------------------------------------
      case "suggest_go_to": {
        const { agentId, locationId } = action;

        const agent = await ctx.db.get(agentId as Id<"agents">);
        if (!agent || !agent.isActive) {
          return { success: false, reason: "Agent not found or inactive" };
        }
        if (agent.currentAction === "sleeping") {
          return { success: false, reason: `${agent.name} is sleeping` };
        }

        const location = await ctx.db.get(locationId as Id<"locations">);
        if (!location) {
          return { success: false, reason: "Location not found" };
        }

        await ctx.db.patch(agentId, {
          currentAction: "walking",
          currentDestination: {
            x: location.entryPoint.x,
            y: location.entryPoint.y,
            locationId,
          },
          currentPath: null,
        });

        await ctx.db.insert("activityLog", {
          type: "player_nudge",
          message: `Player sent ${agent.name} to ${location.name}`,
          agentIds: [agentId],
          timestamp: now,
          realTimestamp: realNow,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // trigger_event
      // -------------------------------------------------------------------
      case "trigger_event": {
        const { eventType } = action;

        const eventDef = EVENT_DEFS[eventType];
        if (!eventDef) {
          return {
            success: false,
            reason: `Unknown event type: ${eventType}`,
          };
        }

        // Check for duplicate active event of same type
        const activeEvents = await ctx.db
          .query("worldEvents")
          .withIndex("by_isActive", (q) => q.eq("isActive", true))
          .collect();

        const duplicateActive = activeEvents.some(
          (e) => e.type === eventType
        );
        if (duplicateActive) {
          return {
            success: false,
            reason: `A "${eventDef.name}" event is already active`,
          };
        }

        if (activeEvents.length >= CONFIG.EVENTS.MAX_CONCURRENT_EVENTS) {
          return {
            success: false,
            reason: `Maximum concurrent events reached (${CONFIG.EVENTS.MAX_CONCURRENT_EVENTS})`,
          };
        }

        await ctx.db.insert("worldEvents", {
          type: eventType,
          name: eventDef.name,
          description: eventDef.description,
          startedAt: now,
          duration: eventDef.duration,
          effects: eventDef.effects,
          locationId: null,
          triggeredBy: "player",
          isActive: true,
        });

        await ctx.db.insert("activityLog", {
          type: "player_event",
          message: `Player triggered: ${eventDef.name}`,
          agentIds: [],
          timestamp: now,
          realTimestamp: realNow,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // give_money
      // -------------------------------------------------------------------
      case "give_money": {
        const { agentId, amount } = action;

        if (typeof amount !== "number" || amount < 1 || amount > 500) {
          return {
            success: false,
            reason: "Amount must be between 1 and 500",
          };
        }

        const agent = await ctx.db.get(agentId as Id<"agents">);
        if (!agent || !agent.isActive) {
          return { success: false, reason: "Agent not found or inactive" };
        }

        const econ = await ctx.db
          .query("economy")
          .withIndex("by_agentId", (q) => q.eq("agentId", agentId))
          .first();

        if (!econ) {
          return { success: false, reason: "Economy record not found" };
        }

        await ctx.db.patch(econ._id, {
          money: econ.money + amount,
        });

        await ctx.db.insert("economyTransactions", {
          fromAgent: null,
          toAgent: agentId,
          amount,
          reason: "player_gift",
          itemsExchanged: null,
          locationId: null,
          timestamp: now,
        });

        await ctx.db.insert("activityLog", {
          type: "player_gift",
          message: `Player gave ${agent.name} $${amount}`,
          agentIds: [agentId],
          timestamp: now,
          realTimestamp: realNow,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // change_speed
      // -------------------------------------------------------------------
      case "change_speed": {
        const { speed } = action;

        if (!VALID_SPEEDS.includes(speed)) {
          return {
            success: false,
            reason: `Invalid speed. Must be one of: ${VALID_SPEEDS.join(", ")}`,
          };
        }

        await ctx.db.patch(world._id, {
          tickSpeed: speed,
          isPaused: speed === 0,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // toggle_pause
      // -------------------------------------------------------------------
      case "toggle_pause": {
        const newPaused = !world.isPaused;

        await ctx.db.patch(world._id, {
          isPaused: newPaused,
          tickSpeed: newPaused ? 0 : 1,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // introduce_agent
      // -------------------------------------------------------------------
      case "introduce_agent": {
        const { name, bio, traits, job } = action;

        // Count active agents
        const activeAgents = await ctx.db
          .query("agents")
          .filter((q) => q.eq(q.field("isActive"), true))
          .collect();

        if (activeAgents.length >= CONFIG.MAX_AGENTS) {
          return {
            success: false,
            reason: `Maximum agents reached (${CONFIG.MAX_AGENTS})`,
          };
        }

        // Find available home
        const homes = await ctx.db
          .query("locations")
          .filter((q) => q.eq(q.field("type"), "home"))
          .collect();

        const availableHome = homes.find(
          (h) => h.currentOccupants.length < h.capacity
        );
        if (!availableHome) {
          return { success: false, reason: "No available housing" };
        }

        // Find workplace based on job type
        const workplaces = await ctx.db
          .query("locations")
          .filter((q) =>
            q.and(
              q.neq(q.field("type"), "home"),
              q.neq(q.field("type"), "park"),
              q.neq(q.field("type"), "plaza")
            )
          )
          .collect();

        const workplace =
          workplaces.find(
            (w) =>
              w.type.toLowerCase().includes(job.toLowerCase()) ||
              w.name.toLowerCase().includes(job.toLowerCase())
          ) ?? workplaces[0] ?? null;

        // Create agent
        const agentId = await ctx.db.insert("agents", {
          name,
          bio,
          traits,
          age: 25,
          gender: "neutral",
          spriteSheet: "default",
          portraitSprite: "default",
          position: {
            x: availableHome.entryPoint.x,
            y: availableHome.entryPoint.y,
          },
          currentDestination: null,
          currentLocation: availableHome._id,
          currentAction: "idle",
          actionStarted: now,
          actionDuration: null,
          actionQueue: [],
          currentPath: null,
          schedule: {
            wakeTime: 7,
            sleepTime: 23,
            workStart: 9,
            workEnd: 17,
            lunchTime: 12,
            freeTimePreferences: ["socializing", "shopping"],
          },
          home: availableHome._id,
          workplace: workplace ? workplace._id : null,
          createdAt: now,
          isActive: true,
        });

        // Add agent to home occupants
        await ctx.db.patch(availableHome._id, {
          currentOccupants: [...availableHome.currentOccupants, agentId],
        });

        // Create needs record
        await ctx.db.insert("needs", {
          agentId,
          hunger: 80,
          energy: 80,
          social: 80,
          comfort: 80,
          fun: 80,
          mood: 80,
          stress: 10,
          decayRates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES },
          thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
          moodModifiers: [],
          lastUpdated: now,
        });

        // Create economy record
        await ctx.db.insert("economy", {
          agentId,
          job,
          jobTitle: job,
          salary: 20,
          workPerformance: 0.7,
          money: CONFIG.ECONOMY.STARTING_MONEY,
          dailyExpenses: CONFIG.ECONOMY.DAILY_EXPENSES.min,
          inventory: [],
          lastPayday: now,
          productionRemainder: 0,
        });

        // Trigger new_arrival world event
        await ctx.db.insert("worldEvents", {
          type: "new_arrival",
          name: "New Arrival",
          description: `${name} has moved to town!`,
          startedAt: now,
          duration: 1,
          effects: {},
          locationId: availableHome._id,
          triggeredBy: "player",
          isActive: true,
        });

        await ctx.db.insert("activityLog", {
          type: "player_introduce",
          message: `Player introduced ${name} to the town`,
          agentIds: [agentId],
          timestamp: now,
          realTimestamp: realNow,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // remove_agent
      // -------------------------------------------------------------------
      case "remove_agent": {
        const { agentId } = action;

        const agent = await ctx.db.get(agentId as Id<"agents">);
        if (!agent) {
          return { success: false, reason: "Agent not found" };
        }
        if (!agent.isActive) {
          return { success: false, reason: "Agent is already inactive" };
        }

        // Deactivate agent
        await ctx.db.patch(agentId, { isActive: false });

        // End any active conversations involving this agent
        const activeConvos = await ctx.db
          .query("conversations")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .collect();

        for (const convo of activeConvos) {
          if (convo.participants.includes(agentId)) {
            await ctx.db.patch(convo._id, {
              status: "ended",
              endedAt: now,
            });
          }
        }

        // Remove from location currentOccupants
        if (agent.currentLocation) {
          const location = await ctx.db.get(agent.currentLocation as Id<"locations">);
          if (location) {
            await ctx.db.patch(location._id, {
              currentOccupants: location.currentOccupants.filter(
                (id: Id<"agents">) => id !== agentId
              ),
            });
          }
        }

        await ctx.db.insert("activityLog", {
          type: "player_remove",
          message: `Player removed ${agent.name} from the town`,
          agentIds: [agentId],
          timestamp: now,
          realTimestamp: realNow,
        });

        return { success: true };
      }

      // -------------------------------------------------------------------
      // Unknown action type
      // -------------------------------------------------------------------
      default:
        return { success: false, reason: `Unknown action type: ${action.type}` };
    }
  },
});
