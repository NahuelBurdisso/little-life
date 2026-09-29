import { logActivity } from '../activityLogger';
import { CONFIG } from '../constants';

// Backoffs and cooldowns in the planning layer are measured in game minutes
// (`gameMinutes` in lib/gameClock.ts) rather than `totalTicks` (one tick is
// `tick_speed` game minutes, so tick counts drift when the sim runs fast) or
// wall-clock alone (a paused or slowed world would burn through the wait
// without the town living through it).

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Game minutes to wait before sending this agent's planning requests to the
 * LLM again after the n-th consecutive failure (the last entry repeats). Short
 * at first so a blip — one timeout under load — costs little, growing so that a
 * dead Ollama costs each agent roughly one doomed request per four game hours
 * instead of one per decision pass (B6).
 */
export const PLAN_RETRY_BACKOFF_MINUTES = [30, 60, 120, 240] as const;

/**
 * Real-time floor under the game-time backoff, in seconds, same indexing.
 *
 * Game time alone is not enough: at tick_speed 4, 30 game minutes pass in 7.5
 * real seconds, well inside the 60 s LLM timeout. Against a *hung* Ollama (one
 * that accepts the connection and never answers) every agent would then keep
 * one doomed call parked on a semaphore slot at all times. A retry needs both
 * clocks to have run out: the game one keeps the cadence sensible from the
 * town's point of view, the wall one bounds the load on the real LLM.
 */
export const PLAN_RETRY_FLOOR_SECONDS = [30, 60, 120, 300] as const;

/**
 * ±fraction applied to each backoff. An outage fails every agent within a
 * few seconds of each other; without jitter they would all retry in the same
 * game minute and hit the recovering LLM as one burst.
 */
export const PLAN_RETRY_JITTER = 0.2;

/**
 * Global circuit breaker. After this many planning failures in a row across
 * ALL agents and request kinds (no success in between) the LLM is treated as
 * down: planning requests are refused town-wide, and every
 * `PLAN_OUTAGE_PROBE_SECONDS` a single request is let through as a probe. Its
 * success closes the breaker; its failure keeps it open for another window.
 * The per-agent backoff alone would still let each of ~13 agents send its own
 * doomed request per window; the breaker turns an outage into at most one
 * in-flight planning call.
 */
export const PLAN_OUTAGE_THRESHOLD = 3;
export const PLAN_OUTAGE_PROBE_SECONDS = 60;

/**
 * How long an unreleased probe may stay out before the gate stops waiting for
 * it: the LLM timeout plus the same again for the semaphore queue ahead of it.
 * Normally the job's `finally` hands the probe back long before this. The
 * expiry covers the paths where that never happens — a queued probe dropped by
 * a world replace whose cache-clearing threw before reaching `gate.clear()` —
 * which would otherwise keep the breaker shut, and planning off, for good.
 */
export const PLAN_PROBE_EXPIRY_MS = CONFIG.AI.TIMEOUT_MS * 2;

/** Permission for one request; hand it back with `release` when the job ends. */
export interface PlanLLMTicket {
  /** Set when this request is the breaker's probe. */
  probe: object | null;
}

/** Attempt number and game-minute wait of a fresh backoff, for log lines. */
export interface BackoffStep {
  failures: number;
  wait: number;
}

/**
 * Admission control for every planning LLM call — daily plans, block
 * decomposition and replans — shared so that they all see the same picture of
 * LLM health. A decomposition failing tells us as much about Ollama as a plan
 * failing does, and an agent whose plan request just timed out shouldn't turn
 * round and fire a decomposition at the same dead server.
 *
 * Callers report one of four outcomes, and the distinction matters:
 *   - `recordSuccess`  usable answer: clear the agent's backoff, LLM is up.
 *   - `recordFailure`  transport error / timeout: agent backs off AND it counts
 *                      towards the outage breaker.
 *   - `backOff` + `noteAnswered`  the LLM answered but the text was unusable:
 *                      the agent backs off (asking again at once mostly gets the
 *                      same), but the LLM is evidently up, so the outage streak
 *                      resets. Counting these as outage used to let a model
 *                      that rambles trip the town-wide breaker.
 *   - `backOff` alone  our own code failed before the call (prompt building):
 *                      no retry storm, and no verdict on the LLM either way.
 *
 * Also owns the world epoch the planning jobs use to drop results that land
 * after a world replace.
 */
export class PlanLLMGate {
  /**
   * Per-agent failure streak and the game minute / wall ms before which no new
   * request for that agent is admitted. Cleared on the agent's next success
   * and on world replace: after a replace the clock restarts at day 1, so a
   * surviving `retryAt` would gag that agent id for days.
   */
  private backoff = new Map<number, { failures: number; retryAt: number; retryAtMs: number }>();

  /**
   * LLM-wide failure streak for the breaker. Deliberately NOT reset by
   * `clear()`: an outage is a property of the LLM, not of the world, and a
   * fresh world asking 13 agents' worth of plans from a dead Ollama is exactly
   * the storm this prevents. `reported` makes the activity feed say so once
   * per outage.
   */
  private outage = { failures: 0, openUntilMs: 0, reported: false };

  /**
   * The one probe allowed through while the breaker is open, or null. Released
   * by the job's `finally` so a probe that ends without reaching the LLM (plan
   * already present, world replaced) can't wedge the breaker shut; `clear()`
   * releases it too, and it expires on its own after PLAN_PROBE_EXPIRY_MS.
   */
  private probe: { token: object; issuedAtMs: number } | null = null;

  private _epoch = 0;

  /** Told when the breaker opens or closes (the health banner), never on every failure. */
  private breakerListeners = new Set<() => void>();

  private readonly wallNow: () => number;
  private readonly random: () => number;

  constructor(
    /**
     * Current absolute game minute (see `gameMinutes`). Read when a request
     * fails, not when it is admitted: an LLM timeout can take a long time of
     * game time at high tick speeds, and a backoff measured from the queue
     * time could already have expired by the time the failure lands.
     */
    private readonly now: () => number,
    /** Injectable wall clock (ms) and RNG, for tests. */
    opts: { wallNow?: () => number; random?: () => number } = {},
  ) {
    this.wallNow = opts.wallNow ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /** Is the town-wide breaker open (planning is refused except for the probe)? */
  get breakerOpen(): boolean {
    return this.outage.failures >= PLAN_OUTAGE_THRESHOLD;
  }

  /** Subscribe to breaker open/close transitions. Returns the unsubscribe. */
  onBreakerChange(cb: () => void): () => void {
    this.breakerListeners.add(cb);
    return () => this.breakerListeners.delete(cb);
  }

  private fireBreakerChange(): void {
    for (const cb of this.breakerListeners) {
      try { cb(); } catch { /* a listener must never break planning */ }
    }
  }

  /**
   * Bumped by `clear()`. A job that awaited the LLM across a world replace
   * compares it after the await and drops its result, instead of writing the
   * old world's plan onto a new agent that reuses the rowid.
   */
  get epoch(): number {
    return this._epoch;
  }

  /**
   * Admit one request for `agentId` at game minute `gameMinute`, or refuse
   * (null) while the agent is backing off or the breaker is open. An admitted
   * ticket must be `release`d when the job ends — including when it is never
   * queued.
   */
  tryAcquire(agentId: number, gameMinute: number): PlanLLMTicket | null {
    const wall = this.wallNow();
    const gate = this.backoff.get(agentId);
    if (gate && (gameMinute < gate.retryAt || wall < gate.retryAtMs)) return null;

    if (this.outage.failures >= PLAN_OUTAGE_THRESHOLD) {
      if (this.probe && wall - this.probe.issuedAtMs >= PLAN_PROBE_EXPIRY_MS) {
        console.warn('[PlanLLMGate] probe never came back; issuing a new one');
        this.probe = null;
      }
      if (wall < this.outage.openUntilMs || this.probe) return null;
      const token = {};
      this.probe = { token, issuedAtMs: wall };
      return { probe: token };
    }
    return { probe: null };
  }

  release(ticket: PlanLLMTicket): void {
    if (ticket.probe && this.probe?.token === ticket.probe) this.probe = null;
  }

  /** The LLM answered usefully for `agentId`. Ends the agent's streak and any outage. */
  recordSuccess(agentId: number): void {
    this.backoff.delete(agentId);
    this.noteAnswered();
  }

  /**
   * The LLM responded (whatever the quality of the answer), so it is not down.
   * Resets the outage streak and closes the breaker.
   */
  noteAnswered(): void {
    const wasOpen = this.outage.failures >= PLAN_OUTAGE_THRESHOLD;
    if (wasOpen) {
      console.log('[PlanLLMGate] LLM answered again; planning requests resume');
    }
    this.outage = { failures: 0, openUntilMs: 0, reported: false };
    if (wasOpen) this.fireBreakerChange();
  }

  /**
   * Start or extend `agentId`'s backoff without any verdict on LLM health.
   * On its own: for failures of our own code before the call. With
   * `noteAnswered`: for answers that arrived but could not be used.
   */
  backOff(agentId: number): BackoffStep {
    const prev = this.backoff.get(agentId);
    const failures = (prev?.failures ?? 0) + 1;
    const step = Math.min(failures, PLAN_RETRY_BACKOFF_MINUTES.length) - 1;
    const jitter = 1 + (this.random() * 2 - 1) * PLAN_RETRY_JITTER;
    const wait = Math.round(PLAN_RETRY_BACKOFF_MINUTES[step] * jitter);
    this.backoff.set(agentId, {
      failures,
      retryAt: this.now() + wait,
      retryAtMs: this.wallNow() + Math.round(PLAN_RETRY_FLOOR_SECONDS[step] * 1000 * jitter),
    });
    return { failures, wait };
  }

  /**
   * The call itself failed — connection refused, HTTP error, timeout. Backs
   * the agent off, counts towards the breaker, and reports the outage to the
   * activity feed once when the breaker trips.
   */
  recordFailure(agentId: number, reason: string): BackoffStep {
    const step = this.backOff(agentId);

    this.outage.failures++;
    if (this.outage.failures === PLAN_OUTAGE_THRESHOLD) this.fireBreakerChange();
    if (this.outage.failures >= PLAN_OUTAGE_THRESHOLD) {
      this.outage.openUntilMs = this.wallNow() + PLAN_OUTAGE_PROBE_SECONDS * 1000;
      // One activity-feed entry per outage, re-armed by the next answer.
      // Per-agent entries flooded the feed with a dozen identical errors every
      // time Ollama went away; a lone blip that one agent's retry absorbs isn't
      // worth the player's attention at all.
      if (!this.outage.reported) {
        this.outage.reported = true;
        try {
          logActivity({
            type: 'error',
            templateData: {
              system: 'planning',
              message: `Planning requests to the LLM are failing (${reason}); townsfolk follow their routines until it answers again`,
            },
          });
        } catch {
          // Reporting must never turn a handled failure into an unhandled one.
        }
      }
    }
    return step;
  }

  /** Drop all per-world state. Called from `clearPerWorldCaches`. */
  clear(): void {
    this.backoff.clear();
    this.probe = null;
    this._epoch++;
  }
}

/**
 * Report a failure of our own planning code (prompt building, context
 * loading) — not an LLM problem. Always to the console with the stack; to the
 * activity feed only on the first failure of the agent's streak, since the
 * caller's backoff will bring the same bug round again every few game hours.
 */
export function reportPlanningBug(what: string, err: unknown, failures: number): void {
  const message = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
  console.error(`[planning] ${message}`, err);
  if (failures !== 1) return;
  try {
    logActivity({ type: 'error', templateData: { system: 'planning', message } });
  } catch {
    // Reporting must never turn a handled failure into an unhandled one.
  }
}
