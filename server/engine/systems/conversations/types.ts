/**
 * Row types shared by the conversation phase (../conversations.ts) and its steps.
 */

import { agents, conversations, conversationQueue, worldState } from '../../../db/schema';
import { type NeedsWrapUpReason } from '../../../lib/conversationPacing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


export type WrapUpReason = 'budget' | NeedsWrapUpReason;


export type AgentRow = typeof agents.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type QueueRow = typeof conversationQueue.$inferSelect;
export type WorldRow = typeof worldState.$inferSelect;
