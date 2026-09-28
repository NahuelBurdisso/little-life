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

/** Extract a topic from a socializing action description. E.g., "Chat with Rosa about her research" → "her research" */
function extractTopic(description: string): string | undefined {
  // Match "about ..." patterns
  const aboutMatch = description.match(/\babout\s+(.+?)(?:\s*\||\s*$)/i);
  if (aboutMatch) return aboutMatch[1].trim();
  // Match "discuss ..." patterns
  const discussMatch = description.match(/\bdiscuss(?:ing)?\s+(.+?)(?:\s*\||\s*$)/i);
  if (discussMatch) return discussMatch[1].trim();
  return undefined;
}

/**
 * Whether `parseDecomposedActions` returned its idle fallback, i.e. it could
 * not read a single action out of the LLM's answer. Parsed lines always carry
 * a target location, so a lone locationless 'idle' only comes from the
 * fallback. PlanDecomposer treats that as a failed call (backoff, retry)
 * rather than pinning the agent in an hour of plan-layer idle.
 */
export function isUnparsedDecomposition(actions: DecomposedAction[]): boolean {
  return (
    actions.length === 0 ||
    (actions.length === 1 &&
      actions[0].action_type === 'idle' &&
      actions[0].description === 'idle' &&
      actions[0].target_location === undefined)
  );
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

    const actionType = inferActionType(description);
    const topic = actionType === 'socializing' ? extractTopic(description) : undefined;

    actions.push({
      description,
      action_type: actionType,
      target_location: targetLocation,
      target_agent: targetAgent,
      topic,
      duration_minutes: duration,
    });
  }

  if (actions.length === 0) return [idleFallback];

  return actions;
}

export function inferActionType(description: string): string {
  const lower = description.toLowerCase();

  // ── Tier 3: drama actions (check first — phrases may overlap generic verbs) ──
  if (/\b(sneak\s+out|break\s+out|escape|flee|bolt)\b/.test(lower)) return 'escape_attempt';
  if (/\b(smuggle|smuggling|slip\s+(?:in|past)|sneak\s+in)\b/.test(lower)) return 'smuggle';
  if (/\b(lock\s+(?:out|the\s+door)|bar\s+the\s+door|shut\s+out)\b/.test(lower)) return 'lock_out';
  if (/\b(scheme|scheming|plot|plotting|conspire|conspiring)\b/.test(lower)) return 'scheme';
  if (/\b(secret\s+meeting|clandestine\s+meeting|covert\s+meeting)\b/.test(lower)) return 'secret_meeting';
  if (/\b(confide|confiding|open\s+up\s+to|share\s+a\s+secret)\b/.test(lower)) return 'confide';
  if (/\b(give\s+a\s+speech|speech|deliver\s+remarks|oration|rally)\b/.test(lower)) return 'speech';
  if (/\b(protest|protesting|demonstration|demonstrate\s+against)\b/.test(lower)) return 'protest';
  if (/\b(announce|announcing|announcement|proclaim)\b/.test(lower)) return 'announce';

  // Eating mentions take priority over cook (e.g., "cook dinner" is eating intent)
  if (/\b(lunch|breakfast|dinner|meal|snack|food)\b/.test(lower)) return 'eating';

  // ── Tier 2: zone-bound activities ──
  if (/\b(cook|cooking|prepare\s+(?:a\s+)?meal|bake|baking)\b/.test(lower)) return 'cook';
  if (/\b(contemplate|contemplating|reflect|reflecting|meditate|meditating|think\s+quietly)\b/.test(lower)) return 'contemplate';
  if (/\b(fish|fishing|go\s+fishing|cast\s+(?:a\s+)?line)\b/.test(lower)) return 'fish';
  if (/\b(garden|gardening|tend\s+(?:the\s+)?garden|plant(?:ing)?\s+flowers)\b/.test(lower)) return 'garden';
  if (/\b(forage|foraging|gather\s+(?:herbs|berries|mushrooms)|pick\s+herbs)\b/.test(lower)) return 'forage';
  if (/\b(perform|performing|play\s+music|sing|singing|put\s+on\s+a\s+show)\b/.test(lower)) return 'perform';
  if (/\b(watch|watching|spectate|spectating|observe\s+(?:the\s+)?crowd)\b/.test(lower)) return 'watch';
  if (/\b(browse|browsing|peruse|window\s+shop)\b/.test(lower)) return 'browse';
  if (/\b(jog|jogging|run\s+(?:laps|around)|go\s+for\s+a\s+run)\b/.test(lower)) return 'jog';

  // ── Generic verbs ──
  if (/\b(eat|eating|lunch|breakfast|dinner|food|meal|snack)\b/.test(lower)) return 'eating';
  if (/\b(work|working|task|shift|job|labor)\b/.test(lower)) return 'working';
  if (/\b(talk|talking|chat|chatting|visit|visiting|socialize|socializ|meet|meeting|drink|drinks|tavern|pub|bar|hang\s+out)\b/.test(lower)) return 'socializing';
  if (/\b(sleep|sleeping|rest|resting|nap|napping|bed)\b/.test(lower)) return 'sleeping';
  if (/\b(walk|walking|stroll|strolling|wander|wandering)\b/.test(lower)) return 'walking';
  if (/\b(go\s+to|head\s+to|travel|move)\b/.test(lower)) return 'walking';
  if (/\b(shop|shopping|buy|buying|purchase|purchasing)\b/.test(lower)) return 'shopping';

  return 'idle';
}
