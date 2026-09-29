import type * as PIXI from "pixi.js";
import { SHEET_FRAME_COUNT, SHEET_FRAME_SIZE } from "./agentFrames";
import { loadStrip } from "./stripAtlas";

/**
 * Frames of `/sprites/agents/<key>_sheet.png`. All sprites of the same agent (a world
 * reload rebuilds the pool) share one load.
 */
export function loadAgentSheet(spriteKey: string): Promise<PIXI.Texture[]> {
  return loadStrip(`/sprites/agents/${spriteKey}_sheet.png`, SHEET_FRAME_COUNT, SHEET_FRAME_SIZE);
}
