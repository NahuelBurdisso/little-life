/** Shared prose rendering for activity log rows.
 *  Lives outside ActivityFeed so DramaAlerts renders the same sentence for the
 *  same row instead of drifting into a second, subtly different phrasing. */

import { endSentence, shortenForFeed } from '../../server/lib/factText';

export interface ActivityEntry {
  id?: number;
  type: string;
  template_data?: Record<string, string | number>;
  metadata?: { chainId?: string; chainDepth?: number; ruleId?: string } | null;
  timestamp: number;
  real_timestamp?: number;
  agent_ids?: number[];
}

/** Zone actions log only `{ agent, action }`, so the sentence is built here. */
const ZONE_ACTION_PHRASES: Record<string, string> = {
  cook: 'cooked a meal',
  rest: 'rested',
  contemplate: 'sat by the river, lost in thought',
  fish: 'went fishing',
  garden: 'tended the garden',
  forage: 'foraged for food',
  perform: 'performed for the crowd',
  watch: 'watched a performance',
  browse: 'browsed the shelves',
  jog: 'went for a jog',
};

/** `goal_description` is the raw GOAL_REGISTRY key, so it needs prose here. */
const GOAL_PHRASES: Record<string, string> = {
  revenge: 'getting revenge',
  seduce: 'winning someone over',
  steal_from: 'stealing from someone',
  protect: 'looking after someone',
  investigate: 'digging up the truth',
  undermine: 'undermining a rival',
  pay_debt: 'paying off a debt',
  get_sober: 'getting sober',
  befriend: 'making a friend',
  comfort_grieving: 'comforting someone grieving',
};

/** State types are registry keys like `in_debt`; make them readable. */
function humanize(token: unknown): string {
  return String(token).replace(/_/g, ' ');
}

function goalPhrase(d: Record<string, any>): string {
  const raw = d.goal_description ?? d.goal;
  if (raw == null) return 'a goal';
  return GOAL_PHRASES[String(raw)] ?? humanize(raw);
}

export function renderMessage(entry: ActivityEntry): string {
  const d = entry.template_data ?? {};
  // Before the generic `message` branch, which would otherwise swallow it.
  if (entry.type === 'error' && d.system) return `[${d.system}] ${d.message ?? 'unknown error'}`;
  if (d.description) return String(d.description);
  if (d.message) return String(d.message);

  // Goals
  // `goalPhrase` because trigger-generated goals carry the raw GOAL_REGISTRY key
  // here, the same as the completed/abandoned rows; LLM-authored ones carry prose
  // and fall through it unchanged.
  if (entry.type === 'goal_created' && d.name && d.goal) return `${d.name} set a new goal: ${goalPhrase(d)}`;
  if (entry.type === 'goal_completed' && (d.agent || d.name)) return `${d.agent ?? d.name} accomplished: ${goalPhrase(d)}`;
  if (entry.type === 'goal_abandoned' && (d.agent || d.name)) return `${d.agent ?? d.name} gave up on: ${goalPhrase(d)}`;

  // Aspirations
  if (entry.type === 'goal_ambition_shifted' && d.name) return `${d.name} had a change of heart — now driven by ${d.to}`;
  if (entry.type === 'goal_ambition_generated' && d.name) return `${d.name} discovered their life ambition: ${d.ambition}`;

  // Plans
  if (entry.type === 'plan_generated' && d.agentName) return `${d.agentName} planned their day.`;
  // The server stores a feed-sized reason now; `shortenForFeed` still guards
  // rows logged before that, and never cuts mid-word the way `substring` did.
  // `endSentence` because the reason may already end in "." or "…".
  if (entry.type === 'plan_changed' && d.agentName) {
    return d.reason
      ? endSentence(`${d.agentName} changed plans: ${shortenForFeed(String(d.reason), 80)}`)
      : `${d.agentName} changed plans.`;
  }

  // States
  if (d.agent && d.state) {
    if (entry.type === 'state_gained') return `${d.agent} became ${humanize(d.state)}.`;
    if (entry.type === 'state_lost') return `${d.agent} is no longer ${humanize(d.state)}.`;
  }

  // Relationships
  if (d.agent1 && d.agent2 && d.status) return `${d.agent1} and ${d.agent2} are now ${d.status}.`;
  if (d.agent1 && d.agent2 && d.location !== undefined) return `${d.agent1} and ${d.agent2} finished talking.`;

  // Economy
  // `item` is an ITEM_REGISTRY key like `food_raw`, so it needs the same
  // treatment as the other raw tokens.
  if (d.agent && d.amount != null && d.item) return `${d.agent} bought ${humanize(d.item)} for $${d.amount}.`;
  if (d.agent && d.amount != null) return `${d.agent} earned $${d.amount}.`;

  // Interactions
  if (d.initiator_name && d.verb && d.target_name) return `${d.initiator_name} ${d.verb} ${d.target_name}${d.location ? ' at ' + d.location : ''}`;

  // Hobbies
  if (entry.type === 'hobby_levelup' && d.agent && d.hobby) {
    return `${d.agent} improved at ${humanize(d.hobby)} (level ${d.level}).`;
  }

  // Zone actions
  if (d.agent && d.action) {
    const phrase = ZONE_ACTION_PHRASES[String(d.action)];
    if (phrase) return `${d.agent} ${phrase}.`;
  }

  // Last resort. `humanize` rather than the raw key so an unhandled type reads
  // as "state gained" in the feed instead of leaking `state_gained`.
  return humanize(entry.type);
}
