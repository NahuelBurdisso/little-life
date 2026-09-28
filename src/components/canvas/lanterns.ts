import { OUTDOOR_TYPES } from '../../../server/lib/worldgen/buildingTemplates';

/**
 * Does an agent standing in a location of this type carry a night lantern?
 *
 * Only agents out in the open do. One inside a building is drawn in the
 * interior and already lit by the building's own light, so a lantern there was
 * a second warm blob inside the walls — on every sleeper at home, all night.
 *
 * `OUTDOOR_TYPES`, not `!OPEN_AREA_TYPES`: the derived locations (alley,
 * mainstreet, market square, farmyard) are open ground but absent from
 * OPEN_AREA_TYPES, so the negated test would call them indoors
 * (see buildingTemplates.ts).
 *
 * @param locType `null` when the agent is in no location (on a road);
 *   `undefined` when its location isn't in the client's list — treated as
 *   indoors, since there is nothing to say otherwise.
 */
export function carriesLantern(locType: string | null | undefined): boolean {
  if (locType === null) return true;
  if (locType === undefined) return false;
  return OUTDOOR_TYPES.has(locType);
}
