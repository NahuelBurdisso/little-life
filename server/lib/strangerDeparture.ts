/**
 * The hooded stranger leaves — the close of the Mysterious Stranger event.
 *
 * The event is pure intrigue ("A hooded figure… whispering secrets") with no
 * entity behind it, and it used to simply switch off. Playtest #4: it fired 10
 * times in 27 days and never resolved, and 9 of ~30 active goals became
 * "find out who the hooded stranger is" — goals that could never progress (no
 * target), died of staleness, and were re-created by the next visit. Now the
 * visit ends on a beat the whole town hears, and the questions it raised are
 * answered: those goals complete ("the mystery is solved"), which is the one
 * ending such a goal can honestly have.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, goals } from '../db/schema';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { completeGoal } from './goals/goalProgress';

export const STRANGER_LEAVES = {
  name: 'The Stranger Leaves',
  description: 'The hooded stranger took the north road at dawn: only a pilgrim passing through, it turns out, and whatever they whispered went with them.',
};

/** A goal about the stranger: "Find out who the hooded figure is", "Keep an eye on the mysterious stranger". */
export const STRANGER_GOAL = /\bhooded\b|\bcloaked\b|\bmysterious (?:stranger|figure)\b|\bthe stranger\b/i;

/** Returns how many goals it settled (tests). */
export function strangerLeaves(nowMinutes: number): number {
  logActivity({
    type: 'world_event',
    templateData: { description: `${STRANGER_LEAVES.name}: ${STRANGER_LEAVES.description}` },
  });
  const residents = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all();
  for (const r of residents) {
    simEvents.emit('event:world', { agentId: r.id, name: STRANGER_LEAVES.name, description: STRANGER_LEAVES.description });
  }

  let settled = 0;
  const open = db.select().from(goals).where(and(eq(goals.status, 'active'))).all();
  for (const goal of open) {
    const text = `${goal.description ?? ''} ${goal.strategy ?? ''}`;
    if (STRANGER_GOAL.test(text) && completeGoal(goal, nowMinutes)) settled++;
  }
  return settled;
}
