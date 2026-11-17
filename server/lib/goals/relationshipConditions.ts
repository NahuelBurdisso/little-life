/**
 * Condition helpers shared by the goal system (`engine/systems/goals.ts`) and
 * the morning review (`GoalReviewer`). They live here rather than in goals.ts
 * because goals.ts imports the GoalReviewer instance: GoalReviewer importing
 * back from goals.ts would be a cycle that instantiates the reviewer before its
 * class is defined.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { relationships } from '../../db/schema';

export function compareOp(actual: number, op: string, value: number): boolean {
  switch (op) {
    case '>':  return actual > value;
    case '<':  return actual < value;
    case '>=': return actual >= value;
    case '<=': return actual <= value;
    case '==': return actual === value;
    default:   return false;
  }
}

export function getRelationship(agentA: number, agentB: number) {
  const a = Math.min(agentA, agentB);
  const b = Math.max(agentA, agentB);
  return db.select().from(relationships)
    .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
    .get();
}

/** A relationship value from the point of view of the agent (`isA` = they are agent_a). */
export function getRelField(rel: typeof relationships.$inferSelect, field: string, isA: boolean): number {
  switch (field) {
    case 'friendship': return isA ? rel.friendship_ab : rel.friendship_ba;
    case 'romance':    return isA ? rel.romance_ab    : rel.romance_ba;
    case 'trust':      return isA ? rel.trust_ab      : rel.trust_ba;
    case 'familiarity': return rel.familiarity;
    default:           return 0;
  }
}
