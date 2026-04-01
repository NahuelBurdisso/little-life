import { TYPE_PRIORITY } from './constants';

/**
 * Default importance values (1–10) for known event types.
 * Unknown events fall back to 3.
 */
const IMPORTANCE_DEFAULTS: Record<string, number> = {
  moved_to_location: 2,
  idle_at_location: 1,
  started_conversation: 5,
  ended_conversation: 3,
  conversation_long: 6,
  relationship_changed: 7,
  state_triggered: 7,
  state_cleared: 4,
  need_critical: 6,
  need_critical_routine: 3,
  learned_gossip: 6,
  witnessed_event: 5,
  created_secret: 8,
  financial_distress: 6,
  significant_transaction: 3,
  world_event: 4,
  interaction_completed: 7,
  plan_created: 4,
  plan_changed: 6,
  reflection: 8,
};

const UNKNOWN_IMPORTANCE_FALLBACK = 3;

/**
 * Return the base importance score (1–10) for a given event type.
 * Falls back to 3 for unrecognised types.
 */
export function getImportance(eventType: string): number {
  return IMPORTANCE_DEFAULTS[eventType] ?? UNKNOWN_IMPORTANCE_FALLBACK;
}

/**
 * Return the overflow-protection priority tier for a memory type.
 * Higher value = higher retention priority when the cache is full.
 * Defaults to 1 for unknown types.
 */
export function getTypePriority(memoryType: string): number {
  return TYPE_PRIORITY[memoryType] ?? 1;
}
