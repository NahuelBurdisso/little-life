/**
 * How well the tick loop keeps up, for the health banner.
 *
 * A tick that takes longer than TICK_INTERVAL_MS slows the game clock itself
 * (the next tick waits for it): at 4x a 3 s tick runs the town at ~1.3x. The
 * only trace used to be one console warning a minute (`reportSlowTick` in
 * tick.ts). This keeps the timestamps of the last minute's overruns so the
 * client can say "the town is running behind" instead of the player guessing
 * why the clock crawls.
 *
 * Pure apart from the injected clock; the singleton is fed by tick.ts.
 */

/** Overruns in the last minute before the town counts as lagging: a lone slow tick (a day change) is normal. */
export const LAG_MIN_SLOW_TICKS = 5;
const WINDOW_MS = 60_000;

export interface TickHealthSnapshot {
  /** Duration of the newest overrun in the last minute, ms; 0 when there was none. */
  lastTickOverrunMs: number;
  slowTicksLastMinute: number;
  /** Enough overruns that the clock is visibly slower than asked. */
  lagging: boolean;
}

export class TickHealth {
  private slow: Array<{ atMs: number; ms: number }> = [];

  constructor(private readonly clock: () => number = Date.now) {}

  /** Record one finished tick. Returns true when it overran its budget. */
  noteTick(totalMs: number, budgetMs: number): boolean {
    if (totalMs <= budgetMs) return false;
    this.slow.push({ atMs: this.clock(), ms: totalMs });
    this.prune();
    return true;
  }

  private prune(): void {
    const cutoff = this.clock() - WINDOW_MS;
    while (this.slow.length > 0 && this.slow[0].atMs < cutoff) this.slow.shift();
  }

  snapshot(): TickHealthSnapshot {
    this.prune();
    const last = this.slow[this.slow.length - 1];
    return {
      lastTickOverrunMs: last ? Math.round(last.ms) : 0,
      slowTicksLastMinute: this.slow.length,
      lagging: this.slow.length >= LAG_MIN_SLOW_TICKS,
    };
  }

  reset(): void {
    this.slow = [];
  }
}

export const tickHealth = new TickHealth();
