/**
 * Did the server swap the whole world out between two `world.getState` reads?
 *
 * There is no world id to compare: `replaceWorld` wipes every table and reseeds
 * from scratch, so row ids (the world row's included) and agent ids start over,
 * and a TopBar Restart replays the saved config with the same resolved seed, so
 * the new `setup_config` is byte-identical to the old one. The one thing that
 * cannot happen inside a single world is the clock running backwards —
 * `totalTicks` only ever grows — so a drop is the replacement signal.
 *
 * Detecting it here, rather than only in the button that asked for it, is what
 * catches every entry point: Restart from another tab, `seed-world.ts`, and the
 * wizard's Start. `null` means "no world row yet" and never counts.
 */
export function isWorldReplaced(prevTotalTicks: number | null, nextTotalTicks: number | null): boolean {
  if (prevTotalTicks == null || nextTotalTicks == null) return false;
  return nextTotalTicks < prevTotalTicks;
}
