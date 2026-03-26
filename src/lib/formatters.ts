export function formatTime(time: { hour: number; minute: number }): string {
  const h = time.hour % 12 || 12;
  const ampm = time.hour >= 12 ? "PM" : "AM";
  const m = time.minute.toString().padStart(2, "0");
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
  tickSpeed: number
): string {
  // Detect if timestamp is a Date.now() value (>1 billion) vs game ticks (<1 million)
  // and convert to game-time minutes accordingly
  let minutesAgo: number;
  if (ticksThen > 1_000_000_000) {
    // Real-time timestamp (Date.now milliseconds) — convert to game minutes
    const realMsAgo = Date.now() - ticksThen;
    minutesAgo = (realMsAgo / 1000) * tickSpeed;
  } else {
    minutesAgo = (ticksNow - ticksThen) * tickSpeed;
  }
  if (minutesAgo < 0) minutesAgo = 0;
  if (minutesAgo < 60) return `${Math.round(minutesAgo)}m ago`;
  const hoursAgo = minutesAgo / 60;
  if (hoursAgo < 24) return `${Math.round(hoursAgo)}h ago`;
  return `${Math.round(hoursAgo / 24)}d ago`;
}

export function weatherEmoji(weather: string): string {
  const map: Record<string, string> = {
    sunny: "\u2600\uFE0F",
    cloudy: "\u2601\uFE0F",
    rainy: "\uD83C\uDF27\uFE0F",
    stormy: "\u26C8\uFE0F",
    foggy: "\uD83C\uDF2B\uFE0F",
  };
  return map[weather] ?? "\uD83C\uDF24\uFE0F";
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
