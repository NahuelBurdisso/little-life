/**
 * How long the tRPC socket waits before reconnect attempt number `attempt`
 * (0-based): 0.5 s, 1 s, 2 s, 4 s, then every 5 s.
 *
 * A flat 1 s was fine for a blip but hammered a server that is still booting
 * (model warm-up, embedding backfill) or simply not running: one failed
 * connection, and one console error, per second for as long as the tab stayed
 * open. The first retries stay quick so a `tsx watch` restart reconnects at once.
 */
export const WS_RETRY_BASE_MS = 500;
export const WS_RETRY_MAX_MS = 5000;

export function wsRetryDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // Capped exponent: 2 ** 1000 is Infinity, and Infinity * anything stays over the cap anyway,
  // but a finite number keeps this safe to log and to add jitter to later.
  return Math.min(WS_RETRY_MAX_MS, WS_RETRY_BASE_MS * 2 ** Math.min(n, 10));
}
