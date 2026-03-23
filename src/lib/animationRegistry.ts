export interface AnimationDef {
  /** File path suffix — "{base}" replaced with character name */
  file: string;
  frameWidth: number;
  frameHeight: number;
  /** true = frames laid out as N directions × framesPerDir */
  directional: boolean;
  framesPerDirection: number;
  totalFrames: number;
  /** For multi-row sheets, which row to read (0-indexed). Undefined = row 0 */
  row?: number;
  /** Animation speed multiplier (lower = slower) */
  speed: number;
}

export const ANIMATIONS: Record<string, AnimationDef> = {
  walk: {
    file: "{base}",
    frameWidth: 16, frameHeight: 32,
    directional: true, framesPerDirection: 6, totalFrames: 24,
    row: 2,   // Row 2 of the main 384×224 sheet (y offset = 64)
    speed: 0.12,
  },
  run: {
    file: "{base}-run",
    frameWidth: 16, frameHeight: 32,
    directional: true, framesPerDirection: 6, totalFrames: 24,
    speed: 0.16,
  },
  idle: {
    file: "{base}-idle",
    frameWidth: 16, frameHeight: 32,
    directional: true, framesPerDirection: 1, totalFrames: 4,
    speed: 0,  // static, no animation
  },
  idleAnim: {
    file: "{base}-idle-anim",
    frameWidth: 16, frameHeight: 32,
    directional: true, framesPerDirection: 6, totalFrames: 24,
    speed: 0.06,  // slow breathing
  },
  phone: {
    file: "{base}-phone",
    frameWidth: 16, frameHeight: 32,
    directional: false, framesPerDirection: 0, totalFrames: 9,
    speed: 0.08,
  },
  sit: {
    file: "{base}-sit",
    frameWidth: 16, frameHeight: 32,
    directional: true, framesPerDirection: 6, totalFrames: 24,
    speed: 0.06,
  },
};

/** Map agent action types to animation names */
export function actionToAnimation(actionType: string | undefined): string {
  switch (actionType) {
    case "walking":
    case "going_to":
      return "walk";
    case "running":
      return "run";
    case "working":
      return "idleAnim";
    case "eating":
    case "relaxing":
      return "sit";
    case "socializing":
    case "talking":
      return "phone";
    case "sleeping":
      return "idle";
    default:
      return "idleAnim";
  }
}
