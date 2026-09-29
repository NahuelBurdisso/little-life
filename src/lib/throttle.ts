/**
 * Leading + trailing throttle: the first call runs at once, calls inside the
 * next `ms` collapse into a single trailing run at the end of the window.
 *
 * For refetch-on-push: the agents channel flushes every tick or two, and a
 * query that is open and heavy (the pair dossier joins a history, a sparkline
 * and the conversations around the pair) refetching at every flush is wasted
 * work when the numbers move by fractions. The trailing run means the last
 * change is never lost — the panel catches up once the window closes.
 *
 * `now` and the timer are injectable so the rule is testable without fake timers.
 */
export interface Throttled {
  (): void;
  /** Drop a pending trailing run (unmount). */
  cancel(): void;
}

export function throttle(
  fn: () => void,
  ms: number,
  now: () => number = Date.now,
  timers: {
    set: (cb: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (cb, delay) => setTimeout(cb, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Throttled {
  let lastRun = -Infinity;
  let pending: unknown = null;

  const run = () => {
    pending = null;
    lastRun = now();
    fn();
  };

  const throttled = (() => {
    if (pending !== null) return;
    const wait = lastRun + ms - now();
    if (wait <= 0) run();
    else pending = timers.set(run, wait);
  }) as Throttled;

  throttled.cancel = () => {
    if (pending !== null) timers.clear(pending);
    pending = null;
  };

  return throttled;
}
