/**
 * What the canvas keeps out of sight while a couple's private evening (`zoneActivity: 'tryst'`)
 * is under way. Pure -- no PixiJS -- so BuildingRenderer and SpritePool only apply the answer.
 *
 * A building normally cuts its roof away while anyone is inside, which shows the residents
 * indoors. During a tryst that would put the couple on display, so the building keeps its roof ON
 * (everything the town is meant to notice sits on the exterior: the lamp turned down, drawn
 * curtains, a heart rising off the roofline) and, because agent sprites are drawn above the
 * buildings, the sprites inside are hidden too, or they would float over the closed roof. The
 * camera looks away; the act itself is off-stage.
 */
import { isPrivateEvening, type ActionLike } from './homeLight';

/** The slice of an agent this needs (structurally an `AgentData`). */
export interface DiscretionAgent {
  current_location?: number | null;
  current_action?: ActionLike;
}

/** Buildings that currently host a private evening: their roofs stay on and nobody shows inside. */
export function veiledBuildingIds(agents: Iterable<DiscretionAgent>): Set<number> {
  const ids = new Set<number>();
  for (const a of agents) {
    if (a.current_location != null && isPrivateEvening(a.current_action)) ids.add(a.current_location);
  }
  return ids;
}

/**
 * Whether this agent's sprite is hidden: the couple themselves (wherever it is, a barn or a grove
 * has no roof to keep on, so the sprite is what goes), and anyone else inside a veiled building.
 * The dawn walk home (`sneak_home`) is deliberately not veiled: they are on the road, and being
 * seen there is what the town can gossip about.
 */
export function isVeiled(agent: DiscretionAgent, veiled: ReadonlySet<number>): boolean {
  if (isPrivateEvening(agent.current_action)) return true;
  return agent.current_location != null && veiled.has(agent.current_location);
}

/**
 * Whether a building's roof is cut away (and its interior shown): while hovered or while anyone
 * is inside, except a veiled building, which stays closed even under the cursor.
 */
export function roofCutAway(hovered: boolean, occupied: boolean, veiled: boolean): boolean {
  return !veiled && (hovered || occupied);
}

/** A sprite as the hit test sees it: where it stands and whether it is off camera. */
export interface HitCandidate {
  id: string;
  x: number;
  y: number;
  veiled: boolean;
}

/**
 * The agent nearest a world-pixel point within `radius`, or null. A veiled sprite is never a
 * hit: hiding the container only removes it from the picture, and the hit test is coordinate math
 * over the pool (not Pixi events), so without this check hovering the closed house would show a
 * tooltip, and clicking it select someone, at exactly the spot the town is meant not to see.
 * The cast bar still selects them.
 */
export function pickAgentAt(
  candidates: Iterable<HitCandidate>,
  worldX: number,
  worldY: number,
  radius: number,
): string | null {
  const radiusSq = radius * radius;
  let bestId: string | null = null;
  let bestDistSq = Infinity;
  for (const c of candidates) {
    if (c.veiled) continue;
    const dx = worldX - c.x;
    const dy = worldY - c.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < radiusSq && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestId = c.id;
    }
  }
  return bestId;
}
