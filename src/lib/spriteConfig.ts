export const SPRITE_CONFIG = {
  TILE_SIZE: 32,              // Visual tile size — used throughout coordinate system. UNCHANGED.
  NATIVE_TILE: 16,            // Actual pixel art tile size (for slicing sprite sheets only)
  SPRITE_SCALE: 2,            // Render 16px art at 2x to fill 32px visual tiles
  AGENT_WIDTH: 16,            // Native character sprite width
  AGENT_HEIGHT: 32,           // Native character sprite height (1 tile wide, 2 tiles tall)
  AGENT_SIZE: 32,             // DEPRECATED — kept for backward compat, equals TILE_SIZE
  PORTRAIT_SIZE: 64,
  WALK_FRAMES: 6,             // LimeZu uses 6 frames per direction
  WALK_SPEED: 0.12,           // Slightly slower for 6-frame cycles
  DIRECTIONS: { down: 0, up: 1, left: 2, right: 3 } as Record<string, number>,
  CHARACTER_BASES: ["adam", "alex", "amelia", "bob"] as const,
  HUE_SHIFTS: [0, 40, 80],   // 3 palette variants per base = 12 agents
};

/** Get path to a character's animation sprite sheet */
export function getCharacterSheet(base: string, animation?: string): string {
  if (!animation || animation === "walk") return `/sprites/characters/${base}.png`;
  return `/sprites/characters/${base}-${animation}.png`;
}

/** Assign a character base and hue shift from a stable agent index */
export function getCharacterAssignment(agentIndex: number): { base: string; hueShift: number } {
  const bases = SPRITE_CONFIG.CHARACTER_BASES;
  const base = bases[agentIndex % bases.length];
  const hueShift = SPRITE_CONFIG.HUE_SHIFTS[Math.floor(agentIndex / bases.length) % SPRITE_CONFIG.HUE_SHIFTS.length];
  return { base, hueShift };
}

// Legacy — kept so existing refs don't break during migration
export function getAgentSpriteSheet(index: number): string {
  const { base } = getCharacterAssignment(index);
  return getCharacterSheet(base, "walk");
}
export function getAgentPortrait(index: number): string {
  const { base } = getCharacterAssignment(index);
  return getCharacterSheet(base, "idle");
}
