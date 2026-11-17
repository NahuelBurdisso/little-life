/**
 * Per-agent trackers of the states phase, kept across ticks.
 *
 * One instance for the whole server: the triggers and effects read and write
 * them, and ../states.ts clears them on a world replace (`clearStatesTrackers`)
 * and checkpoints them (`statesTrackersSnapshotStore`). Every value is a game
 * minute (or a list of them), keyed by agent id.
 */

// Game minute when an agent had stressed state removed (to avoid re-triggering immediately)
export const stressRemovedAt = new Map<number, number>();

export const gamblingCooldowns = new Map<string, number>();

// Game minute when mood first dropped below 15 (for depressed trigger duration check)
export const lowMoodSince = new Map<number, number>(); // agentId → game minute when mood first dropped below 15

// Game minute when social first dropped below 20 (for lonely trigger duration check)
export const lowSocialSince = new Map<number, number>(); // agentId → game minute when social dropped below 20

// Track when an agent recovered from sickness (for immunity cooldown)
export const sickRecoveredAt = new Map<number, number>(); // agentId → game minute when sickness expired

// Track drunk episode timestamps per agent for alcoholism detection
export const drunkHistory = new Map<number, number[]>();

// Track alcoholism recovery for relapse mechanic
export const alcoholRecoveredAt = new Map<number, number>();

// Track how long an agent has been broke (for in_debt trigger)
export const brokeSince = new Map<number, number>();

// Game minutes when each agent gambled (for addiction detection)
export const gamblingHistory = new Map<number, number[]>(); // agentId → array of game minutes when gambled
