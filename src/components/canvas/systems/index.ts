import type { SystemFactory } from "./types";
import { createAmbientLifeSystem } from "./ambientLife/AmbientLifeSystem";

/**
 * Every pluggable canvas system, in update order. Add one line per feature — order
 * only matters when two systems draw into the same layer (later = on top).
 */
export const SYSTEM_FACTORIES: SystemFactory[] = [
  createAmbientLifeSystem,
];
