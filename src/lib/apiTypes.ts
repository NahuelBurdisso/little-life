import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../server/router';

/**
 * The rows the server sends, named once.
 *
 * Components and canvas systems used to take `any[]` for agents, locations, events...
 * because the row shapes only existed as the inferred results of tRPC queries. These
 * aliases are those same inferred shapes, so a renamed column on the server is a compile
 * error here instead of an `undefined` on screen. Types only: nothing is imported at runtime.
 */
type Out = inferRouterOutputs<AppRouter>;

/** `agents.getActive`: an agent row plus needs, active states, job and thought. */
export type AgentView = Out['agents']['getActive'][number];
/** `world.getState`. */
export type WorldView = NonNullable<Out['world']['getState']>;
/** `world.getActiveEvents`. */
export type WorldEventView = Out['world']['getActiveEvents'][number];
/** `locations.getAll`. */
export type LocationView = Out['locations']['getAll'][number];
/** `conversations.getActive`. */
export type ConversationView = Out['conversations']['getActive'][number];
/** `relationships.getGraph`. */
export type RelationshipView = Out['relationships']['getGraph'][number];
/** `activity.getRecent`. */
export type ActivityView = Out['activity']['getRecent'][number];

// ─── Slices for the canvas ────────────────────────────────────────────────────
// The canvas planners are pure functions that read a handful of fields each (and are
// tested with a handful of fields each). They take these instead of the full rows: what
// a planner cannot do without is required, everything else it may look at is optional,
// so the code has to cope with it missing, as it does for a save from an older build.

/** A location as the canvas reads it: what kind of place, where it is and where its door is. */
export type LocationLite =
  Pick<LocationView, 'id' | 'type' | 'position' | 'entry_point'>
  & Partial<Omit<LocationView, 'id' | 'type' | 'position' | 'entry_point'>>;

/**
 * An active world event as the canvas reads it. All optional and nullable on purpose:
 * a row from an older save can lack `triggered_by`, and the planners skip what they
 * cannot place instead of throwing in the middle of a frame.
 */
export interface WorldEventLite {
  id?: number;
  type?: string;
  name?: string;
  started_at?: number;
  duration?: number;
  location_id?: number | null;
  triggered_by?: string | null;
}

/** The world row as the canvas reads it: every field optional, the clock too. */
export type WorldLite =
  Partial<Omit<WorldView, 'time'>>
  & { time?: Partial<WorldView['time']> };

/** A conversation as the canvas reads it. Participant ids may arrive as strings. */
export type ConversationLite =
  Partial<Omit<ConversationView, 'participants'>>
  & { participants?: ReadonlyArray<number | string> };

/** A relationship row as the canvas reads it: the pair, and whatever else it looks at. */
export type RelationshipLite =
  Pick<RelationshipView, 'agent_a' | 'agent_b'>
  & Partial<Omit<RelationshipView, 'agent_a' | 'agent_b'>>;

/** An activity row as the canvas reads it. */
export type ActivityLite =
  Pick<ActivityView, 'id' | 'type'>
  & Partial<Omit<ActivityView, 'id' | 'type'>>;
