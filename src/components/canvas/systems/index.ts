import type { SystemFactory } from "./types";
import { createTownEventSystem } from "./townEvents/TownEventSystem";
import { createAmbientLifeSystem } from "./ambientLife/AmbientLifeSystem";
import { createHeldItemSystem } from "./held/HeldItemSystem";
import { createBeatSystem } from "./beats/BeatSystem";
import { createActivityFxSystem } from "./activityFx/ActivityFxSystem";

/**
 * Every pluggable canvas system, in update order. Add one line per feature — order
 * only matters when two systems draw into the same layer (later = on top).
 */
export const SYSTEM_FACTORIES: SystemFactory[] = [
  // Event decorations are set dressing: critters walk over them, beats play above both.
  createTownEventSystem,
  createAmbientLifeSystem,
  createHeldItemSystem,
  createActivityFxSystem,
  createBeatSystem,
];
