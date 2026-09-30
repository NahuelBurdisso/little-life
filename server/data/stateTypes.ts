/**
 * Every agent state the simulation can apply, as a plain list.
 *
 * Kept apart from `server/lib/states.ts` on purpose: that module imports `../db`, so the client
 * cannot touch it, yet the client needs to know the full set of states to style them (see
 * `src/lib/stateStyle.ts`, whose test fails when a state is added here without a look or an
 * explicit "no look"). `server/data/` is pure data and safe for both sides.
 */
export const STATE_TYPES = [
  'drunk',
  'hungover',
  'sick',
  'heartbroken',
  'angry',
  'stressed',
  'euphoric',
  'grieving',
  'infatuated',
  'lonely',
  'depressed',
  'confident',
  'jealous',
  'envious',
  'alcoholic',
  'in_debt',
  'arrested',
  // The adult layer's aftermath (lib/intimacy): the warmth of a night together,
  // the weight of having betrayed someone, and the itch of suspecting it.
  'afterglow',
  'guilty',
  'suspicious',
] as const;

export type StateType = (typeof STATE_TYPES)[number];
