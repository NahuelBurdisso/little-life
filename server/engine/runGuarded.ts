import { logActivity } from '../lib/activityLogger';

/**
 * Run one piece of per-tick work so that a throw is logged and swallowed.
 *
 * The system phases already had this treatment, but the work after them
 * (perception, tavern, loneliness, confrontation, the day-change jobs) ran
 * bare inside gameTick: a single throw skipped the tick-cache clear, left
 * `current_tick_phase` non-zero and never flushed the emitter, so the client
 * froze until the next clean tick. Each step gets its own guard so one failure
 * doesn't take its neighbours down with it.
 *
 * Returns whether `fn` completed.
 */
export function runGuarded(system: string, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      logActivity({ type: 'error', templateData: { system, message: `${system} error: ${message}` } });
    } catch {
      // The activity log itself may be what's broken; never let reporting throw.
      console.error(`[tick] ${system} error: ${message}`);
    }
    return false;
  }
}
