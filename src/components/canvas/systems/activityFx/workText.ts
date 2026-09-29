/**
 * What "daily work" actually is, per workplace: the server stamps every shift with the same
 * `taskDescription: 'daily work'`, which made the thought bubble say the same thing over the
 * anvil and the counter. Pure, so the table can be tested.
 */
const WORK_TEXT: Record<string, readonly string[]> = {
  bakery: ['kneading the morning dough', 'watching the oven', 'shaping loaves'],
  workshop: ['hammering at the forge', 'shaping hot iron', 'fixing a broken tool'],
  shop: ['minding the counter', 'counting the till', 'restocking the shelves'],
  pawnshop: ['appraising a pocket watch', 'haggling over a ring', 'minding the counter'],
  town_hall: ['signing papers', 'sorting the town records', 'drafting a notice'],
  clinic: ['seeing patients', 'mixing a remedy', 'writing up a chart'],
  tavern: ['pulling pints', 'wiping down the bar', 'stacking mugs'],
  divebar: ['pouring another round', 'wiping down the bar', 'breaking up a squabble'],
  farm: ['tending the crops', 'hoeing the rows', 'checking the fences'],
  prison: ['walking the cells', 'checking the locks', 'keeping watch'],
};

export const GENERIC_WORK = 'daily work';

/** A description for a shift at `workplaceType`, or null when the place has none. `pick` varies it per agent. */
export function workDescription(workplaceType: string | null | undefined, pick = 0): string | null {
  const lines = workplaceType ? WORK_TEXT[workplaceType] : undefined;
  if (!lines) return null;
  return lines[Math.abs(Math.floor(pick)) % lines.length];
}

/**
 * The thought to show for an action's `taskDescription`: the generic "daily work" becomes the
 * workplace's own line; anything else the server wrote is kept.
 */
export function taskThought(
  taskDescription: string | undefined,
  agent: { id: number; workplace?: number | null },
  locations: ReadonlyArray<{ id: number; type: string }> | undefined,
): string | undefined {
  if (taskDescription !== GENERIC_WORK || agent.workplace == null || !locations) return taskDescription;
  const type = locations.find(l => l.id === agent.workplace)?.type;
  return workDescription(type, agent.id) ?? taskDescription;
}
