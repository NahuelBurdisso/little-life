export const SPRITE_CONFIG = {
  TILE_SIZE: 32,
  AGENT_SIZE: 32,
  PORTRAIT_SIZE: 64,
  WALK_FRAMES: 4,
  WALK_SPEED: 0.15,
  DIRECTIONS: { down: 0, left: 1, right: 2, up: 3 } as Record<string, number>,
};

export function getAgentSpriteSheet(index: number): string {
  return `/sprites/agents/agent-${String(index + 1).padStart(2, "0")}.png`;
}

export function getAgentPortrait(index: number): string {
  return `/sprites/portraits/portrait-${String(index + 1).padStart(2, "0")}.png`;
}
