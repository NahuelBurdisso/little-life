import { db } from '../../db';
import {
  agents, conversations, relationshipEvents, activityLog, goals,
  locations, economyTransactions, agentStates,
} from '../../db/schema';
import { eq, and, gte } from 'drizzle-orm';
import type { EngagementSnapshot, AnalysisWindow } from '../types';

export class EngagementCollector {
  collect(window: AnalysisWindow): EngagementSnapshot {
    // startTick bounds tick-valued columns; startMs bounds Date.now()-valued ones.
    const { startTick, startMs, startMinutes } = window;

    // ── Action distribution (current snapshot) ────────────────────────────
    const agentRows = db.select({
      current_action: agents.current_action,
    }).from(agents).where(eq(agents.is_active, true)).all();

    const actionDist: Record<string, number> = {};
    for (const a of agentRows) {
      const action = (a.current_action as any)?.type || 'idle';
      actionDist[action] = (actionDist[action] || 0) + 1;
    }

    let dominantAction = 'idle';
    let dominantCount = 0;
    for (const [action, count] of Object.entries(actionDist)) {
      if (count > dominantCount) {
        dominantAction = action;
        dominantCount = count;
      }
    }
    const pop = agentRows.length || 1;
    const uniqueActions = Object.keys(actionDist).length;

    // ── Conversations ─────────────────────────────────────────────────────
    const recentConvos = db.select({
      id: conversations.id,
      status: conversations.status,
      participants: conversations.participants,
      topic: conversations.topic,
      quality_score: conversations.quality_score,
      trigger_reason: conversations.trigger_reason,
      started_at: conversations.started_at,
    }).from(conversations).where(
      gte(conversations.started_at, startMs)
    ).all();

    const started = recentConvos.length;
    const ended = recentConvos.filter(c => c.status === 'ended').length;

    let qualitySum = 0;
    let qualityCount = 0;
    let llmCount = 0;
    let templateCount = 0;
    const pairSet = new Set<string>();
    const topicDist: Record<string, number> = {};
    const pairTopicSet = new Set<string>();
    let repeatedTopicPairs = 0;

    for (const c of recentConvos) {
      if (c.quality_score != null) {
        qualitySum += c.quality_score;
        qualityCount++;
      }
      const isTemplate = (c.trigger_reason || '').includes('template');
      if (isTemplate) templateCount++;
      else llmCount++;

      const parts = (c.participants as number[]).sort((a, b) => a - b);
      pairSet.add(parts.join(','));

      const topic = c.topic || 'none';
      topicDist[topic] = (topicDist[topic] || 0) + 1;

      const pairTopicKey = `${parts.join(',')}_${topic}`;
      if (pairTopicSet.has(pairTopicKey)) {
        repeatedTopicPairs++;
      }
      pairTopicSet.add(pairTopicKey);
    }

    const totalConvos = llmCount + templateCount;
    const templateRatio = totalConvos > 0 ? templateCount / totalConvos : 0;

    // ── Relationship deltas ───────────────────────────────────────────────
    const relEvents = db.select({
      friendship_delta_ab: relationshipEvents.friendship_delta_ab,
      friendship_delta_ba: relationshipEvents.friendship_delta_ba,
      romance_delta_ab: relationshipEvents.romance_delta_ab,
      romance_delta_ba: relationshipEvents.romance_delta_ba,
      trust_delta_ab: relationshipEvents.trust_delta_ab,
      trust_delta_ba: relationshipEvents.trust_delta_ba,
    }).from(relationshipEvents).where(
      gte(relationshipEvents.timestamp, startMs)
    ).all();

    let totalDeltas = 0;
    let zeroDeltaCount = 0;
    for (const e of relEvents) {
      const sum = Math.abs(e.friendship_delta_ab) + Math.abs(e.friendship_delta_ba)
        + Math.abs(e.romance_delta_ab) + Math.abs(e.romance_delta_ba)
        + Math.abs(e.trust_delta_ab) + Math.abs(e.trust_delta_ba);
      totalDeltas += sum;
      if (sum < 0.1) zeroDeltaCount++;
    }

    // Status changes tracked via activity log
    let statusChanges = 0;
    try {
      const statusLogs = db.select({ id: activityLog.id }).from(activityLog).where(
        and(
          gte(activityLog.timestamp, startTick),
          eq(activityLog.type, 'relationship_status_change'),
        )
      ).all();
      statusChanges = statusLogs.length;
    } catch { /* type may not exist */ }

    // ── Drama events ──────────────────────────────────────────────────────
    const dramaLogs = db.select({
      id: activityLog.id,
      metadata: activityLog.metadata,
    }).from(activityLog).where(
      and(
        eq(activityLog.category, 'drama'),
        gte(activityLog.timestamp, startTick),
      )
    ).all();

    // Deepest observed depth per chain, so avgCascadeDepth is a true mean across chains.
    const chainDepths = new Map<string, number>();
    for (const l of dramaLogs) {
      const meta = l.metadata as { chainId?: string; chainDepth?: number } | null;
      if (meta?.chainId) {
        const depth = meta.chainDepth ?? 0;
        const prev = chainDepths.get(meta.chainId);
        if (prev === undefined || depth > prev) chainDepths.set(meta.chainId, depth);
      }
    }
    const depthSum = [...chainDepths.values()].reduce((a, b) => a + b, 0);

    // State transitions
    let stateTransitions = 0;
    try {
      const newStates = db.select({ id: agentStates.id }).from(agentStates).where(
        gte(agentStates.started_at, startMinutes) // state clock: game minutes
      ).all();
      stateTransitions = newStates.length;
    } catch { /* */ }

    // ── Spatial ───────────────────────────────────────────────────────────
    const locs = db.select({
      id: locations.id,
      name: locations.name,
      current_occupants: locations.current_occupants,
      operating_hours: locations.operating_hours,
    }).from(locations).all();

    let occupied = 0;
    let largest = 0;
    const emptyLocations: EngagementSnapshot['emptyLocations'] = [];
    for (const loc of locs) {
      const occ = (loc.current_occupants as number[]).length;
      if (occ > 0) {
        occupied++;
        if (occ > largest) largest = occ;
      } else {
        emptyLocations.push({
          name: loc.name,
          operatingHours: loc.operating_hours as { open: number; close: number } | null,
        });
      }
    }

    const moving = agentRows.filter(a => (a.current_action as any)?.type === 'walking').length;

    // ── Goals ─────────────────────────────────────────────────────────────
    let goalsCreated = 0;
    let goalsCompleted = 0;
    let goalsAbandoned = 0;
    let stalledGoals = 0;
    // Goal stamps are game minutes (systems/goals.ts).
    try {
      goalsCreated = db.select({ id: goals.id }).from(goals).where(
        gte(goals.created_at, startMinutes)
      ).all().length;

      // Measured on completed_at so goals created before the window but finished
      // inside it are counted. Rows with a NULL completed_at never match.
      goalsCompleted = db.select({ id: goals.id }).from(goals).where(
        and(eq(goals.status, 'completed'), gte(goals.completed_at, startMinutes))
      ).all().length;

      goalsAbandoned = db.select({ id: goals.id }).from(goals).where(
        and(eq(goals.status, 'abandoned'), gte(goals.completed_at, startMinutes))
      ).all().length;

      // Stalled = active + zero progress + created before this window
      const activeGoals = db.select({
        progress: goals.progress,
        created_at: goals.created_at,
      }).from(goals).where(eq(goals.status, 'active')).all();

      stalledGoals = activeGoals.filter(g =>
        g.progress < 1 && g.created_at < startMinutes - 120
      ).length;
    } catch { /* */ }

    // ── Economy ───────────────────────────────────────────────────────────
    let txCount = 0;
    let moneyMoved = 0;
    try {
      const txns = db.select({
        amount: economyTransactions.amount,
      }).from(economyTransactions).where(
        gte(economyTransactions.timestamp, startMs)
      ).all();
      txCount = txns.length;
      moneyMoved = txns.reduce((s, t) => s + Math.abs(t.amount), 0);
    } catch { /* */ }

    // ── Replans ───────────────────────────────────────────────────────────
    let replans = 0;
    try {
      const replanLogs = db.select({ id: activityLog.id }).from(activityLog).where(
        and(
          gte(activityLog.timestamp, startTick),
          eq(activityLog.type, 'plan_changed'),
        )
      ).all();
      replans = replanLogs.length;
    } catch { /* */ }

    return {
      actionDistribution: actionDist,
      dominantAction,
      dominantActionRatio: dominantCount / pop,
      uniqueActionsUsed: uniqueActions,

      conversationsStarted: started,
      conversationsEnded: ended,
      avgQualityScore: qualityCount > 0 ? qualitySum / qualityCount : 0,
      llmConversations: llmCount,
      templateConversations: templateCount,
      templateRatio,
      uniqueConversationPairs: pairSet.size,
      topicDistribution: topicDist,
      repeatedTopicPairs,

      totalRelationshipDeltas: totalDeltas,
      relationshipsWithZeroDelta: zeroDeltaCount,
      newStatusChanges: statusChanges,

      dramaEvents: dramaLogs.length,
      cascadeChains: chainDepths.size,
      avgCascadeDepth: chainDepths.size > 0 ? depthSum / chainDepths.size : 0,
      stateTransitions,

      occupiedLocations: occupied,
      totalLocations: locs.length,
      emptyLocations,
      largestCluster: largest,
      agentsMoving: moving,

      goalsCreated,
      goalsCompleted,
      goalsAbandoned,
      stalledGoals,

      transactions: txCount,
      moneyMoved,

      replansThisWindow: replans,
    };
  }
}
