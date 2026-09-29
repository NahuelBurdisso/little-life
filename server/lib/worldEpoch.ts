/**
 * World epoch: which world the process is running *now*.
 *
 * Three flows swap the world under a running process — `setup.replaceWorld`,
 * `setup.resetToWizard` and a save load — and each waits a bounded time
 * (`taskRunner.drain()`, 10 s) for LLM work to settle first. Anything slower
 * finished after the wipe and wrote its result by agent id: a self-description,
 * a reflection, a conversation takeaway, a goal review, a snap. SQLite reuses
 * rowids after the wipe, so those rows landed on whichever *new* resident got
 * the old id (the default cast even keeps the same names, so a name check
 * doesn't catch it either).
 *
 * The fix is one counter. Every async LLM task captures `currentWorldEpoch()`
 * when it is enqueued and checks `isStaleWorldEpoch(captured)` right before
 * each write-back (a synchronous check followed by synchronous writes, so no
 * swap can slip in between). `bumpWorldEpoch()` runs once per swap, after the
 * drain, and also aborts `worldAbortSignal()` — `callOllamaChat` links every
 * request to the signal current when it was made, so the outgoing world's
 * in-flight model calls stop at once instead of finishing a reply nobody may
 * use.
 *
 * Deliberately dependency-free: planning, memory, goals, cascade and the LLM
 * client all import it, and none of them should pull the DB in for a counter.
 */

let epoch = 0;
let controller = new AbortController();

/** The world the process runs now. Capture it when an async task is enqueued. */
export function currentWorldEpoch(): number {
  return epoch;
}

/** True when the world has been swapped since `captured` was taken: drop the result. */
export function isStaleWorldEpoch(captured: number): boolean {
  return captured !== epoch;
}

/**
 * Aborted when the world is swapped. Read it at the start of a request; a
 * signal taken later belongs to the next world and stays live.
 */
export function worldAbortSignal(): AbortSignal {
  return controller.signal;
}

/**
 * Retire the running world: every captured epoch becomes stale and every
 * request linked to the current signal is aborted. The new epoch and signal are
 * installed before the old signal fires, so an abort listener that looks at the
 * epoch synchronously already sees the change.
 */
export function bumpWorldEpoch(): number {
  epoch++;
  const outgoing = controller;
  controller = new AbortController();
  outgoing.abort();
  return epoch;
}
