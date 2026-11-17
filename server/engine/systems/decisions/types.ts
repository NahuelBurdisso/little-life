/**
 * Row and decision types shared by the decision phase (../decisions.ts) and its steps.
 */

import {
  agents, needs, economy, relationships, locations, conversationQueue, conversations, shared_knowledge, goals, worldEvents,
} from '../../../db/schema';

// --- Types ---

export type AgentRow = typeof agents.$inferSelect;
export type NeedsRow = typeof needs.$inferSelect;
export type EconRow = typeof economy.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
export type RelRow = typeof relationships.$inferSelect;
export type WorldRow = {
  time: { day: number; hour: number; minute: number; totalTicks: number; seasonDay: number; season: string };
  tick_speed: number;
};

export interface ScoredAction {
  action: string;
  score: number;
  targetLocationId?: number;
  targetAgentId?: number;
  topic?: string;
  source?: string;
  /**
   * What the player reads in the cast bar and the agent panel while this runs
   * ("On the way to see Elena, who is ill"): carried on the action, which the
   * client's describeAction prefers to anything it derives (src/lib/actionText.ts).
   */
  description?: string;
  /** The same for the walk there, when it reads differently ("On the way to see Elena, who is ill"). */
  walkDescription?: string;
}

export type GoalRow = typeof goals.$inferSelect;
export type QueueRow = typeof conversationQueue.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type KnowledgeRow = typeof shared_knowledge.$inferSelect;
export type WorldEventRow = typeof worldEvents.$inferSelect;
