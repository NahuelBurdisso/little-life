import { db } from '../db';
import { conversations, relationshipEvents, agents, shared_knowledge } from '../db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';

/**
 * What one conversation did to the people in it: the relationship events it
 * produced between its participants, the facts it put into circulation about
 * them, and the summed friendship/romance/trust deltas.
 *
 * Lived inline in `conversations.getImpact` (the ConversationDetail panel) until
 * the player-outcome reporter (playerOutcomes.ts) needed the same numbers to tell
 * the player what their nudge did — two copies would have drifted into two
 * different answers to "how did it go".
 *
 * Nothing links a relationship event or a fact to the conversation that caused
 * it, so both are matched by time window and participants: the completion
 * pipeline stamps them with the wall-clock `Date.now()` of the end, which lands
 * inside [started_at, ended_at]. The ±5 s slack catches the rows written a moment
 * after the conversation row itself was closed.
 */

/** Slack either side of the conversation's wall-clock span. */
const WINDOW_SLACK_MS = 5000;

export interface ConversationImpactEvent {
  id: number;
  agent_a: number;
  agent_b: number;
  event_type: string;
  description: string;
  friendshipDelta: number;
  romanceDelta: number;
  trustDelta: number;
  sentiment: number;
}

export interface ConversationImpactFact {
  id: number;
  type: string;
  content: string;
  sensitivity: number;
}

export interface ConversationImpact {
  conversation: typeof conversations.$inferSelect;
  names: Record<number, string>;
  relationshipEvents: ConversationImpactEvent[];
  createdFacts: ConversationImpactFact[];
  totals: {
    friendship: number;
    romance: number;
    trust: number;
    sentiment: number;
    turns: number;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeConversationImpact(conversationId: number): ConversationImpact | null {
  const convo = db.select().from(conversations)
    .where(eq(conversations.id, conversationId)).get();
  if (!convo) return null;

  const participantIds = convo.participants as number[];
  const startedAt = convo.started_at;
  // A conversation still being completed has no `ended_at` yet (the completion
  // pipeline closes the row after emitting `conversation:ended`); its events are
  // stamped "now", so now is the right end of the window.
  const endedAt = convo.ended_at ?? Date.now();

  const relEvents = db.select().from(relationshipEvents)
    .where(and(
      gte(relationshipEvents.timestamp, startedAt - WINDOW_SLACK_MS),
      lte(relationshipEvents.timestamp, endedAt + WINDOW_SLACK_MS),
    ))
    .all()
    .filter(e => participantIds.includes(e.agent_a) && participantIds.includes(e.agent_b));

  const names: Record<number, string> = {};
  for (const pid of participantIds) {
    const agent = db.select({ name: agents.name }).from(agents).where(eq(agents.id, pid)).get();
    if (agent) names[pid] = agent.name;
  }

  const createdFacts = db.select().from(shared_knowledge)
    .where(and(
      gte(shared_knowledge.created_at, startedAt - WINDOW_SLACK_MS),
      lte(shared_knowledge.created_at, endedAt + WINDOW_SLACK_MS),
    ))
    .all()
    .filter(f => participantIds.includes(f.subject_id) || (f.target_id != null && participantIds.includes(f.target_id)));

  // Each event's delta is the mean of its two directions, so a pair's number
  // reads as "how much closer/further they got", not the sum of both feelings.
  let friendship = 0;
  let romance = 0;
  let trust = 0;
  const events = relEvents.map(e => {
    const friendshipDelta = (e.friendship_delta_ab + e.friendship_delta_ba) / 2;
    const romanceDelta = (e.romance_delta_ab + e.romance_delta_ba) / 2;
    const trustDelta = (e.trust_delta_ab + e.trust_delta_ba) / 2;
    friendship += friendshipDelta;
    romance += romanceDelta;
    trust += trustDelta;
    return {
      id: e.id,
      agent_a: e.agent_a,
      agent_b: e.agent_b,
      event_type: e.event_type,
      description: e.description,
      friendshipDelta,
      romanceDelta,
      trustDelta,
      sentiment: e.sentiment,
    };
  });

  return {
    conversation: convo,
    names,
    relationshipEvents: events,
    createdFacts: createdFacts.map(f => ({
      id: f.id,
      type: f.type,
      content: f.content,
      sensitivity: f.sensitivity,
    })),
    totals: {
      friendship: round1(friendship),
      romance: round1(romance),
      trust: round1(trust),
      sentiment: convo.sentiment ?? 0,
      turns: (convo.messages as unknown[] | null)?.length ?? 0,
    },
  };
}
