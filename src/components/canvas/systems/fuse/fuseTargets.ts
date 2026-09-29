/**
 * Which residents carry a lit fuse. Split from the renderer so the rule is one
 * testable line: only *snap* rows, and only from 85% of the resident's snap
 * threshold. The Brewing tab starts listing them at 70% -- the fuse is the
 * louder second warning, so a busy map is not sprinkled with bombs.
 */
export const FUSE_HEAT = 0.85;

interface BrewingLike {
  kind: string;
  agentIds: number[];
  heat: number;
}

/** Refills `out` (cleared first) with the ids to show a fuse over, and returns it. */
export function fuseTargets(brewing: readonly BrewingLike[] | undefined, out: Set<number>): Set<number> {
  out.clear();
  if (!brewing) return out;
  for (const item of brewing) {
    // For a snap row, `heat` is the ratio to the snap threshold (server/lib/brewing.ts).
    if (item.kind === 'snap' && item.heat >= FUSE_HEAT && item.agentIds.length > 0) {
      out.add(item.agentIds[0]);
    }
  }
  return out;
}
