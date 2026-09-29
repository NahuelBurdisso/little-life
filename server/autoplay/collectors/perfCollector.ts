import { CONFIG } from '../../lib/constants';
import type { PerfSnapshot, LlmCallRecord, PhaseTimingEntry } from '../types';
import { db } from '../../db';
import { conversations } from '../../db/schema';
import { and, gte, isNotNull } from 'drizzle-orm';

/**
 * Hard cap for every accumulator. record*() is now gated on AUTOPLAY.ENABLED at
 * the call sites (tick.ts, generateResponse.ts), but the cap stays as a leak
 * guard: flush() only runs on a window boundary, so anything that stops windows
 * closing while ticks keep running would otherwise grow these arrays forever.
 * Oldest samples are dropped first.
 */
function pushCapped<T>(arr: T[], value: T): void {
  arr.push(value);
  // One sample per tick, and a window is WINDOW_MINUTES of game time: 1 tick
  // per minute at 1x, up to 2 at the slowest 0.5x. 4x leaves headroom.
  const cap = CONFIG.AUTOPLAY.WINDOW_MINUTES * 4;
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/**
 * Separate, much larger cap for LLM call records. Unlike the tick accumulators
 * above there is not one sample per tick: concurrent calls, multi-turn
 * conversations and per-retry records mean a normal window can hold many times
 * WINDOW_MINUTES entries, and the tick cap silently truncated real data. This is
 * only a leak guard for the "flush() never runs" case, so it is sized well
 * above any plausible window; overflow is counted into `droppedSamples` on the
 * snapshot.
 *
 * Where that count actually goes: into the LLM diagnoses' `evidence` strings
 * (diagnostics.ts) and onto getLlmDashboard(). Both are reachable only through
 * the tRPC autoplay procedures, which NO client component calls today — nothing
 * under src/ imports them. So this is a signal for whoever reads a report
 * programmatically, not something an operator is shown. Do not write comments
 * elsewhere that assume a human sees it.
 */
const LLM_CALL_CAP = 10000;

export class PerfCollector {
  // Tick timing
  private tickDurations: number[] = [];

  // Phase timing
  private phaseAccum: Record<string, { durations: number[] }> = {};

  // LLM call records
  private llmCalls: LlmCallRecord[] = [];
  private droppedLlmCalls = 0;

  // Slot utilization samples (one per tick)
  private slotSamples: number[] = [];
  private queueDepthSamples: number[] = [];
  private saturationTicks = 0;
  private starvationTicks = 0;

  recordTick(durationMs: number) {
    pushCapped(this.tickDurations, durationMs);
  }

  recordPhase(name: string, durationMs: number) {
    if (!this.phaseAccum[name]) {
      this.phaseAccum[name] = { durations: [] };
    }
    pushCapped(this.phaseAccum[name].durations, durationMs);
  }

  recordLlmCall(record: LlmCallRecord) {
    this.llmCalls.push(record);
    if (this.llmCalls.length > LLM_CALL_CAP) {
      const excess = this.llmCalls.length - LLM_CALL_CAP;
      this.llmCalls.splice(0, excess);
      this.droppedLlmCalls += excess;
    }
  }

  recordSlotState(slotsInUse: number, queueDepth: number) {
    pushCapped(this.slotSamples, slotsInUse);
    pushCapped(this.queueDepthSamples, queueDepth);
    if (slotsInUse >= CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM) {
      this.saturationTicks++;
    }
    if (queueDepth === 0 && slotsInUse < CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM) {
      this.starvationTicks++;
    }
  }

  /** @param startMs wall-clock start of the window (conversations.ended_at is epoch-ms). */
  flush(startMs: number): PerfSnapshot {
    const budget = CONFIG.TICK_INTERVAL_MS;

    // Tick stats
    const sorted = [...this.tickDurations].sort((a, b) => a - b);
    const avgTickMs = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const maxTickMs = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
    const p95Idx = Math.floor(sorted.length * 0.95);
    const p95TickMs = sorted.length > 0 ? sorted[Math.min(p95Idx, sorted.length - 1)] : 0;
    const ticksOverBudget = sorted.filter(d => d > budget).length;

    // Phase stats
    const phaseTimings: Record<string, PhaseTimingEntry> = {};
    let slowestPhase = '';
    let slowestMax = 0;
    for (const [name, acc] of Object.entries(this.phaseAccum)) {
      const durations = acc.durations;
      const total = durations.reduce((a, b) => a + b, 0);
      // reduce() instead of Math.max(...arr) — spreading a large array blows the stack.
      const max = durations.reduce((m, d) => (d > m ? d : m), 0);
      phaseTimings[name] = {
        avgMs: durations.length > 0 ? total / durations.length : 0,
        maxMs: max,
        totalMs: total,
        callCount: durations.length,
      };
      if (max > slowestMax) {
        slowestMax = max;
        slowestPhase = name;
      }
    }

    // LLM stats
    const completed = this.llmCalls.filter(c => c.success);
    const failed = this.llmCalls.filter(c => !c.success);
    const timedOut = this.llmCalls.filter(c => c.timedOut);
    const rejected = this.llmCalls.filter(c => c.rejected);
    const retried = this.llmCalls.filter(c => c.retried);

    const responseTimes = completed.map(c => c.durationMs).sort((a, b) => a - b);
    const avgResponseMs = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0;
    const p95RespIdx = Math.floor(responseTimes.length * 0.95);
    const p95ResponseMs = responseTimes.length > 0
      ? responseTimes[Math.min(p95RespIdx, responseTimes.length - 1)] : 0;
    const maxResponseMs = responseTimes.length > 0 ? responseTimes[responseTimes.length - 1] : 0;

    // Conversation quality from DB.
    // Bounded on ended_at, NOT started_at: quality_score is only written when a
    // conversation ends. A conversation that started in window N and ended in
    // N+1 has a NULL score when N runs and a too-old started_at when N+1 runs,
    // so bounding on started_at dropped every boundary-spanning conversation.
    let avgQuality = 0;
    const qualityDist = { terrible: 0, poor: 0, ok: 0, good: 0, great: 0 };
    try {
      const recentConvos = db.select({
        quality_score: conversations.quality_score,
      }).from(conversations).where(
        and(
          gte(conversations.ended_at, startMs),
          isNotNull(conversations.quality_score),
        )
      ).all();

      if (recentConvos.length > 0) {
        let sum = 0;
        for (const c of recentConvos) {
          const q = c.quality_score ?? 0;
          sum += q;
          if (q < 0.2) qualityDist.terrible++;
          else if (q < 0.4) qualityDist.poor++;
          else if (q < 0.6) qualityDist.ok++;
          else if (q < 0.8) qualityDist.good++;
          else qualityDist.great++;
        }
        avgQuality = sum / recentConvos.length;
      }
    } catch { /* fresh DB */ }

    // Share of LLM calls that hit the per-call timeout
    const totalCompleted = completed.length + timedOut.length;
    const llmTimeoutRate = totalCompleted > 0 ? timedOut.length / totalCompleted : 0;

    // Slot utilization
    const maxSlots = CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM;
    const avgSlotUtil = this.slotSamples.length > 0
      ? this.slotSamples.reduce((a, b) => a + b, 0) / (this.slotSamples.length * maxSlots) : 0;

    // Prompt stats
    const promptChars = this.llmCalls.filter(c => c.promptChars != null).map(c => c.promptChars!);
    const avgPromptChars = promptChars.length > 0
      ? promptChars.reduce((a, b) => a + b, 0) / promptChars.length : 0;
    const ctxItems = this.llmCalls.filter(c => c.contextItems != null).map(c => c.contextItems!);
    const avgCtxItems = ctxItems.length > 0
      ? ctxItems.reduce((a, b) => a + b, 0) / ctxItems.length : 0;

    const snapshot: PerfSnapshot = {
      tickDurations: this.tickDurations,
      avgTickMs,
      maxTickMs,
      p95TickMs,
      ticksOverBudget,
      tickBudgetMs: budget,
      phaseTimings,
      slowestPhase,
      llm: {
        requestsStarted: this.llmCalls.length,
        requestsCompleted: completed.length,
        requestsFailed: failed.length,
        requestsTimedOut: timedOut.length,
        avgResponseMs,
        p95ResponseMs,
        maxResponseMs,
        llmTimeoutRate,
        avgConversationQuality: avgQuality,
        qualityDistribution: qualityDist,
        rejectedResponses: rejected.length,
        retryCount: retried.length,
        avgSlotUtilization: avgSlotUtil,
        slotSaturationTicks: this.saturationTicks,
        queueStarvationTicks: this.starvationTicks,
        avgSystemPromptChars: avgPromptChars,
        avgContextItems: avgCtxItems,
        droppedSamples: this.droppedLlmCalls,
      },
    };

    this.reset();
    return snapshot;
  }

  /** Drops all buffered samples without producing a snapshot. */
  reset() {
    this.tickDurations = [];
    this.phaseAccum = {};
    this.llmCalls = [];
    this.droppedLlmCalls = 0;
    this.slotSamples = [];
    this.queueDepthSamples = [];
    this.saturationTicks = 0;
    this.starvationTicks = 0;
  }
}
