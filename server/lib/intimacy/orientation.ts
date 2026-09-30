import type { RNG } from '../worldgen/rng';
import type { Orientation } from './eligibility';

/** Romance above this toward someone marks a real crush that the orientation must not contradict. */
export const SEEDED_CRUSH_THRESHOLD = 30;

/** Free roll odds for someone with no seeded same-gender feeling: 88 / 7 / 5. */
const P_STRAIGHT = 0.88;
const P_BI = 0.07; // gay is the remaining 0.05

/**
 * One free roll, for a newcomer or an agent with nothing seeded to respect.
 * Always consumes exactly one `rng.next()` so callers stay in step.
 */
export function rollOrientation(rng: RNG): Orientation {
  const u = rng.next();
  if (u < P_STRAIGHT) return 'straight';
  if (u < P_STRAIGHT + P_BI) return 'bi';
  return 'gay';
}

export interface OrientationRelationship {
  agent_a: number;
  agent_b: number;
  romance_ab: number;
  romance_ba: number;
}

/**
 * Orientation for a whole town, deterministic for a given rng state.
 *
 * Seeded romance is honoured first: a scenario that pairs two men has already
 * made them each other's crush, and rolling one of them "straight" afterwards
 * would leave the eligibility gate refusing a love story the town was built
 * around. Every target above `SEEDED_CRUSH_THRESHOLD` counts, whatever its
 * gender: all the same gender as the agent -> `gay`; a mix -> `bi`; all the
 * other gender -> the free roll, except that a rolled `gay` becomes `bi` (a man
 * seeded in love with a woman must not roll out of it). No targets at all rolls
 * a free 88/7/5.
 *
 * Agents are visited in id order and each draws exactly one roll whether or not
 * a crush pins them, so the result does not depend on the order the caller
 * passes rows in, nor on who happens to be pinned. Relationships that point at
 * an agent outside `agents` are ignored (their gender is unknown).
 */
export function assignOrientations(
  agents: ReadonlyArray<{ id: number; gender: string }>,
  relationships: ReadonlyArray<OrientationRelationship>,
  rng: RNG,
): Map<number, Orientation> {
  const genderOf = new Map(agents.map((a) => [a.id, a.gender]));

  // targets.get(id) = genders of everyone `id` feels more than a crush for.
  const targets = new Map<number, string[]>();
  const note = (who: number, whom: number, romance: number) => {
    const g = genderOf.get(whom);
    if (g === undefined || romance <= SEEDED_CRUSH_THRESHOLD) return;
    const list = targets.get(who);
    if (list) list.push(g);
    else targets.set(who, [g]);
  };
  for (const r of relationships) {
    note(r.agent_a, r.agent_b, r.romance_ab);
    note(r.agent_b, r.agent_a, r.romance_ba);
  }

  const out = new Map<number, Orientation>();
  for (const agent of [...agents].sort((x, y) => x.id - y.id)) {
    const rolled = rollOrientation(rng);
    const liked = targets.get(agent.id) ?? [];
    const sameGender = liked.filter((g) => g === agent.gender).length;
    if (liked.length === 0) out.set(agent.id, rolled);
    // Only ever drawn to the other gender: `gay` would make the eligibility gate
    // refuse the very romance the scenario seeded. Straight and bi both allow it.
    else if (sameGender === 0) out.set(agent.id, rolled === 'gay' ? 'bi' : rolled);
    else out.set(agent.id, sameGender === liked.length ? 'gay' : 'bi');
  }
  return out;
}
