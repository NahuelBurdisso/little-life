import type {
  EngagementSnapshot, HealthSnapshot, PerfSnapshot,
  AnalysisWindow, Diagnosis, DayPhase,
} from './types';
import { CONFIG } from '../lib/constants';
import { isOpenAt } from '../lib/gameClock';

// Phase-aware expectations: what's normal at each time of day
const PHASE_WEIGHTS: Record<DayPhase, { convoWeight: number; dramaWeight: number; sleepNormal: number }> = {
  night:     { convoWeight: 0.1, dramaWeight: 0.1, sleepNormal: 0.8 },
  dawn:      { convoWeight: 0.2, dramaWeight: 0.2, sleepNormal: 0.3 },
  morning:   { convoWeight: 0.5, dramaWeight: 0.5, sleepNormal: 0.0 },
  afternoon: { convoWeight: 1.0, dramaWeight: 1.0, sleepNormal: 0.0 },
  evening:   { convoWeight: 1.2, dramaWeight: 1.2, sleepNormal: 0.0 },
};

/**
 * Absolute minimum activity a healthy sim is expected to produce per window.
 * The EMA baselines are self-referential — a sim that is boring from startup
 * would otherwise normalize its own boredom and never trigger a drought — so
 * every baseline is floored against these fixed values.
 */
const BASELINE_FLOORS = {
  avgConvosPerWindow: 2,
  avgDramaPerWindow: 1,
  avgRelDeltaPerWindow: 5,
};

interface Baselines {
  avgConvosPerWindow: number;
  avgDramaPerWindow: number;
  avgRelDeltaPerWindow: number;
  avgQualityScore: number;
  avgTickMs: number;
}

/**
 * Raw per-window conditions behind the "sustained pattern" diagnoses.
 *
 * These MUST be recorded independently of whether the matching diagnosis was
 * emitted. Gating emission on a count of previously EMITTED diagnoses of the
 * same type is self-referential — the type can only fire once it has already
 * fired N times — so those five diagnoses were unreachable forever.
 */
export interface DiagnosisConditions {
  socialStagnation: boolean;
  dramaDesert: boolean;
  cascadeSilence: boolean;
  moodFlatline: boolean;
  economicStasis: boolean;
}

/**
 * Evaluate the sustained-pattern conditions for a single window. Pure; the
 * caller records the result so later windows can count consecutive occurrences.
 */
export function computeDiagnosisConditions(
  engagement: EngagementSnapshot,
  health: HealthSnapshot,
  window: AnalysisWindow,
): DiagnosisConditions {
  const pop = window.agentCount || 1;
  const pw = PHASE_WEIGHTS[window.dayPhase];

  return {
    socialStagnation: engagement.totalRelationshipDeltas < 1 && pw.convoWeight >= 0.5 && pop > 3,
    dramaDesert: engagement.dramaEvents === 0 && engagement.cascadeChains === 0 && pw.dramaWeight >= 0.5,
    cascadeSilence: engagement.cascadeChains === 0 && engagement.dramaEvents > 0 && pw.dramaWeight >= 0.5,
    moodFlatline: health.moodStdDev < 5 && pop > 3 && pw.convoWeight >= 0.5,
    economicStasis: engagement.transactions === 0 && engagement.moneyMoved === 0 && pw.convoWeight >= 0.5,
  };
}

export function diagnose(
  engagement: EngagementSnapshot,
  health: HealthSnapshot,
  perf: PerfSnapshot,
  window: AnalysisWindow,
  baselines: Baselines,
  /** Conditions from the previous windows (oldest first), excluding this one. */
  conditionHistory: DiagnosisConditions[],
): Diagnosis[] {
  const diagnoses: Diagnosis[] = [];
  const pop = window.agentCount || 1;
  const phase = window.dayPhase;
  const pw = PHASE_WEIGHTS[phase];

  // Current-window conditions, plus the length of the UNBROKEN run of prior
  // windows that also held each one, counted back from the most recent. A fresh
  // process therefore still needs N+1 windows to trip a gate — that debounce is
  // intentional.
  //
  // A run, not a plain occurrence count over the retained history: the evidence
  // strings below all assert "N+ CONSECUTIVE windows", and `filter().length`
  // admits gaps. With DIAGNOSIS_MEMORY_WINDOWS = 3 and a `>= 2` gate, priors
  // [true, false, true] counted 2 and fired, so a problem that resolved for a
  // window and then recurred re-fired immediately at full severity while
  // claiming three windows of evidence it did not have.
  const cond = computeDiagnosisConditions(engagement, health, window);
  const priorConsecutiveWindowsWith = (k: keyof DiagnosisConditions) => {
    let run = 0;
    for (let i = conditionHistory.length - 1; i >= 0 && conditionHistory[i][k]; i--) run++;
    return run;
  };

  // LLM stats are computed over a truncated sample when the collector's leak
  // guard drops records, so the numbers below are undercounts.
  const llmSampleTruncated = perf.llm.droppedSamples > 0;
  const truncationNote = llmSampleTruncated
    ? ` (WARNING: ${perf.llm.droppedSamples} LLM samples dropped — figures are computed over a truncated, oldest-dropped sample)`
    : '';

  // ── Engagement Diagnoses ──────────────────────────────────────────────

  // Conversation drought (time-aware)
  const expectedConvos = Math.max(1, baselines.avgConvosPerWindow * pw.convoWeight);
  if (engagement.conversationsStarted < expectedConvos * 0.3 && pw.convoWeight >= 0.5) {
    diagnoses.push({
      type: 'conversation_drought',
      severity: engagement.conversationsStarted === 0 ? 'high' : 'medium',
      evidence: `${engagement.conversationsStarted} convos this window (expected ~${Math.round(expectedConvos)})`,
      suggestion: 'Suggest talk between agents with high social need',
      autoFixable: true,
    });
  }

  // Template domination (LLM quality issue)
  if (engagement.templateRatio > 0.6 && engagement.conversationsEnded > 2) {
    diagnoses.push({
      type: 'template_domination',
      severity: engagement.templateRatio > 0.8 ? 'critical' : 'high',
      evidence: `${(engagement.templateRatio * 100).toFixed(0)}% template convos — LLM not keeping up`,
      suggestion: 'Reduce conversation frequency or increase MAX_CONCURRENT_LLM',
      autoFixable: false,
    });
  }

  // Conversation sameness
  if (engagement.repeatedTopicPairs > pop * 0.3 && engagement.conversationsEnded > 3) {
    diagnoses.push({
      type: 'conversation_sameness',
      severity: 'medium',
      evidence: `${engagement.repeatedTopicPairs} repeated pair+topic combos`,
      suggestion: 'Inject secrets or trigger events for new topics',
      autoFixable: true,
    });
  }

  // Social stagnation (sustained)
  if (cond.socialStagnation) {
    if (priorConsecutiveWindowsWith('socialStagnation') >= 2) {
      diagnoses.push({
        type: 'social_stagnation',
        severity: 'high',
        evidence: `Near-zero relationship changes for 3+ consecutive windows`,
        suggestion: 'Force confrontation between tense pair or introduce new agent',
        autoFixable: true,
      });
    }
  }

  // Drama desert (time-aware)
  if (cond.dramaDesert) {
    if (priorConsecutiveWindowsWith('dramaDesert') >= 1) {
      diagnoses.push({
        type: 'drama_desert',
        severity: 'medium',
        evidence: `Zero drama events for 2+ windows during active hours`,
        suggestion: 'Trigger event to shake things up',
        autoFixable: true,
      });
    }
  }

  // Cascade silence (separate from drama — cascades specifically not firing)
  if (cond.cascadeSilence) {
    if (priorConsecutiveWindowsWith('cascadeSilence') >= 2) {
      diagnoses.push({
        type: 'cascade_silence',
        severity: 'low',
        evidence: `Drama events occur but produce no cascading effects`,
        suggestion: 'Check cascade/ripple system — events may lack witness propagation',
        autoFixable: false,
      });
    }
  }

  // Spatial monoculture (daytime only)
  if (engagement.dominantActionRatio > 0.7 && pw.sleepNormal < 0.3) {
    // Exception: if dominant action is "working" during morning, that's normal
    if (!(engagement.dominantAction === 'working' && (phase === 'morning' || phase === 'afternoon'))) {
      diagnoses.push({
        type: 'spatial_monoculture',
        severity: engagement.dominantActionRatio > 0.85 ? 'high' : 'medium',
        evidence: `${(engagement.dominantActionRatio * 100).toFixed(0)}% of agents doing "${engagement.dominantAction}"`,
        suggestion: 'Send agents to different locations or trigger diverse event',
        autoFixable: true,
      });
    }
  }

  // Dead zones (operating hours check)
  if (engagement.emptyLocations.length > 0) {
    const deadDuringHours: string[] = [];
    for (const loc of engagement.emptyLocations) {
      const hours = loc.operatingHours;
      if (isOpenAt(hours, window.gameHour)) {
        deadDuringHours.push(loc.name);
      }
    }

    if (deadDuringHours.length > 2) {
      diagnoses.push({
        type: 'dead_zone',
        severity: deadDuringHours.length > 4 ? 'high' : 'low',
        evidence: `Empty during operating hours: ${deadDuringHours.slice(0, 5).join(', ')}`,
        suggestion: 'Send curious/social agents to empty locations',
        autoFixable: true,
      });
    }
  }

  // Goal graveyard
  if (engagement.stalledGoals > 0) {
    const stalledRatio = engagement.stalledGoals / Math.max(1, engagement.stalledGoals + engagement.goalsCompleted + engagement.goalsCreated);
    if (stalledRatio > 0.5 && engagement.stalledGoals >= 3) {
      diagnoses.push({
        type: 'goal_graveyard',
        severity: stalledRatio > 0.7 ? 'high' : 'medium',
        evidence: `${engagement.stalledGoals} goals stalled with no progress`,
        suggestion: 'Review goal system — agents may lack paths to goal targets',
        autoFixable: false,
      });
    }
  }

  // Mood flatline
  if (cond.moodFlatline) {
    if (priorConsecutiveWindowsWith('moodFlatline') >= 2) {
      diagnoses.push({
        type: 'mood_flatline',
        severity: 'medium',
        evidence: `Mood std dev: ${health.moodStdDev.toFixed(1)} — everyone at ~${health.avgMood.toFixed(0)}`,
        suggestion: 'Trigger contrasting events to diversify emotional states',
        autoFixable: true,
      });
    }
  }

  // Economic stasis
  if (cond.economicStasis) {
    if (priorConsecutiveWindowsWith('economicStasis') >= 2) {
      diagnoses.push({
        type: 'economic_stasis',
        severity: 'low',
        evidence: `Zero economic transactions for 3+ windows`,
        suggestion: 'Trigger market_day or traveling_merchant event',
        autoFixable: true,
      });
    }
  }

  // ── Health Diagnoses ──────────────────────────────────────────────────

  // Need death spiral
  const totalCriticals = Object.values(health.needsBelow15).reduce((a, b) => a + b, 0);
  if (totalCriticals > pop * 0.4) {
    diagnoses.push({
      type: 'need_death_spiral',
      severity: 'critical',
      evidence: `${totalCriticals} critical need instances across ${pop} agents`,
      suggestion: 'Check decision system — agents may not be self-correcting',
      autoFixable: false,
    });
  }

  // State stuck
  for (const stuck of health.stuckStates) {
    diagnoses.push({
      type: 'state_stuck',
      severity: stuck.durationTicks > stuck.expectedMaxDuration * 5 ? 'critical' : 'medium',
      evidence: `${stuck.agentName}: ${stuck.stateType} for ${stuck.durationTicks} ticks (expected max: ${stuck.expectedMaxDuration})`,
      suggestion: `Check conditional exit logic for ${stuck.stateType}`,
      affectedAgents: [stuck.agentId],
      autoFixable: false,
    });
  }

  // Isolation spiral
  for (const name of health.orphanAgentNames) {
    diagnoses.push({
      type: 'isolation_spiral',
      severity: 'medium',
      evidence: `${name} has zero meaningful relationships`,
      suggestion: 'Suggest conversation with a warm/social agent',
      autoFixable: true,
    });
  }

  // Wealth collapse
  if (health.brokeAgents > pop * 0.5) {
    diagnoses.push({
      type: 'wealth_collapse',
      severity: 'high',
      evidence: `${health.brokeAgents}/${pop} agents broke (money < 5). Avg: ${health.avgMoney.toFixed(0)}`,
      suggestion: 'Check salary distribution or trigger market event',
      autoFixable: false,
    });
  }

  // Conversation queue overflow
  if (health.queueDepth >= CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE) {
    diagnoses.push({
      type: 'conversation_queue_overflow',
      severity: 'high',
      evidence: `Queue at max (${health.queueDepth}/${CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE}). Oldest: ${(health.queueOldestMs / 1000).toFixed(0)}s`,
      suggestion: 'Increase MAX_QUEUE_SIZE or MAX_CONCURRENT_LLM',
      autoFixable: false,
    });
  }

  // ── Performance Diagnoses ─────────────────────────────────────────────

  // Tick overrun
  if (perf.ticksOverBudget > 0) {
    const slowPhase = perf.slowestPhase;
    const slowMs = perf.phaseTimings[slowPhase]?.maxMs ?? 0;
    diagnoses.push({
      type: 'tick_overrun',
      severity: perf.ticksOverBudget > 10 ? 'critical' : 'medium',
      evidence: `${perf.ticksOverBudget} ticks exceeded ${perf.tickBudgetMs}ms. Slowest: ${slowPhase} (${slowMs.toFixed(0)}ms)`,
      suggestion: `Optimize ${slowPhase} phase or increase tick interval`,
      autoFixable: false,
    });
  }

  // LLM bottleneck
  if (perf.llm.avgSlotUtilization > 0.8 && perf.llm.requestsStarted > 2) {
    diagnoses.push({
      type: 'llm_bottleneck',
      severity: perf.llm.avgSlotUtilization > 0.95 ? 'critical' : 'high',
      evidence: `LLM utilization ${(perf.llm.avgSlotUtilization * 100).toFixed(0)}%. ` +
        `Avg response: ${perf.llm.avgResponseMs.toFixed(0)}ms, p95: ${perf.llm.p95ResponseMs.toFixed(0)}ms. ` +
        `${perf.llm.slotSaturationTicks} ticks fully saturated` + truncationNote,
      suggestion: 'Increase MAX_CONCURRENT_LLM, reduce MAX_TURNS, or use faster model',
      autoFixable: false,
    });
  }

  // LLM quality degradation
  if (perf.llm.avgConversationQuality > 0 &&
      baselines.avgQualityScore > 0 &&
      perf.llm.avgConversationQuality < baselines.avgQualityScore * 0.7 &&
      perf.llm.requestsCompleted > 3) {
    diagnoses.push({
      type: 'llm_quality_degradation',
      severity: 'high',
      evidence: `Avg quality ${perf.llm.avgConversationQuality.toFixed(2)} vs baseline ${baselines.avgQualityScore.toFixed(2)}. ` +
        `Rejected: ${perf.llm.rejectedResponses}, Retries: ${perf.llm.retryCount}` + truncationNote,
      suggestion: 'Check LLM model health or review prompt construction',
      autoFixable: false,
    });
  }

  // Prompt bloat
  if (perf.llm.avgSystemPromptChars > 2000) {
    diagnoses.push({
      type: 'prompt_bloat',
      severity: perf.llm.avgSystemPromptChars > 3000 ? 'high' : 'low',
      evidence: `Avg system prompt: ${perf.llm.avgSystemPromptChars.toFixed(0)} chars (max_tokens only 80)` + truncationNote,
      suggestion: 'Review buildAgentSystemPrompt for unnecessary sections',
      autoFixable: false,
    });
  }

  return diagnoses;
}

export function computeBaselines(
  history: Array<{ engagement: EngagementSnapshot; health: HealthSnapshot; perf: PerfSnapshot }>,
): Baselines {
  if (history.length === 0) {
    return {
      ...BASELINE_FLOORS,
      avgQualityScore: 0.5,
      avgTickMs: 50,
    };
  }

  const α = 0.15;
  let convos = history[0].engagement.conversationsStarted;
  let drama = history[0].engagement.dramaEvents;
  let relDelta = history[0].engagement.totalRelationshipDeltas;
  let quality = history[0].perf.llm.avgConversationQuality || 0.5;
  let tickMs = history[0].perf.avgTickMs || 50;

  for (let i = 1; i < history.length; i++) {
    convos = α * history[i].engagement.conversationsStarted + (1 - α) * convos;
    drama = α * history[i].engagement.dramaEvents + (1 - α) * drama;
    relDelta = α * history[i].engagement.totalRelationshipDeltas + (1 - α) * relDelta;
    const q = history[i].perf.llm.avgConversationQuality;
    if (q > 0) quality = α * q + (1 - α) * quality;
    tickMs = α * history[i].perf.avgTickMs + (1 - α) * tickMs;
  }

  return {
    avgConvosPerWindow: Math.max(BASELINE_FLOORS.avgConvosPerWindow, convos),
    avgDramaPerWindow: Math.max(BASELINE_FLOORS.avgDramaPerWindow, drama),
    avgRelDeltaPerWindow: Math.max(BASELINE_FLOORS.avgRelDeltaPerWindow, relDelta),
    avgQualityScore: quality,
    avgTickMs: tickMs,
  };
}

export function computeScores(
  engagement: EngagementSnapshot,
  health: HealthSnapshot,
  perf: PerfSnapshot,
  window: AnalysisWindow,
  baselines: Baselines,
): { boredScore: number; healthScore: number; perfScore: number } {
  const pw = PHASE_WEIGHTS[window.dayPhase];
  const pop = window.agentCount || 1;

  // ── Boredom score (0 = great, 100 = very boring) ────────────────────
  let bored = 0;

  // Conversation deficit (0-25 points)
  const expectedConvos = baselines.avgConvosPerWindow * pw.convoWeight;
  if (expectedConvos > 0) {
    const deficit = 1 - Math.min(1, engagement.conversationsStarted / expectedConvos);
    bored += deficit * 25;
  }

  // Drama deficit (0-20 points)
  const expectedDrama = baselines.avgDramaPerWindow * pw.dramaWeight;
  if (expectedDrama > 0) {
    const deficit = 1 - Math.min(1, engagement.dramaEvents / expectedDrama);
    bored += deficit * 20;
  }

  // Relationship stagnation (0-15 points)
  const expectedDelta = baselines.avgRelDeltaPerWindow * pw.convoWeight;
  if (expectedDelta > 0) {
    const deficit = 1 - Math.min(1, engagement.totalRelationshipDeltas / expectedDelta);
    bored += deficit * 15;
  }

  // Action homogeneity (0-15 points, but sleep at night is OK)
  const adjustedDominant = engagement.dominantAction === 'sleeping'
    ? Math.max(0, engagement.dominantActionRatio - pw.sleepNormal)
    : engagement.dominantActionRatio;
  bored += Math.max(0, adjustedDominant - 0.5) * 30;  // 50%+ → up to 15 pts

  // Template ratio (0-10 points)
  bored += engagement.templateRatio * 10;

  // Goal stagnation (0-10 points)
  const totalGoals = engagement.stalledGoals + engagement.goalsCreated + engagement.goalsCompleted;
  if (totalGoals > 0) {
    bored += (engagement.stalledGoals / totalGoals) * 10;
  }

  // Empty locations (0-5 points)
  if (engagement.totalLocations > 0) {
    bored += (engagement.emptyLocations.length / engagement.totalLocations) * 5;
  }

  bored = Math.min(100, Math.max(0, bored));

  // ── Health score (100 = healthy, 0 = failing) ───────────────────────
  let healthScore = 100;

  // Critical needs penalty
  const totalCriticals = Object.values(health.needsBelow15).reduce((a, b) => a + b, 0);
  healthScore -= Math.min(30, (totalCriticals / pop) * 60);

  // Mood flatline penalty
  healthScore -= Math.max(0, 10 - health.moodStdDev);

  // Isolation penalty
  healthScore -= Math.min(20, (health.isolatedAgents / pop) * 40);

  // Stuck states
  healthScore -= Math.min(15, health.stuckStates.length * 5);

  // Economy
  if (health.deflationRisk) healthScore -= 10;
  if (health.inflationRisk) healthScore -= 5;
  healthScore -= Math.min(10, (health.brokeAgents / pop) * 20);

  // Queue health
  if (health.queueDepth >= CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE) healthScore -= 10;

  healthScore = Math.min(100, Math.max(0, healthScore));

  // ── Perf score (100 = great, 0 = problems) ─────────────────────────
  let perfScore = 100;

  // Tick overruns
  const tickCount = perf.tickDurations.length || 1;
  perfScore -= Math.min(30, (perf.ticksOverBudget / tickCount) * 60);

  // LLM bottleneck
  perfScore -= Math.min(25, perf.llm.avgSlotUtilization * 25);

  // LLM quality
  if (baselines.avgQualityScore > 0 && perf.llm.avgConversationQuality > 0) {
    const qualDrop = 1 - (perf.llm.avgConversationQuality / baselines.avgQualityScore);
    perfScore -= Math.max(0, qualDrop * 20);
  }

  // LLM call timeouts
  perfScore -= perf.llm.llmTimeoutRate * 15;

  // Rejected responses
  const rejRate = perf.llm.requestsCompleted > 0
    ? perf.llm.rejectedResponses / perf.llm.requestsCompleted : 0;
  perfScore -= rejRate * 10;

  perfScore = Math.min(100, Math.max(0, perfScore));

  return { boredScore: bored, healthScore, perfScore };
}
