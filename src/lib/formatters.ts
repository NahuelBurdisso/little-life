export function formatTime(time: { hour: number; minute: number }): string {
  const h = time.hour % 12 || 12;
  const ampm = time.hour >= 12 ? "PM" : "AM";
  // `advanceClock` adds `tick_speed` to the minute, and 0.5x is a real speed, so
  // half of all ticks carry a fractional minute that pads to "0.5" and renders
  // as "9:0.5 AM".
  const m = Math.floor(time.minute).toString().padStart(2, "0");
  return `${h}:${m} ${ampm}`;
}

export function formatMood(mood: number): string {
  if (mood > 80) return "Very Happy";
  if (mood > 60) return "Content";
  if (mood > 40) return "Okay";
  if (mood > 20) return "Down";
  return "Miserable";
}

export function formatMoney(amount: number): string {
  return `${Math.floor(amount)} coins`;
}

export function timeAgo(
  ticksThen: number,
  ticksNow: number,
  tickSpeed: number,
  isPaused = false
): string {
  // `is_paused` only normalises the minutes-per-tick rate, it does not freeze the
  // clock. Pausing retains the user's tick_speed, so a world paused at 4x would
  // otherwise multiply ages by 4 while the sim is frozen. `change_speed(0)` still
  // writes tick_speed 0 with is_paused true, so the 0 case stays guarded: both
  // fall back to the 1 minute/tick default rather than distorting the age.
  //
  // Consequence: only the game-tick branch below actually stops while paused,
  // because `ticksNow` stops advancing. The real-timestamp branch is measured
  // against `Date.now()`, so those ages keep climbing at 1 game-minute per real
  // second on a stopped clock. Freezing it would mean threading a "paused at"
  // wall-clock timestamp through every caller, which isn't worth the complexity
  // for a relative age label.
  const speed = isPaused || tickSpeed <= 0 ? 1 : tickSpeed;
  // Detect if timestamp is a Date.now() value (>1 billion) vs game ticks (<1 million)
  // and convert to game-time minutes accordingly
  let minutesAgo: number;
  if (ticksThen > 1_000_000_000) {
    // Real-time timestamp (Date.now milliseconds) — convert to game minutes
    const realMsAgo = Date.now() - ticksThen;
    minutesAgo = (realMsAgo / 1000) * speed;
  } else {
    minutesAgo = (ticksNow - ticksThen) * speed;
  }
  if (minutesAgo < 0) minutesAgo = 0;
  if (minutesAgo < 60) return `${Math.round(minutesAgo)}m ago`;
  const hoursAgo = minutesAgo / 60;
  if (hoursAgo < 24) return `${Math.round(hoursAgo)}h ago`;
  return `${Math.round(hoursAgo / 24)}d ago`;
}

/**
 * Age of something stamped in absolute GAME minutes (`gameMinutes(world.time)`),
 * e.g. a story beat's `relationship_events.game_minute`.
 *
 * Unlike `timeAgo`, both ends are on the game clock, so the label stands still
 * while the game is paused and an overnight break doesn't make yesterday's
 * fight read as "12d ago" at 1x. Same compact shape as `timeAgo` so the two
 * sit side by side in the feed.
 */
export function gameTimeAgo(minuteThen: number, minuteNow: number): string {
  const minutesAgo = Math.max(0, minuteNow - minuteThen);
  if (minutesAgo < 1) return "now";
  if (minutesAgo < 60) return `${Math.floor(minutesAgo)}m ago`;
  if (minutesAgo < 1440) return `${Math.floor(minutesAgo / 60)}h ago`;
  return `${Math.floor(minutesAgo / 1440)}d ago`;
}

/** "Day 12, 14:05" for an absolute game minute — the long form of `gameTimeAgo`. */
export function formatGameMinute(minute: number): string {
  const day = Math.floor(minute / 1440);
  const hour = Math.floor((minute % 1440) / 60);
  const min = Math.floor(minute % 60);
  return `Day ${day}, ${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Same night as `computeDayPhase` on the server (20:00-05:00). Kept as an hour
 * check so the client doesn't need the world's `day_phase` column to draw an icon.
 */
export function isNightHour(hour: number): boolean {
  return hour >= 20 || hour < 5;
}

/**
 * `hour` is optional: a weather *choice* (the event menu's buttons) has no time
 * of day and keeps the sun. Pass the world hour to get the night variants -
 * clear skies become a moon, and the unknown-weather default too - instead of
 * a sun shining at 9 PM.
 */
export function weatherEmoji(weather: string, hour?: number): string {
  const night = hour != null && isNightHour(hour);
  const map: Record<string, string> = {
    sunny: night ? "\uD83C\uDF19" : "\u2600\uFE0F",
    cloudy: "\u2601\uFE0F",
    rainy: "\uD83C\uDF27\uFE0F",
    stormy: "\u26C8\uFE0F",
    foggy: "\uD83C\uDF2B\uFE0F",
    snowy: "\uD83C\uDF28\uFE0F",
    windy: "\uD83D\uDCA8",
    hot: "\uD83D\uDD25",
  };
  return map[weather] ?? (night ? "\uD83C\uDF19" : "\uD83C\uDF24\uFE0F");
}

export function seasonEmoji(season: string): string {
  const map: Record<string, string> = {
    spring: "\uD83C\uDF38",
    summer: "\u2600\uFE0F",
    autumn: "\uD83C\uDF42",
    winter: "\u2744\uFE0F",
  };
  return map[season] ?? "";
}
