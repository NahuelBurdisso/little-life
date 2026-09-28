// ─── Time-Aware Windows ──────────────────────────────────────────────────────

export type DayPhase = 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night';

export interface AnalysisWindow {
  startTick: number;
  endTick: number;
  /**
   * Wall-clock (epoch ms) at which the previous analysis window ran. Several
   * tables (conversations.started_at, relationship_events.timestamp,
   * economy_transactions.timestamp) store Date.now() rather than tick numbers,
   * so those queries must be bounded by this instead of startTick.
   */
  startMs: number;
  gameHour: number;
  dayPhase: DayPhase;
  day: number;
  season: string;
  agentCount: number;
  activeEvents: string[];
}

// ─── Engagement Layer (Player Boredom) ───────────────────────────────────────

export interface EngagementSnapshot {
  actionDistribution: Record<string, number>;
  dominantAction: string;
  dominantActionRatio: number;
  uniqueActionsUsed: number;

  conversationsStarted: number;
  conversationsEnded: number;
  avgQualityScore: number;
  llmConversations: number;
  templateConversations: number;
  templateRatio: number;
  uniqueConversationPairs: number;
  topicDistribution: Record<string, number>;
  repeatedTopicPairs: number;

  totalRelationshipDeltas: number;
  relationshipsWithZeroDelta: number;
  newStatusChanges: number;

  dramaEvents: number;
  cascadeChains: number;
  avgCascadeDepth: number;
  stateTransitions: number;

  occupiedLocations: number;
  totalLocations: number;
  emptyLocations: Array<{
    name: string;
    operatingHours: { open: number; close: number } | null;
  }>;
  largestCluster: number;
  agentsMoving: number;

  goalsCreated: number;
  goalsCompleted: number;
  goalsAbandoned: number;
  stalledGoals: number;

  transactions: number;
  moneyMoved: number;

  replansThisWindow: number;
}

// ─── Health Layer ────────────────────────────────────────────────────────────

export interface HealthSnapshot {
  needsBelow15: Record<string, number>;
  needsAbove85: Record<string, number>;
  avgMood: number;
  moodStdDev: number;
  stressedAgents: number;

  isolatedAgents: number;
  orphanAgentNames: string[];

  stuckStates: Array<{
    agentId: number;
    agentName: string;
    stateType: string;
    durationTicks: number;
    expectedMaxDuration: number;
  }>;
  stateDistribution: Record<string, number>;

  brokeAgents: number;
  wealthyAgents: number;
  avgMoney: number;
  deflationRisk: boolean;
  inflationRisk: boolean;

  queueDepth: number;
  queueOldestMs: number;
  slotsInUse: number;
  slotsMax: number;
  timeoutsThisWindow: number;
}

// ─── Performance Layer ───────────────────────────────────────────────────────

export interface PhaseTimingEntry {
  avgMs: number;
  maxMs: number;
  totalMs: number;
  callCount: number;
}

export interface LlmCallRecord {
  durationMs: number;
  success: boolean;
  timedOut?: boolean;
  rejected?: boolean;
  retried?: boolean;
  promptChars?: number;
  contextItems?: number;
}

export interface PerfSnapshot {
  tickDurations: number[];
  avgTickMs: number;
  maxTickMs: number;
  p95TickMs: number;
  ticksOverBudget: number;
  tickBudgetMs: number;

  phaseTimings: Record<string, PhaseTimingEntry>;
  slowestPhase: string;

  llm: {
    requestsStarted: number;
    requestsCompleted: number;
    requestsFailed: number;
    requestsTimedOut: number;
    avgResponseMs: number;
    p95ResponseMs: number;
    maxResponseMs: number;
    /** Fraction of LLM calls that hit the per-call timeout. */
    llmTimeoutRate: number;

    avgConversationQuality: number;
    qualityDistribution: {
      terrible: number;
      poor: number;
      ok: number;
      good: number;
      great: number;
    };
    rejectedResponses: number;
    retryCount: number;

    avgSlotUtilization: number;
    slotSaturationTicks: number;
    queueStarvationTicks: number;

    avgSystemPromptChars: number;
    avgContextItems: number;

    /**
     * LLM call records dropped by the collector's leak guard before this
     * snapshot was taken. Non-zero means every count above undercounts.
     */
    droppedSamples: number;
  };
}

// ─── Diagnosis ───────────────────────────────────────────────────────────────

export type DiagnosisType =
  // Boredom
  | 'routine_lock'
  | 'conversation_drought'
  | 'conversation_sameness'
  | 'social_stagnation'
  | 'drama_desert'
  | 'spatial_monoculture'
  | 'dead_zone'
  | 'goal_graveyard'
  | 'mood_flatline'
  | 'economic_stasis'
  | 'cascade_silence'
  // Health
  | 'isolation_spiral'
  | 'wealth_collapse'
  | 'state_stuck'
  | 'need_death_spiral'
  | 'conversation_queue_overflow'
  // Performance
  | 'tick_overrun'
  | 'llm_bottleneck'
  | 'llm_quality_degradation'
  | 'template_domination'
  | 'prompt_bloat';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Diagnosis {
  type: DiagnosisType;
  severity: Severity;
  evidence: string;
  suggestion: string;
  affectedAgents?: number[];
  autoFixable: boolean;
}

// ─── Nudge Actions ───────────────────────────────────────────────────────────

export interface NudgeAction {
  type: string;
  reason: string;
  params: Record<string, any>;
  timestamp: number;
}

// ─── Full Report ─────────────────────────────────────────────────────────────

export interface AutoPlayReport {
  window: AnalysisWindow;
  engagement: EngagementSnapshot;
  health: HealthSnapshot;
  perf: PerfSnapshot;
  diagnoses: Diagnosis[];
  boredScore: number;
  healthScore: number;
  perfScore: number;
  trend: 'improving' | 'stable' | 'declining';
  nudgesApplied: NudgeAction[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AutoPlayConfig {
  ENABLED: boolean;
  WINDOW_SIZE: number;
  BOREDOM_THRESHOLD: number;
  AUTO_NUDGE: boolean;
  MAX_NUDGES_PER_DAY: number;
  HISTORY_WINDOWS: number;
}
