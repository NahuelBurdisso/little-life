/**
 * "Skip to morning": the rules for when the night may be fast-forwarded and
 * when the fast-forward must stop. Pure (no DB, no clock), so the server's
 * controller (engine/nightSkip.ts) and the client's button (deciding whether to
 * show up) read one definition and the rules are testable.
 *
 * Why this exists: the UI tops out at 4x, so a game night (~7 h) costs about
 * two real minutes in which the whole town is asleep and nothing happens. The
 * skip runs those hours at SPEED game minutes per tick instead.
 *
 * Why it can be that fast: each phase already measures in game minutes (the
 * game-time rework, lib/gameClock.ts), so a tick of 30 minutes is the same
 * machinery as a tick of 4, only coarser. What the coarseness costs is the
 * reason the skip is limited to the night: with everyone asleep there are no
 * conversations to squeeze into 30-minute steps and nobody to walk past a door
 * in one tick.
 */

export const NIGHT_SKIP = {
  /** Game minutes per tick while skipping. 7 hours of night is 14 real seconds. */
  SPEED: 30,
  /** Speed while the LLM queue is backed up: inside the range the sim is tuned for. */
  THROTTLE_SPEED: 4,
  /** Waiting LLM requests above which the skip slows to THROTTLE_SPEED. */
  LLM_BACKLOG_LIMIT: 4,
  /** The skip ends at this hour. */
  MORNING_HOUR: 6,
  /** The manual window: from here... */
  WINDOW_START_HOUR: 23,
  /** ...until (exclusive) here, the button is offered even if some townsfolk are up. */
  WINDOW_END_HOUR: 5,
  /**
   * "Everyone is asleep" only counts in the evening/night band, which starts
   * here: a town-wide afternoon nap is not a night, and the target 06:00 would
   * be sixteen hours away.
   */
  EVENING_START_HOUR: 21,
  /**
   * A sleeper who is up before this hour woke unexpectedly. Nobody wakes
   * earlier by schedule: `effectiveSleepWindow` floors the wake hour at 4.
   */
  EARLY_WAKE_BEFORE_HOUR: 4,
  /** Share of the sleepers that must be up early to end the skip (see wakeStopThreshold). */
  WAKE_STOP_SHARE: 0.25,
  /**
   * Drama rows that end the skip: at least this important. Base drama is 0.8
   * and mostly gossip ("X overheard that ..."), which flows all night among the
   * awake; 0.9+ is a drama with real severity (a snap, a crime, the whole town
   * learning a secret).
   */
  STOP_MIN_IMPORTANCE: 0.9,
  /** Safety net: ticks after which a skip that somehow did not finish is abandoned. */
  MAX_TICKS: 200,
} as const;

/**
 * World events that end a skip when they start. Every event is logged at
 * importance 0.9, ambient ones included (a bountiful catch, a traveling
 * merchant, a full moon: two or three a night in a headless run), so the feed
 * cannot tell them apart; the event type can. These are the ones that harm
 * or upset someone and that the player would want to watch as they unfold.
 */
export const DISRUPTIVE_EVENT_TYPES: readonly string[] = ['storm', 'sickness', 'fire_outbreak', 'funeral', 'scandal'];

export type SkipStopReason =
  | 'morning'
  | 'woke'
  | 'event'
  | 'cancelled'
  | 'limit'
  | 'world_replaced';

export interface SkipAgent {
  asleep: boolean;
  /** Dead or jailed: takes no part in "is everyone asleep" and cannot wake the skip. */
  ignored: boolean;
}

/** Is `hour` inside the manual window, 23:00 up to 05:00? */
export function inSkipWindow(hour: number): boolean {
  return hour >= NIGHT_SKIP.WINDOW_START_HOUR || hour < NIGHT_SKIP.WINDOW_END_HOUR;
}

/** Evening or night, the band in which the whole town being asleep offers the skip. */
function inNightBand(hour: number): boolean {
  return hour >= NIGHT_SKIP.EVENING_START_HOUR || hour < NIGHT_SKIP.MORNING_HOUR;
}

export function everyoneAsleep(agents: readonly SkipAgent[]): boolean {
  const counted = agents.filter((a) => !a.ignored);
  return counted.length > 0 && counted.every((a) => a.asleep);
}

export type CanSkip = { ok: true } | { ok: false; reason: string };

/**
 * May the night be skipped now? Offered when everyone is asleep (evening/night
 * only) or when it is between 23:00 and 05:00 whoever is up.
 */
export function canSkipNight(input: {
  hour: number;
  paused: boolean;
  active: boolean;
  agents: readonly SkipAgent[];
}): CanSkip {
  if (input.active) return { ok: false, reason: 'Already skipping the night' };
  if (input.paused) return { ok: false, reason: 'Resume the game first' };
  if (inSkipWindow(input.hour)) return { ok: true };
  if (inNightBand(input.hour) && everyoneAsleep(input.agents)) return { ok: true };
  return { ok: false, reason: 'Nights can be skipped between 23:00 and 05:00, or once everyone is asleep' };
}

/** Game minutes from `hour:minute` to the next MORNING_HOUR:00 (1..1440). */
export function minutesUntilMorning(hour: number, minute: number): number {
  const now = Math.floor(hour * 60 + minute);
  const delta = (NIGHT_SKIP.MORNING_HOUR * 60 - now + 1440) % 1440;
  return delta === 0 ? 1440 : delta;
}

/** What is fixed when a skip starts. */
export interface SkipRun {
  /** Absolute game minute the skip ends at (06:00). */
  targetMinute: number;
  startMinute: number;
  /** The speed to give back. */
  baseSpeed: number;
  /** Ids asleep at the start: only they can "wake early". */
  sleepersAtStart: readonly number[];
  ticks: number;
}

/** What the controller reads from the world before each tick of the skip. */
export interface SkipObservation {
  nowMinute: number;
  hour: number;
  /** Ids of townsfolk asleep right now. */
  asleepIds: readonly number[];
  /** Ids of townsfolk who count (alive, not jailed). */
  liveIds: readonly number[];
  /** Things that end a skip and began after it did: severe drama rows plus DISRUPTIVE_EVENT_TYPES events. */
  importantEvents: number;
  /** Chat-pool requests waiting for a slot. */
  llmBacklog: number;
}

export type SkipStep =
  | { kind: 'continue'; speed: number }
  | { kind: 'stop'; reason: SkipStopReason; /** Who woke, for reason 'woke'. */ agentIds?: number[] };

/**
 * How many early wake-ups end the skip: a quarter of the sleepers, at least two.
 *
 * "Someone woke" taken literally stopped the skip every hour or so: a townsperson
 * whose social need bottoms out wakes at 1 a.m. and wanders to the tavern (a
 * headless night in a fresh default town saw it three times), and each stop asks
 * the player to press the button again for what is, at fast-forward, a blur of
 * one person walking. A fire, a storm or a noise wakes several at once, and
 * anything that dramatic also lands in the feed as a world event, which stops the
 * skip on its own (`importantEvents`).
 */
export function wakeStopThreshold(sleepers: number): number {
  return Math.max(2, Math.ceil(sleepers * NIGHT_SKIP.WAKE_STOP_SHARE));
}

/**
 * Decide the next tick of a running skip: stop, or go on at some speed.
 *
 * Stops, in order: morning reached; something important happened (the player
 * would want to watch it at normal speed, and the alert would otherwise pass in
 * a blink); several sleepers are up before 04:00 (woken by something we are about to
 * fast-forward through); the tick cap.
 *
 * The speed is SPEED, capped by the minutes left so the clock lands exactly on
 * 06:00 rather than up to a tick past it, and dropped to THROTTLE_SPEED while
 * LLM requests are queueing: the midnight day-change alone queues a
 * self-description and a gazette call per townsperson, and 30-minute ticks
 * would turn every "once per game hour" LLM cadence into once per second.
 */
export function decideSkipStep(run: SkipRun, obs: SkipObservation): SkipStep {
  if (obs.nowMinute >= run.targetMinute) return { kind: 'stop', reason: 'morning' };
  if (obs.importantEvents > 0) return { kind: 'stop', reason: 'event' };

  const live = new Set(obs.liveIds);
  const asleep = new Set(obs.asleepIds);
  const earlyHour = obs.hour < NIGHT_SKIP.EARLY_WAKE_BEFORE_HOUR || obs.hour >= NIGHT_SKIP.EVENING_START_HOUR;
  if (earlyHour) {
    const woke = run.sleepersAtStart.filter((id) => live.has(id) && !asleep.has(id));
    if (woke.length >= wakeStopThreshold(run.sleepersAtStart.length)) {
      return { kind: 'stop', reason: 'woke', agentIds: woke };
    }
  }

  if (run.ticks >= NIGHT_SKIP.MAX_TICKS) return { kind: 'stop', reason: 'limit' };

  const remaining = run.targetMinute - obs.nowMinute;
  const pace = obs.llmBacklog > NIGHT_SKIP.LLM_BACKLOG_LIMIT ? NIGHT_SKIP.THROTTLE_SPEED : NIGHT_SKIP.SPEED;
  return { kind: 'continue', speed: Math.max(1, Math.min(pace, remaining)) };
}

/** Player-facing sentence for how a skip ended. */
export function describeSkipStop(reason: SkipStopReason): string {
  switch (reason) {
    case 'morning': return 'Good morning';
    case 'woke': return 'Skip stopped: someone woke up in the night';
    case 'event': return 'Skip stopped: something happened';
    case 'limit': return 'Skip stopped: the night dragged on';
    case 'cancelled': return 'Skip cancelled';
    case 'world_replaced': return 'Skip ended';
  }
}
