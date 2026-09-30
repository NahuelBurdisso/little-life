import {
  agents,
  needs,
  economy,
  relationships,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  memories,
  locations,
  worldState,
  worldEvents,
  templates,
  templateUsage,
  activityLog,
  economyTransactions,
  shared_knowledge,
  agentStates,
  relationshipEvents,
  interactions,
  interactionParticipants,
  goals,
  aspirations,
  interactionCooldowns,
  gazetteIssues,
  simSnapshots,
  children,
} from './schema';

/**
 * Every table whose rows belong to one world, in reverse-dependency order
 * (children first), so deleting in this order never trips a foreign key.
 *
 * Lives here rather than in `routers/setup.ts` because two lifecycles need the
 * exact same list: a world replace wipes these tables (setup.ts), and a save
 * load (lib/saves.ts) swaps their contents for a save file's. A table that is
 * in one list and not the other is a bug either way — a replace that leaves it
 * behind hands the old world's rows to the new town, a load that skips it
 * keeps the current town's rows next to the loaded one's. The standalone
 * reseed script (`db/seed.ts`) wipes with this list too.
 */
export const ALL_TABLES = [
  // References agents and locations: gone before either.
  children,
  simSnapshots,
  gazetteIssues,
  interactionCooldowns,
  interactionParticipants,
  interactions,
  goals,
  aspirations,
  activityLog,
  templateUsage,
  templates,
  worldEvents,
  worldState,
  memories,
  conversationSchedulerState,
  conversationQueue,
  conversations,
  relationshipEvents,
  relationships,
  economyTransactions,
  economy,
  shared_knowledge,
  agentStates,
  needs,
  agents,
  locations,
] as const;
