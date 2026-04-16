export { generateWorld } from './pipeline';
export {
  WorldGenConfigSchema,
  WorldGenConfigObjectSchema,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT,
} from './config';
export type { WorldGenConfig } from './config';
// FitError is a class (both a value AND a type). Export it as a value so
// downstream `instanceof FitError` checks work.
export { FitError } from './types';
export type { GenResult, GenerateOptions, Stage, WorldContext, StageExtras, TerrainTile, InteriorData } from './types';
