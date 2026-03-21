import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { CONFIG } from "./constants";
import { DayPhase, Season, ClockTransition } from "../lib/types";
import { tick as needsTick } from "../systems/needs";
import { tick as economyTick } from "../systems/economy";
import { tick as relationshipsTick } from "../systems/relationships";
import { tick as conversationsTick } from "../systems/conversations";
import { tick as decisionsTick } from "../systems/decisions";
import { tick as movementTick } from "../systems/movement";
import { tick as eventsTick } from "../systems/events";

const SEASONS: Season[] = ["spring", "summer", "autumn", "winter"];

function getDayPhase(hour: number): DayPhase {
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}

const SYSTEM_TICKS = [
  needsTick,
  economyTick,
  relationshipsTick,
  conversationsTick,
  decisionsTick,
  movementTick,
  eventsTick,
] as const;

export const gameTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const world = await ctx.db.query("worldState").first();
    if (!world || world.isPaused) return;

    const transitions: ClockTransition[] = [];

    // Advance clock
    let { day, hour, minute, totalTicks, seasonDay, season } = world.time;
    const prevHour = hour;
    const prevDayPhase = getDayPhase(hour);
    const prevSeason = season as Season;

    minute += world.tickSpeed;

    if (minute >= 60) {
      hour += Math.floor(minute / 60);
      minute = minute % 60;
    }

    if (hour >= 24) {
      day += Math.floor(hour / 24);
      hour = hour % 24;
    }

    seasonDay = day % CONFIG.TIME.SEASON_LENGTH_DAYS;
    const seasonIndex = Math.floor(day / CONFIG.TIME.SEASON_LENGTH_DAYS) % 4;
    season = SEASONS[seasonIndex];

    // Generate transitions
    if (hour !== prevHour) {
      transitions.push({ type: "hour_changed", hour });
    }
    if (day !== world.time.day) {
      transitions.push({ type: "day_changed", day });
    }
    const newDayPhase = getDayPhase(hour);
    if (newDayPhase !== prevDayPhase) {
      transitions.push({ type: "phase_changed", from: prevDayPhase, to: newDayPhase });
    }
    if (season !== prevSeason) {
      transitions.push({ type: "season_changed", from: prevSeason, to: season as Season });
    }

    // Generate tick ID
    const tickId = Date.now().toString(36) + Math.random().toString(36).slice(2);

    // Update world state
    await ctx.db.patch(world._id, {
      time: {
        day,
        hour,
        minute,
        totalTicks: totalTicks + 1,
        seasonDay,
        season,
      },
      dayPhase: newDayPhase,
      pendingTransitions: transitions,
      tickId,
      currentTickPhase: 1,
    });

    // Kick off phase 1
    await ctx.scheduler.runAfter(0, internal.engine.tick.runPhase, {
      phase: 1,
      tickId,
    });
  },
});

export const runPhase = internalMutation({
  args: {
    phase: v.number(),
    tickId: v.string(),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.query("worldState").first();
    if (!world || world.tickId !== args.tickId) return;

    // All phases done
    if (args.phase > 7) {
      await ctx.db.patch(world._id, {
        pendingTransitions: [],
        lastTickCompleted: Date.now(),
        currentTickPhase: 0,
      });
      return;
    }

    // Run the current system phase
    const systemTick = SYSTEM_TICKS[args.phase - 1];
    try {
      await systemTick(ctx, world);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      await ctx.db.insert("activityLog", {
        type: "error",
        message: `System phase ${args.phase} error: ${message}`,
        agentIds: [],
        timestamp: Date.now(),
        realTimestamp: Date.now(),
      });
    }

    // Update current phase and chain to next
    await ctx.db.patch(world._id, { currentTickPhase: args.phase });
    await ctx.scheduler.runAfter(0, internal.engine.tick.runPhase, {
      phase: args.phase + 1,
      tickId: args.tickId,
    });
  },
});
