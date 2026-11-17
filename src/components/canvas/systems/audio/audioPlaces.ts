import type { PlaceSound } from "../../../../lib/audio/soundscape";
import type { PlaceState } from "../placeLife/placeState";
import { furnitureSpot } from "../placeLife/zoneGeometry";
import type { LocationLite } from '../../../../lib/apiTypes';

/**
 * Which buildings are making noise, and from where — the audio side of place life.
 *
 * Reads the same per-place records the visual place-life system uses (`computePlaceStates`),
 * so a forge that glows is a forge that rings and a tavern with music notes over its door is
 * the one you hear playing. Anchors match what is drawn: the anvil for the forge, the door
 * for pub noise (what leaks out of a building leaks out of its door), the middle of an open
 * square. Pure: no PixiJS (placeAnchors pulls BuildingRenderer in, so the door is inlined).
 */

/** Same bar as the visual crowd puffs (placePlan CROWD_MIN): three patrons make a room. */
const CROWD_MIN = 3;
/** Patrons at which the murmur is as full as it gets. */
const CROWD_FULL = 8;
/** An open square fills slower: people spread out and the air takes the sound. */
const SQUARE_FULL = 10;
const OPEN_CROWD_TYPES: ReadonlySet<string> = new Set(['town_square', 'park']);

export function buildAudioPlaces(locations: LocationLite[], states: PlaceState[], night: boolean): PlaceSound[] {
  const out: PlaceSound[] = [];
  const byId = new Map<number, LocationLite>();
  for (const l of locations) if (l?.id != null) byId.set(l.id, l);
  for (const st of states) {
    const loc = byId.get(st.id);
    const pos = loc?.position;
    if (!loc || !pos?.width) continue;
    const cx = pos.x + pos.width / 2;
    const cy = pos.y + pos.height / 2;
    switch (st.type) {
      case 'workshop': {
        if (st.working === 0) break;
        const anvil = furnitureSpot(loc, 'forge') ?? { x: cx, y: cy };
        out.push({ kind: 'forge', x: anvil.x, y: anvil.y, busy: Math.min(1, 0.6 + 0.2 * st.working) });
        break;
      }
      case 'tavern':
      case 'divebar': {
        const door = loc.entry_point ? { x: loc.entry_point.x, y: loc.entry_point.y - 8 } : { x: cx, y: cy };
        if (st.awake >= CROWD_MIN) out.push({ kind: 'crowd', x: door.x, y: door.y, busy: Math.min(1, st.awake / CROWD_FULL) });
        // Music: someone on the stage, or a full house late at night (someone always has a lute).
        // Only the tavern has a stage; the dive bar is all talk.
        if (st.type === 'tavern' && (st.performing > 0 || (night && st.awake >= 5))) {
          out.push({ kind: 'tavern', x: door.x, y: door.y, busy: st.performing > 0 ? 1 : 0.55 });
        }
        break;
      }
      default:
        if (OPEN_CROWD_TYPES.has(st.type) && st.awake >= CROWD_MIN) {
          out.push({ kind: 'crowd', x: cx, y: cy, busy: Math.min(1, st.awake / SQUARE_FULL) });
        }
    }
  }
  return out;
}
