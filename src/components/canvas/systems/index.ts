import type { SystemFactory } from "./types";
import { createTownEventSystem } from "./townEvents/TownEventSystem";
import { createAmbientLifeSystem } from "./ambientLife/AmbientLifeSystem";
import { createHeldItemSystem } from "./held/HeldItemSystem";
import { createBeatSystem } from "./beats/BeatSystem";
import { createPlaceLifeSystem } from "./placeLife/PlaceLifeSystem";

/**
 * Every pluggable canvas system, in update order. Add one line per feature — order
 * only matters when two systems draw into the same layer (later = on top).
 */
export const SYSTEM_FACTORIES: SystemFactory[] = [
  // Event decorations are set dressing: critters walk over them, beats play above both.
  createTownEventSystem,
  createPlaceLifeSystem,
  createAmbientLifeSystem,
  createHeldItemSystem,
  createBeatSystem,
];
