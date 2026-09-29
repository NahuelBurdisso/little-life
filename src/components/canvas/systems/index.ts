import type { SystemFactory } from "./types";
import { createHeldItemSystem } from "./held/HeldItemSystem";
import { createBeatSystem } from "./beats/BeatSystem";

/**
 * Every pluggable canvas system, in update order. Add one line per feature — order
 * only matters when two systems draw into the same layer (later = on top).
 */
export const SYSTEM_FACTORIES: SystemFactory[] = [
  createHeldItemSystem,
  createBeatSystem,
];
