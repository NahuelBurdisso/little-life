import { db } from '../../db';
import {
  agents, needs, economy, relationships, agentStates,
  conversationQueue, conversationSchedulerState,
} from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import type { HealthSnapshot, AnalysisWindow } from '../types';

// Relationship statuses that count as a real social connection. Everything else
// ('strangers', 'acquaintances') is the default/near-default state and does not.
const MEANINGFUL_STATUSES = new Set([
  'friends', 'close_friends', 'best_friends',
  'rivals', 'enemies',
  'romantic_interest', 'partners', 'complicated',
]);

// Expected max durations for states (in game minutes, the agent-state clock) — used to detect stuck states
const STATE_EXPECTED_DURATIONS: Record<string, number> = {
  drunk: 480,
  hungover: 360,
  angry: 1200,
  sick: 2880,
  stressed: 1440,
  euphoric: 720,
  infatuated: 7200,
  jealous: 4320,
  heartbroken: 7200,
  depressed: 14400,
  lonely: 4320,
  confident: 2880,
  grieving: 14400,
  in_debt: 999999,   // exits via condition, not duration
  alcoholic: 999999,  // exits via condition
};

export class HealthCollector {
  /** Lifetime queue-timeout total as of the previous window, used to report a delta. */
  private prevTimeoutsTotal = 0;

  /**
   * Drop the lifetime-counter cursor. Required when the world is wiped: the
   * scheduler's queueTimeoutsTotal restarts at 0, and a surviving cursor would
   * clamp timeoutsThisWindow to 0 until the new world passed the old total.
   */
  reset() {
    this.prevTimeoutsTotal = 0;
  }

  collect(window: AnalysisWindow): HealthSnapshot {
    const { endMinutes } = window;

    // ── Needs distribution ────────────────────────────────────────────────
    const allNeeds = db.select({
      agent_id: needs.agent_id,
      hunger: needs.hunger,
      energy: needs.energy,
      social: needs.social,
      comfort: needs.comfort,
      fun: needs.fun,
      mood: needs.mood,
      stress: needs.stress,
    }).from(needs).all();

    const below15: Record<string, number> = { hunger: 0, energy: 0, social: 0, comfort: 0, fun: 0 };
    const above85: Record<string, number> = { hunger: 0, energy: 0, social: 0, comfort: 0, fun: 0 };
    let moodSum = 0;
    const moods: number[] = [];
    let stressed = 0;

    for (const n of allNeeds) {
      for (const key of ['hunger', 'energy', 'social', 'comfort', 'fun'] as const) {
        if (n[key] < 15) below15[key]++;
        if (n[key] > 85) above85[key]++;
      }
      moodSum += n.mood;
      moods.push(n.mood);
      if (n.stress > 30) stressed++;
    }

    const avgMood = moods.length > 0 ? moodSum / moods.length : 50;
    const moodVariance = moods.length > 0
      ? moods.reduce((s, m) => s + (m - avgMood) ** 2, 0) / moods.length
      : 0;
    const moodStdDev = Math.sqrt(moodVariance);

    // ── Social isolation ──────────────────────────────────────────────────
    const activeAgents = db.select({
      id: agents.id,
      name: agents.name,
    }).from(agents).where(eq(agents.is_active, true)).all();

    // Orphans: agents with no relationship above acquaintance level
    const allRels = db.select({
      agent_a: relationships.agent_a,
      agent_b: relationships.agent_b,
      friendship_ab: relationships.friendship_ab,
      friendship_ba: relationships.friendship_ba,
      status: relationships.status,
    }).from(relationships).all();

    const connectedAgents = new Set<number>();
    for (const r of allRels) {
      const hasMeaningful = r.friendship_ab > 20 || r.friendship_ba > 20
        || MEANINGFUL_STATUSES.has(r.status);
      if (hasMeaningful) {
        connectedAgents.add(r.agent_a);
        connectedAgents.add(r.agent_b);
      }
    }

    const orphanNames: string[] = [];
    let isolated = 0;
    for (const a of activeAgents) {
      if (!connectedAgents.has(a.id)) {
        orphanNames.push(a.name);
        isolated++;
      }
    }

    // ── State health ──────────────────────────────────────────────────────
    const allStates = db.select({
      agent_id: agentStates.agent_id,
      type: agentStates.type,
      started_at: agentStates.started_at,
      duration: agentStates.duration,
    }).from(agentStates).all();

    const stateDistribution: Record<string, number> = {};
    const stuckStates: HealthSnapshot['stuckStates'] = [];

    for (const s of allStates) {
      stateDistribution[s.type] = (stateDistribution[s.type] || 0) + 1;

      const elapsed = endMinutes - s.started_at; // state clock: game minutes
      // Only state types with a known expected duration can be judged stuck.
      // Falling back to s.duration would flag every conditional-exit state
      // (duration 0) as stuck on its very first tick.
      const expected = STATE_EXPECTED_DURATIONS[s.type];
      if (expected !== undefined && expected < 999999 && elapsed > expected * 3) {
        const agent = activeAgents.find(a => a.id === s.agent_id);
        stuckStates.push({
          agentId: s.agent_id,
          agentName: agent?.name ?? `Agent#${s.agent_id}`,
          stateType: s.type,
          durationTicks: elapsed,
          expectedMaxDuration: expected,
        });
      }
    }

    // ── Economy health ────────────────────────────────────────────────────
    const allEcon = db.select({
      money: economy.money,
    }).from(economy).all();

    let brokeCount = 0;
    let wealthyCount = 0;
    let moneySum = 0;
    for (const e of allEcon) {
      moneySum += e.money;
      if (e.money < 5) brokeCount++;
      if (e.money > 200) wealthyCount++;
    }
    const avgMoney = allEcon.length > 0 ? moneySum / allEcon.length : 0;
    const target = CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY;

    // ── Conversation pipeline ─────────────────────────────────────────────
    let queueDepth = 0;
    let queueOldestMs = 0;
    let slotsInUse = 0;
    let timeoutsTotal = this.prevTimeoutsTotal;
    const maxSlots = CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM;

    try {
      const queueEntries = db.select({
        queued_at: conversationQueue.queued_at,
      }).from(conversationQueue).all();
      queueDepth = queueEntries.length;
      if (queueEntries.length > 0) {
        const now = Date.now();
        // reduce() instead of Math.max(...arr) — spreading a large array blows the stack.
        queueOldestMs = queueEntries.reduce(
          (max, q) => (now - q.queued_at > max ? now - q.queued_at : max),
          0,
        );
      }

      const scheduler = db.select({
        active_llm_conversations: conversationSchedulerState.active_llm_conversations,
        stats: conversationSchedulerState.stats,
      }).from(conversationSchedulerState).limit(1).get();

      if (scheduler) {
        slotsInUse = scheduler.active_llm_conversations.length;
        timeoutsTotal = scheduler.stats?.queueTimeoutsTotal ?? 0;
      }
    } catch { /* fresh DB */ }

    // queueTimeoutsTotal is a lifetime counter; report the per-window delta.
    const timeoutsDelta = Math.max(0, timeoutsTotal - this.prevTimeoutsTotal);
    this.prevTimeoutsTotal = timeoutsTotal;

    return {
      needsBelow15: below15,
      needsAbove85: above85,
      avgMood,
      moodStdDev,
      stressedAgents: stressed,

      isolatedAgents: isolated,
      orphanAgentNames: orphanNames,

      stuckStates,
      stateDistribution,

      brokeAgents: brokeCount,
      wealthyAgents: wealthyCount,
      avgMoney,
      deflationRisk: avgMoney < target * 0.5,
      inflationRisk: avgMoney > target * 1.5,

      queueDepth,
      queueOldestMs: queueOldestMs,
      slotsInUse,
      slotsMax: maxSlots,
      timeoutsThisWindow: timeoutsDelta,
    };
  }
}
