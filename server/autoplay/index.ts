import { db } from '../db';
import { agents, worldEvents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../lib/constants';
import { gameMinutes } from '../lib/gameClock';

import { PerfCollector } from './collectors/perfCollector';
import { EngagementCollector } from './collectors/engagementCollector';
import { HealthCollector } from './collectors/healthCollector';
import {
  diagnose, computeBaselines, computeScores, computeDiagnosisConditions,
  type DiagnosisConditions,
} from './diagnostics';
import { SmartNudger } from './nudger';
import type {
  AutoPlayReport, AnalysisWindow, DayPhase,
  EngagementSnapshot, HealthSnapshot, PerfSnapshot,
} from './types';

/** How many past windows of raw conditions are retained for sustained-pattern checks. */
const DIAGNOSIS_MEMORY_WINDOWS = 3;

class AutoPlayer {
  readonly perf = new PerfCollector();
  private engagement = new EngagementCollector();
  private health = new HealthCollector();
  private nudger = new SmartNudger();

  private history: Array<{
    engagement: EngagementSnapshot;
    health: HealthSnapshot;
    perf: PerfSnapshot;
    window: AnalysisWindow;
  }> = [];

  private reports: AutoPlayReport[] = [];
  /**
   * Raw sustained-pattern conditions from the last DIAGNOSIS_MEMORY_WINDOWS
   * windows, oldest first. Recorded regardless of whether the corresponding
   * diagnosis was emitted — gating emission on past EMISSIONS of the same type
   * made those diagnoses unreachable.
   */
  private conditionHistory: DiagnosisConditions[] = [];
  private llmResponseTimeline: Array<{ ts: number; durationMs: number; success: boolean }> = [];
  /**
   * Wall-clock timestamp at which the previous window's analyze() ran. Used to
   * bound queries against columns that store Date.now() rather than ticks.
   * Seeded with the process start time so the first window is still finite.
   */
  private lastAnalyzeMs = Date.now();

  /**
   * Bumped by reset(). analyze() captures it on entry and refuses to write back
   * into the (now cleared) accumulators if it changed while the method was
   * suspended.
   *
   * Currently unreachable — applyNudges() is `async` but contains no `await`, so
   * analyze()'s continuation is a microtask and a tRPC mutation (a macrotask)
   * cannot interleave. It goes live the moment any nudge does real async I/O, at
   * which point a reset() landing mid-analyze would push pre-reset snapshots
   * into the fresh history and the `finally` would restore the pre-reset
   * lastAnalyzeMs, silently undoing the whole reset. Guarding is one integer
   * compare, so close it now rather than rediscover it later.
   */
  private resetEpoch = 0;

  /**
   * Restart the window at "now": both the wall-clock cursor and the
   * sustained-pattern counter, which are the two pieces of state whose entire
   * meaning is "how the CURRENT run of consecutive windows has gone".
   *
   * `lastAnalyzeMs` only advances inside analyze(), which only runs while
   * AUTOPLAY.ENABLED. Toggling autoplay off and back on an hour later otherwise
   * gave the first window an hour-old startMs, so its wall-clock DB queries swept
   * the whole idle hour into one wildly inflated window that then poisoned
   * computeBaselines() for every window after it.
   *
   * `conditionHistory` has to go with it. Retained across a gap, the first window
   * of the new session is compared against three PRE-GAP windows, so a `>= 2`
   * gate can fire and claim "3+ consecutive windows" on one window of real
   * evidence. Across a window-size change it is worse still: the retained entries
   * were recorded over a different game-time span, so "3 consecutive windows" no
   * longer denotes any fixed duration. Baselines legitimately survive a resize
   * (see routers/autoplay.ts) — a run counter does not.
   */
  resetWindowClock() {
    this.lastAnalyzeMs = Date.now();
    this.conditionHistory = [];
  }

  /**
   * Drop every piece of accumulated state and restart the window at "now".
   *
   * Must be called whenever the world is wiped and reseeded (replaceWorld /
   * resetToWizard): none of the state below survives such a reset meaningfully.
   * - lastAnalyzeMs would make the first new window sweep pre-reset wall time.
   * - history/reports EMA old-world numbers into new-world baselines.
   * - conditionHistory would carry old-world sustained patterns forward.
   * - reports also back getAgentProfiles(), which matches affectedAgents
   *   against agent ids that restart at 1 after a wipe (misattribution).
   * - the nudger's last-nudge stamp outlives the clock going back to day 1,
   *   which silently suppressed every nudge until the clock climbed past it.
   * - the health collector's lifetime timeout cursor outlives the scheduler
   *   counter, clamping the reported per-window delta to 0.
   *
   * Safe to call at any time, including while autoplay is disabled and before
   * any window has ever run.
   */
  reset(): void {
    // Invalidate any analyze() already in flight before clearing anything.
    this.resetEpoch++;
    // lastAnalyzeMs + conditionHistory: same window-continuity reasoning as a
    // plain restart, so don't duplicate it here.
    this.resetWindowClock();
    this.history = [];
    this.reports = [];
    this.llmResponseTimeline = [];
    this.perf.reset();
    // EngagementCollector is stateless — it reads everything from the DB.
    this.health.reset();
    this.nudger.reset();
  }

  async analyze(worldRow: any): Promise<AutoPlayReport> {
    // Captured before the first await. Every write-back below is fenced on it
    // still matching, so a reset() that lands while this call is suspended wins
    // and this window's stale, pre-reset numbers are dropped instead of being
    // resurrected into the freshly cleared state. See `resetEpoch`.
    const epoch = this.resetEpoch;

    const time = worldRow.time as {
      day: number; hour: number; minute: number; totalTicks: number; season: string;
    };

    // Build analysis window
    // The window is WINDOW_MINUTES of game time. Game-minute columns take it
    // as is; the tick-stamped ones (activity_log.timestamp) need it converted
    // at the current speed, approximate across a speed change.
    const windowMinutes = CONFIG.AUTOPLAY.WINDOW_MINUTES;
    const tickSpeed = worldRow.tick_speed > 0 ? worldRow.tick_speed : 1;
    const endTick = time.totalTicks;
    const startTick = Math.max(0, endTick - Math.round(windowMinutes / tickSpeed));
    const endMinutes = gameMinutes(time);
    const startMinutes = endMinutes - windowMinutes;
    const startMs = this.lastAnalyzeMs;
    const nowMs = Date.now();

    // finally, not the success path: any throw below (DB queries, health.collect,
    // applyNudges) would otherwise pin lastAnalyzeMs, and tick.ts swallows the
    // rejection. The next window would then cover 2x the intended span, then 3x,
    // poisoning every baseline computed from it.
    try {
      const activeAgents = db.select({ id: agents.id }).from(agents)
        .where(eq(agents.is_active, true)).all();

      const activeEvts = db.select({ type: worldEvents.type }).from(worldEvents)
        .where(eq(worldEvents.is_active, true)).all();

      const window: AnalysisWindow = {
        startTick,
        endTick,
        startMinutes,
        endMinutes,
        startMs,
        gameHour: time.hour,
        dayPhase: this.computeDayPhase(time.hour),
        day: time.day,
        season: time.season,
        agentCount: activeAgents.length,
        activeEvents: activeEvts.map(e => e.type),
      };

      // Collect snapshots
      const engagement = this.engagement.collect(window);
      const health = this.health.collect(window);
      const perf = this.perf.flush(startMs);

      // Compute adaptive baselines from history
      const baselines = computeBaselines(this.history);

      // Run diagnostics against the conditions seen in the PRIOR windows
      const diagnoses = diagnose(
        engagement, health, perf, window, baselines, this.conditionHistory,
      );

      // Compute scores
      const { boredScore, healthScore, perfScore } = computeScores(
        engagement, health, perf, window, baselines,
      );

      // Compute trend
      const recentScores = this.reports.slice(-3).map(r => r.boredScore);
      let trend: 'improving' | 'stable' | 'declining' = 'stable';
      if (recentScores.length >= 2) {
        const avg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
        if (boredScore < avg - 5) trend = 'improving';
        else if (boredScore > avg + 5) trend = 'declining';
      }

      // Apply nudges if enabled
      let nudgesApplied: any[] = [];
      if (CONFIG.AUTOPLAY.AUTO_NUDGE && boredScore > CONFIG.AUTOPLAY.BOREDOM_THRESHOLD) {
        nudgesApplied = await this.nudger.applyNudges(diagnoses, window);
      }

      const report: AutoPlayReport = {
        window,
        engagement,
        health,
        perf,
        diagnoses,
        boredScore,
        healthScore,
        perfScore,
        trend,
        nudgesApplied,
      };

      // Store history — but only if no reset() landed while we were suspended.
      // The report itself is still returned to the caller; it is only barred
      // from contaminating the post-reset accumulators.
      if (epoch === this.resetEpoch) {
        this.history.push({ engagement, health, perf, window });
        if (this.history.length > CONFIG.AUTOPLAY.HISTORY_WINDOWS) {
          this.history.shift();
        }

        this.reports.push(report);
        if (this.reports.length > CONFIG.AUTOPLAY.HISTORY_WINDOWS) {
          this.reports.shift();
        }

        // Record this window's raw conditions for the next window's sustained checks
        this.conditionHistory.push(computeDiagnosisConditions(engagement, health, window));
        if (this.conditionHistory.length > DIAGNOSIS_MEMORY_WINDOWS) {
          this.conditionHistory.shift();
        }
      }

      return report;
    } finally {
      // Same fence: reset() already moved the cursor to its own "now", and
      // restoring this window's older `nowMs` over it would undo the reset.
      if (epoch === this.resetEpoch) this.lastAnalyzeMs = nowMs;
    }
  }

  getLatestReport(): AutoPlayReport | null {
    return this.reports.length > 0 ? this.reports[this.reports.length - 1] : null;
  }

  getHistory(count: number): AutoPlayReport[] {
    return this.reports.slice(-count);
  }

  getLatestPerf(): PerfSnapshot | null {
    if (this.reports.length === 0) return null;
    return this.reports[this.reports.length - 1].perf;
  }

  getAgentProfiles() {
    const activeAgents = db.select({
      id: agents.id,
      name: agents.name,
      current_action: agents.current_action,
    }).from(agents).where(eq(agents.is_active, true)).all();

    return activeAgents.map(a => {
      // Count how many times this agent appears in diagnoses
      const latestDiags = this.reports.length > 0
        ? this.reports[this.reports.length - 1].diagnoses : [];
      const affecting = latestDiags.filter(d =>
        d.affectedAgents?.includes(a.id)
      );

      return {
        agentId: a.id,
        name: a.name,
        currentAction: (a.current_action as any)?.type ?? 'idle',
        issues: affecting.map(d => d.type),
        issueCount: affecting.length,
      };
    });
  }

  getLlmDashboard() {
    const latest = this.getLatestReport();
    if (!latest) return null;

    return {
      slotUtilization: latest.perf.llm.avgSlotUtilization,
      qualityDistribution: latest.perf.llm.qualityDistribution,
      llmTimeoutRate: latest.perf.llm.llmTimeoutRate,
      avgResponseMs: latest.perf.llm.avgResponseMs,
      p95ResponseMs: latest.perf.llm.p95ResponseMs,
      rejectedResponses: latest.perf.llm.rejectedResponses,
      retryCount: latest.perf.llm.retryCount,
      queueHealth: {
        depth: latest.health.queueDepth,
        // Saturated ticks over the ticks actually sampled in the window.
        saturationRate: latest.perf.llm.slotSaturationTicks / Math.max(1, latest.perf.tickDurations.length),
      },
      phaseTimings: latest.perf.phaseTimings,
      tickHealth: {
        avg: latest.perf.avgTickMs,
        p95: latest.perf.p95TickMs,
        overBudget: latest.perf.ticksOverBudget,
      },
      promptStats: {
        avgChars: latest.perf.llm.avgSystemPromptChars,
        avgContextItems: latest.perf.llm.avgContextItems,
      },
      // Non-zero means the collector's leak guard discarded the oldest LLM call
      // records, so every LLM figure above is computed over a truncated sample.
      // Exposed on this payload only — there is no dashboard UI; nothing under
      // src/ calls autoplay.getLlmDashboard, so read it via the tRPC procedure.
      droppedSamples: latest.perf.llm.droppedSamples,
    };
  }

  recordLlmResponse(durationMs: number, success: boolean) {
    this.llmResponseTimeline.push({ ts: Date.now(), durationMs, success });
    if (this.llmResponseTimeline.length > 100) {
      this.llmResponseTimeline.shift();
    }
  }

  getLlmResponseTimeline() {
    return this.llmResponseTimeline.slice(-50);
  }

  private computeDayPhase(hour: number): DayPhase {
    if (hour >= 5 && hour < 7) return 'dawn';
    if (hour >= 7 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 20) return 'evening';
    return 'night';
  }
}

export const autoPlayer = new AutoPlayer();
