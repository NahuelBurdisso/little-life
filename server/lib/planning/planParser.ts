import type { PlanBlock, DecomposedAction } from './types.js';

// Lines starting with these words are preamble and should be skipped
const PREAMBLE_PREFIXES = ['here', 'my plan', 'today', 'below', 'sure', 'certainly', 'of course', 'alright', 'okay', '#'];

function isPreambleLine(line: string): boolean {
  const lower = line.toLowerCase().trim();
  return PREAMBLE_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function stripBulletPrefix(line: string): string {
  // Strip leading numbering like "1.", "2)", bullets like "-", "*", "•"
  return line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim();
}

function parseHour(token: string): number | null {
  // Accepts "HH:00", "H:00", or bare hour "H" or "HH"
  const withColon = token.match(/^(\d{1,2}):\d{2}$/);
  if (withColon) return parseInt(withColon[1], 10);

  const bare = token.match(/^(\d{1,2})$/);
  if (bare) return parseInt(bare[1], 10);

  return null;
}

function parseTimeRange(token: string): { start: number; end: number } | null {
  // Formats: "HH:00-HH:00", "H:00-H:00", "H-H", "HH-HH"
  const parts = token.split('-');
  if (parts.length < 2) return null;

  // Re-join in case of negative values (shouldn't happen, but safe)
  // The last part is end, everything before is start
  const endRaw = parts[parts.length - 1].trim();
  const startRaw = parts.slice(0, parts.length - 1).join('-').trim();

  const start = parseHour(startRaw);
  const end = parseHour(endRaw);

  if (start === null || end === null) return null;
  if (start < 0 || start > 23 || end < 0 || end > 24) return null;

  return { start, end };
}

function fuzzyMatchLocation(hint: string, validLocations: string[]): string {
  const lower = hint.toLowerCase().trim();

  // 1. Exact match (case-insensitive)
  const exact = validLocations.find(loc => loc.toLowerCase() === lower);
  if (exact) return exact;

  // 2. Substring: valid location name contains the hint
  const sub1 = validLocations.find(loc => loc.toLowerCase().includes(lower));
  if (sub1) return sub1;

  // 3. Substring: hint contains the valid location name
  const sub2 = validLocations.find(loc => lower.includes(loc.toLowerCase()));
  if (sub2) return sub2;

  // 4. Return original hint if nothing found
  return hint.trim();
}

export function parsePlanBlocks(raw: string, validLocations: string[]): PlanBlock[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split('\n');
  const blocks: PlanBlock[] = [];
  let blockIndex = 0;

  for (const rawLine of lines) {
    const line = stripBulletPrefix(rawLine.trim());
    if (!line) continue;
    if (isPreambleLine(line)) continue;

    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 3) continue;

    const timeToken = parts[0];
    const action = parts[1];
    const locationRaw = parts[2];

    if (!timeToken || !action || !locationRaw) continue;

    const timeRange = parseTimeRange(timeToken);
    if (!timeRange) continue;

    const locationHint = fuzzyMatchLocation(locationRaw, validLocations);

    blocks.push({
      id: `block_${blockIndex}`,
      start_hour: timeRange.start,
      end_hour: timeRange.end,
      broad_action: action,
      location_hint: locationHint,
      status: 'pending',
    });

    blockIndex++;
  }

  // Require at least 3 valid blocks; otherwise return empty to trigger fallback
  if (blocks.length < 3) return [];

  return blocks;
}

function extractDuration(text: string): number {
  // Match patterns like "30 minutes", "about 10", "10 min", "~15", "45mins"
  const match = text.match(/~?about\s+(\d+)|(\d+)\s*(?:minutes?|mins?)/i);
  if (match) {
    const raw = parseInt(match[1] ?? match[2], 10);
    return Math.min(120, Math.max(5, raw));
  }

  // Bare number at start or end (last resort)
  const bareMatch = text.match(/\b(\d+)\b/);
  if (bareMatch) {
    const raw = parseInt(bareMatch[1], 10);
    // Only treat as minutes if it's a plausible duration
    if (raw >= 5 && raw <= 120) return raw;
  }

  return 30; // default
}

function findAgentMatch(description: string, validAgents: string[]): string | undefined {
  const lower = description.toLowerCase();
  return validAgents.find(agent => lower.includes(agent.toLowerCase()));
}

export function parseDecomposedActions(
  raw: string,
  validLocations: string[],
  validAgents: string[]
): DecomposedAction[] {
  const idleFallback: DecomposedAction = {
    description: 'idle',
    action_type: 'idle',
    duration_minutes: 60,
  };

  if (!raw || !raw.trim()) return [idleFallback];

  const lines = raw.split('\n');
  const actions: DecomposedAction[] = [];

  for (const rawLine of lines) {
    const line = stripBulletPrefix(rawLine.trim());
    if (!line) continue;
    if (isPreambleLine(line)) continue;

    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 3) continue;

    const description = parts[0];
    const locationRaw = parts[1];
    const durationRaw = parts[2];

    if (!description || !locationRaw || !durationRaw) continue;

    const duration = extractDuration(durationRaw);
    const targetLocation = fuzzyMatchLocation(locationRaw, validLocations);
    const targetAgent = findAgentMatch(description, validAgents);

    actions.push({
      description,
      action_type: inferActionType(description),
      target_location: targetLocation,
      target_agent: targetAgent,
      duration_minutes: duration,
    });
  }

  if (actions.length === 0) return [idleFallback];

  return actions;
}

export function inferActionType(description: string): string {
  const lower = description.toLowerCase();

  if (/\b(eat|eating|lunch|breakfast|dinner|food|meal|snack)\b/.test(lower)) return 'eating';
  if (/\b(work|working|task|shift|job|labor)\b/.test(lower)) return 'working';
  if (/\b(talk|talking|chat|chatting|visit|visiting|socialize|socializ|meet|meeting)\b/.test(lower)) return 'socializing';
  if (/\b(sleep|sleeping|rest|resting|nap|napping|bed)\b/.test(lower)) return 'sleeping';
  if (/\b(walk|walking|go to|head to|travel|move)\b/.test(lower)) return 'walking';
  if (/\b(shop|shopping|buy|buying|purchase|purchasing)\b/.test(lower)) return 'shopping';

  return 'idle';
}
