/**
 * Who exists, for rejecting LLM text that names someone who doesn't
 * (ai/names.ts inventedPeople). Every resident ever (the dead and departed are
 * still talked about), their children, and place names ("the Mill Road boy"
 * is a place word, not a person). Small tables, read on each call: the
 * callers (goal review, pivots, conversation takeaways, reflections) run a
 * handful of times per game hour.
 */

import { db } from '../db';
import { agents, children, locations } from '../db/schema';
import { inventedPeople, nameWords } from '../ai/names';

export function knownNameWords(): Set<string> {
  return nameWords([
    ...db.select({ name: agents.name }).from(agents).all().map((r) => r.name),
    ...db.select({ name: children.name }).from(children).all().map((r) => r.name),
    ...db.select({ name: locations.name }).from(locations).all().map((r) => r.name),
  ]);
}

/** Whether any of these texts names a person who is not in town. */
export function mentionsInventedPerson(...texts: Array<string | null | undefined>): boolean {
  const joined = texts.filter(Boolean).join(' ');
  if (!joined) return false;
  return inventedPeople(joined, knownNameWords()).length > 0;
}
