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
}

export type GoalRow = typeof goals.$inferSelect;
export type QueueRow = typeof conversationQueue.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type KnowledgeRow = typeof shared_knowledge.$inferSelect;
export type WorldEventRow = typeof worldEvents.$inferSelect;
