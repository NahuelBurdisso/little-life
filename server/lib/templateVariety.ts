/**
 * Town-wide memory of the template chats played in the last game hour, so two
 * pairs don't say the same thing at the same time (playtest #3: two pairs the
 * same night both opened with "What do you make of the full moon?").
 * templateChat.ts `composeTemplateChat` reads it through `townRecent`.
 *
 * In memory, game minutes; cleared on a world replace (worldCaches). A stamp
 * from the future (after a load) is ignored rather than trusted.
 */

/** How long a played script or opener counts as "just heard", in game minutes. */
export const TOWN_VARIETY_MINUTES = 60;

const played: Array<{ scriptId: string; opener: string; at: number }> = [];

export function recordTownTemplate(scriptId: string, opener: string, at: number): void {
  played.push({ scriptId, opener, at });
  while (played.length > 64) played.shift();
}

export function townRecentTemplates(now: number): { scripts: Set<string>; openers: Set<string> } {
  const recent = played.filter((p) => now - p.at >= 0 && now - p.at < TOWN_VARIETY_MINUTES);
  return { scripts: new Set(recent.map((p) => p.scriptId)), openers: new Set(recent.map((p) => p.opener)) };
}

export function clearTownTemplates(): void {
  played.length = 0;
}
