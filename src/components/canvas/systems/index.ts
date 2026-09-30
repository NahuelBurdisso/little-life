import type { SystemFactory } from "./types";
import { createTownEventSystem } from "./townEvents/TownEventSystem";
import { createSkyFxSystem } from "./skyFx/SkyFxSystem";
import { createAmbientLifeSystem } from "./ambientLife/AmbientLifeSystem";
import { createHeldItemSystem } from "./held/HeldItemSystem";
import { createBeatSystem } from "./beats/BeatSystem";
import { createTalkSystem } from "./talk/TalkSystem";
import { createPlayerFxSystem } from "./playerFx/PlayerFxSystem";
import { createActivityFxSystem } from "./activityFx/ActivityFxSystem";
import { createPlaceLifeSystem } from "./placeLife/PlaceLifeSystem";
import { createFuseSystem } from "./fuse/FuseSystem";
import { createAudioSystem } from "./audio/AudioSystem";
import { createCoupleSystem } from "./couples/CoupleSystem";
import { createCurtainSystem } from "./curtains/CurtainSystem";

/**
 * Every pluggable canvas system, in update order. Add one line per feature — order
 * only matters when two systems draw into the same layer (later = on top).
 */
export const SYSTEM_FACTORIES: SystemFactory[] = [
  // Event decorations are set dressing: critters walk over them, beats play above both.
  createTownEventSystem,
  createSkyFxSystem,
  createPlaceLifeSystem,
  createAmbientLifeSystem,
  createHeldItemSystem,
  createActivityFxSystem,
  // Who is talking to whom: the tinted line and the message dot sit under the story beats, which
  // should never be hidden behind a chat line (bubbles are drawn above every system layer anyway).
  createTalkSystem,
  createBeatSystem,
  // A warning, not a scene: the lit fuse over a resident about to snap.
  createFuseSystem,
  // Married, engaged and courting pairs walk close and hold hands; the smitten steal glances.
  createCoupleSystem,
  // A house hosting a private evening draws its curtains (the lamp turned down is LightingSystem's).
  createCurtainSystem,
  // The player's own actions draw last: they should never be hidden under a story beat.
  createPlayerFxSystem,
  // Draws nothing: the soundscape (weather, places near the camera, story cues, thunder).
  createAudioSystem,
];
