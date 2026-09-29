import { db } from '../../db';
import { agents, locations } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '../../lib/activityLogger';
import { CONFIG } from '../../lib/constants';
import { gameMinutes } from '../../lib/gameClock';
import { distance } from '../../lib/utils';
import { computeAStarPath } from '../../lib/pathfinding';
import { emitter } from '../emitter';
import { getAgentStates } from '../../lib/states';
import { simEvents } from '../../lib/simEvents';
import { getInteriorGrid, zoneOccupancy, occupancyKey, getOpenAreaTerrainCosts } from '../../lib/interiorGrid';
import { INTERIOR_ZONES } from '../../data/interiors';
import { executeZoneAction } from './zoneActions';
import { ENCLOSED_BUILDING_TYPES } from '../../lib/worldgen/buildingTemplates';

// --- Types ---

type AgentRow = typeof agents.$inferSelect;
type LocationRow = typeof locations.$inferSelect;
type WorldRow = {
  time: { day: number; hour: number; minute: number; totalTicks: number; seasonDay: number; season: string };
  tick_speed: number;
  collision_grid: string;
  map_width: number;
  map_height: number;
};

// Stuck detection: track positions for walking agents
const stuckTracker = new Map<number, { x: number; y: number; minutes: number }>();

// Cached terrain cost map — rebuilt when season changes
let cachedCostMap: Float32Array | null = null;
let cachedSeason: string = '';
/** Bumped by invalidateCostMap(); the cache is only valid for the current value. */
let costMapGeneration = 0;
let cachedGeneration = -1;

/** Drop the cached cost map. Must be called whenever the world is replaced. */
export function invalidateCostMap(): void {
  cachedCostMap = null;
  cachedSeason = '';
  costMapGeneration++;
}

/**
 * Drop per-agent movement bookkeeping. Must be called whenever the world is
 * replaced: agent ids restart at 1 (SQLite reuses rowids after a DELETE), so a
 * stale stuck-tracker entry would be charged to the new agent that inherited
 * the id.
 */
export function clearMovementState(): void {
  stuckTracker.clear();
}

function getWorldCostMap(world: WorldRow, allLocations: LocationRow[]): Float32Array {
  const season = world.time.season;
  // This is called several times per agent per tick, so the cache key has to be
  // cheaper than the lookup it guards — joining ~50 location ids into a string
  // was not. A generation counter plus a length check covers the original bug
  // (a map built for a differently-sized world was read out of range, feeding
  // `undefined` into the A* cost arithmetic).
  if (
    cachedCostMap &&
    cachedSeason === season &&
    cachedGeneration === costMapGeneration &&
    cachedCostMap.length === world.map_width * world.map_height
  ) {
    return cachedCostMap;
  }

  const map = new Float32Array(world.map_width * world.map_height).fill(1.0);
  const openAreas = allLocations.filter(l => ['farm', 'park', 'town_square'].includes(l.type));
  const entries = getOpenAreaTerrainCosts(season, openAreas, CONFIG.MOVEMENT.TILE_SIZE);
  for (const entry of entries) {
    const idx = entry.tileY * world.map_width + entry.tileX;
    if (idx >= 0 && idx < map.length) {
      map[idx] = entry.cost;
    }
  }
  cachedCostMap = map;
  cachedSeason = season;
  cachedGeneration = costMapGeneration;
  return map;
}

// --- Helpers ---

function advanceAlongPath(
  current: { x: number; y: number },
  path: number[][],
  totalDistance: number,
): { position: { x: number; y: number }; remainingPath: number[][] } {
  let pos = { x: current.x, y: current.y };
  let remaining = totalDistance;
  let pathIndex = 0;

  while (remaining > 0 && pathIndex < path.length) {
    const waypoint = { x: path[pathIndex][0], y: path[pathIndex][1] };
    const dist = distance(pos, waypoint);

    if (dist <= remaining) {
      pos = waypoint;
      remaining -= dist;
      pathIndex++;
    } else {
      const ratio = remaining / dist;
      pos = {
        x: pos.x + (waypoint.x - pos.x) * ratio,
        y: pos.y + (waypoint.y - pos.y) * ratio,
      };
      remaining = 0;
    }
  }

  return {
    position: pos,
    remainingPath: path.slice(pathIndex),
  };
}

function isInsideLocation(
  pos: { x: number; y: number },
  loc: { position: { x: number; y: number; width: number; height: number } },
): boolean {
  const buf = 16;
  return (
    pos.x >= loc.position.x - buf &&
    pos.x <= loc.position.x + loc.position.width + buf &&
    pos.y >= loc.position.y - buf &&
    pos.y <= loc.position.y + loc.position.height + buf
  );
}

function findContainingLocation(
  pos: { x: number; y: number },
  locs: LocationRow[],
): number | null {
  for (const loc of locs) {
    if (isInsideLocation(pos, loc)) {
      return loc.id;
    }
  }
  return null;
}

function getMinDuration(actionType: string): number {
  return CONFIG.DECISIONS.ACTION_MIN_DURATIONS[actionType] ?? 10;
}

/**
 * Action duration for an arrival that plays the 5-tick interior lerp first.
 *
 * Durations are game minutes (see isActionComplete in decisions.ts), but the
 * lerp in tick() advances one step per TICK, so the padding is worth
 * 5 × tick_speed game minutes. Rounded up: at 0.5x that is 2.5, and
 * `action_duration` is an INTEGER column compared against whole game minutes —
 * rounding down would cut the lerp short by a tick.
 */
export function interiorTransitionDuration(minDuration: number, tickSpeed: number): number | null {
  return minDuration > 0 ? minDuration + Math.ceil(5 * tickSpeed) : null;
}

/**
 * The enclosed building whose footprint contains `pt`, if any.
 *
 * Geometric on purpose, not `agent.current_location`: that comes from
 * `findContainingLocation`, which pads every rectangle by 16 px and returns the
 * first hit, so an agent on a doorstep can read as "inside" the neighbour and an
 * agent at a counter can read as standing in the derived street strip that
 * overlaps it. What a route has to know is which grid the point is on — the
 * world grid blocks every enclosed footprint wholesale — and only the footprint
 * answers that. The entry_point sits exactly on the footprint's bottom edge, so
 * the strict `<` keeps doorsteps outside.
 *
 * Positive membership in ENCLOSED_BUILDING_TYPES, not `!OPEN_AREA_TYPES.has(...)`:
 * the derived locations (mainstreet, alley, farmyard, market_square) are open
 * ground with no template, and the negated test once routed everyone on Main
 * Street via the strip's midpoint.
 */
export function enclosingBuilding<L extends Pick<LocationRow, 'type' | 'position'>>(
  pt: { x: number; y: number },
  locs: readonly L[],
): L | null {
  for (const loc of locs) {
    if (!ENCLOSED_BUILDING_TYPES.has(loc.type)) continue;
    const p = loc.position;
    if (pt.x >= p.x && pt.x < p.x + p.width && pt.y >= p.y && pt.y < p.y + p.height) return loc;
  }
  return null;
}

type RouteLocation = Pick<LocationRow, 'id' | 'type' | 'position' | 'entry_point'>;
type RouteWorld = Pick<WorldRow, 'collision_grid' | 'map_width' | 'map_height'>;

/**
 * Walk inside one building on its interior grid, `from` and `to` in world pixels.
 * A building type without a grid (none today) gets the straight step it always had.
 */
function interiorLeg(
  building: RouteLocation,
  from: { x: number; y: number },
  to: { x: number; y: number },
): number[][] {
  const grid = getInteriorGrid(building.type);
  if (!grid) return [[to.x, to.y]];
  const bx = building.position.x;
  const by = building.position.y;
  const leg = computeAStarPath(
    { x: from.x - bx, y: from.y - by },
    { x: to.x - bx, y: to.y - by },
    grid.collisionString, grid.width, grid.height,
    CONFIG.MOVEMENT.TILE_SIZE, undefined, building.type,
  );
  return leg.map(([px, py]) => [px + bx, py + by]);
}

/** Centre of a building's interior door cell, in world pixels. */
function doorCellPixel(building: RouteLocation): { x: number; y: number } {
  const grid = getInteriorGrid(building.type);
  const T = CONFIG.MOVEMENT.TILE_SIZE;
  if (!grid) return { x: building.entry_point.x, y: building.entry_point.y - T / 2 };
  return {
    x: building.position.x + grid.doorTile[0] * T + T / 2,
    y: building.position.y + grid.doorTile[1] * T + T / 2,
  };
}

/**
 * The full route from `from` to `to`, as world-pixel waypoints, in up to three
 * legs: out of the enclosed building `from` is in (interior grid, to its door
 * and out onto the entry_point), across town (world grid, entry_point to
 * entry_point), and into the enclosed building `to` is in (interior grid, from
 * its door). A point inside a building's footprint is only reachable through
 * that building's own grid — on the world grid every footprint tile is solid.
 *
 * This replaced a planner keyed on the walker's `current_location` alone, which
 * never handled a destination inside a building (a conversation partner at the
 * clinic's reception, a hop to a zone): those went to world A*, found the
 * destination tile solid, and walked a straight line through every building in
 * between — P1's "destination tile unroutable at work spots".
 */
export function planRoute(
  from: { x: number; y: number },
  to: { x: number; y: number },
  world: RouteWorld,
  allLocations: readonly RouteLocation[],
  costMap?: Float32Array,
): number[][] {
  const src = enclosingBuilding(from, allLocations);
  const dst = enclosingBuilding(to, allLocations);
  if (src && dst && src.id === dst.id) return interiorLeg(src, from, to);

  const path: number[][] = [];
  let cursor = from;
  if (src) {
    path.push(...interiorLeg(src, from, doorCellPixel(src)));
    path.push([src.entry_point.x, src.entry_point.y]);
    cursor = src.entry_point;
  }
  const outside = dst ? dst.entry_point : to;
  path.push(...computeAStarPath(
    cursor, outside,
    world.collision_grid, world.map_width, world.map_height,
    CONFIG.MOVEMENT.TILE_SIZE, costMap,
  ));
  if (dst) {
    const door = doorCellPixel(dst);
    path.push([door.x, door.y]);
    path.push(...interiorLeg(dst, door, to));
  }
  return path;
}

/**
 * Compute an interior A* path from a relative pixel start to a zone center,
 * then convert all waypoints back to world coordinates.
 */
function computeInteriorPath(
  relStartX: number,
  relStartY: number,
  targetZoneCenter: [number, number],
  interiorGrid: { collisionString: string; width: number; height: number },
  buildingPosX: number,
  buildingPosY: number,
  buildingType: string,
): number[][] | null {
  const TILE_SIZE = CONFIG.MOVEMENT.TILE_SIZE;
  const [zoneGridX, zoneGridY] = targetZoneCenter;
  const relEndX = zoneGridX * TILE_SIZE + TILE_SIZE / 2;
  const relEndY = zoneGridY * TILE_SIZE + TILE_SIZE / 2;

  const interiorPath = computeAStarPath(
    { x: relStartX, y: relStartY },
    { x: relEndX, y: relEndY },
    interiorGrid.collisionString,
    interiorGrid.width,
    interiorGrid.height,
    TILE_SIZE,
    undefined,
    buildingType,
  );

  if (!interiorPath || interiorPath.length === 0) return null;

  // Convert interior-relative pixel coords to world coords
  return interiorPath.map(([px, py]) => [px + buildingPosX, py + buildingPosY]);
}



// --- Arrival Handler ---

function handleArrival(
  agent: AgentRow,
  world: WorldRow,
  allLocations: LocationRow[],
): void {
  // A walk over to talk to someone (conversations.ts staging) replaces whatever
  // walk the agent was on but leaves its `action_queue` alone. Popping that
  // queue here started the interrupted errand wherever the chat happened: a
  // baker caught on her way in worked a whole hour in the street — no bread,
  // the `working` action needs the workplace. Wait for the conversation instead;
  // the next decision re-plans the errand from where the agent now is.
  if ((agent.current_action as { reason?: string } | null)?.reason === 'approaching_conversation') {
    db.update(agents)
      .set({
        current_destination: null,
        current_path: null,
        current_action: { type: 'idle' },
        action_started: gameMinutes(world.time),
        action_duration: getMinDuration('idle'),
        action_queue: [],
      })
      .where(eq(agents.id, agent.id))
      .run();
    return;
  }

  const queue = [...agent.action_queue];
  const nextAction = queue.shift() ?? null;

  const actionType = (nextAction as any)?.type ?? 'idle';
  const minDuration = getMinDuration(actionType);

  // Two-phase interior movement: if the queued action carries zone coordinates,
  // the agent needs to move to the zone position inside the building.
  const zoneX = (nextAction as any)?.zoneX as number | undefined;
  const zoneY = (nextAction as any)?.zoneY as number | undefined;
  const targetZoneId = (nextAction as any)?.targetZone as string | undefined;
  const targetBuildingType = (nextAction as any)?.targetBuildingType as string | undefined;

  if (zoneX !== undefined && zoneY !== undefined) {
    // Try interior A* for non-home buildings with interior grids
    const interiorGrid = targetBuildingType ? getInteriorGrid(targetBuildingType) : null;

    if (interiorGrid && targetBuildingType) {
      // Find the building location to get its world position
      const building = agent.current_location != null
        ? allLocations.find(l => l.id === agent.current_location)
        : null;
      const buildingPos = building?.position;

      if (buildingPos) {
        // Agent is at the door (entry_point). Convert to interior-relative coords.
        const relStartX = agent.position.x - buildingPos.x;
        const relStartY = agent.position.y - buildingPos.y;

        // Find the target zone definition to get its grid-coord center
        const zones = INTERIOR_ZONES[targetBuildingType] ?? [];
        const targetZoneDef = targetZoneId
          ? zones.find(z => z.id === targetZoneId)
          : zones.find(z => z.allowedActions?.includes(actionType));

        if (targetZoneDef) {
          const interiorPath = computeInteriorPath(
            relStartX, relStartY,
            targetZoneDef.center,
            interiorGrid,
            buildingPos.x, buildingPos.y,
            targetBuildingType,
          );

          if (interiorPath && interiorPath.length > 0) {
            // Set the agent walking along the interior path to the zone.
            // The A* target is the bare zone center, which every occupant of a
            // multi-occupant zone shares; `zoneX/zoneY` is that same point plus
            // the agent's slot offset, so land on it instead of stacking.
            const finalWp: number[] = [zoneX, zoneY];
            interiorPath[interiorPath.length - 1] = finalWp;
            // Strip zone metadata from the action — it will be set as the queued action on inner arrival
            const { zoneX: _zx, zoneY: _zy, targetZone: _tz, targetBuildingType: _tb, ...cleanAction } = nextAction as any;
            const interiorAction = {
              ...cleanAction,
              _interiorArrivalZone: targetZoneDef.id,
              _interiorArrivalBuilding: targetBuildingType,
            };

            db.update(agents)
              .set({
                current_destination: { x: finalWp[0], y: finalWp[1] },
                current_path: interiorPath,
                current_action: { type: 'walking', to: { x: finalWp[0], y: finalWp[1] } },
                action_started: gameMinutes(world.time),
                action_duration: null,
                action_queue: [interiorAction],
              })
              .where(eq(agents.id, agent.id))
              .run();
            return;
          }
        }
      }
    }

    // Fallback for homes or buildings without interior grids:
    // Smooth interior transition (lerp over 5 ticks)
    const transitionAction = {
      ...(nextAction ?? { type: 'idle' }),
      _transitioning: true,
      _transitionTicks: 0,
      _fromX: agent.position.x,
      _fromY: agent.position.y,
      _toX: zoneX,
      _toY: zoneY,
    };
    db.update(agents)
      .set({
        current_destination: null,
        current_path: null,
        current_action: transitionAction,
        action_started: gameMinutes(world.time),
        action_duration: interiorTransitionDuration(minDuration, world.tick_speed),
        action_queue: queue,
      })
      .where(eq(agents.id, agent.id))
      .run();
  } else {
    // Check if this is an interior A* arrival (agent walked to zone center)
    const interiorZoneId = (nextAction as any)?._interiorArrivalZone as string | undefined;
    const interiorBuilding = (nextAction as any)?._interiorArrivalBuilding as string | undefined;
    if (interiorZoneId && interiorBuilding) {
      zoneOccupancy.enter(agent.id, occupancyKey(interiorBuilding, agent.current_location), interiorZoneId);
      // Strip interior metadata from the action
      const { _interiorArrivalZone, _interiorArrivalBuilding, ...cleanAction } = nextAction as any;
      const resolvedAction = cleanAction.type ? cleanAction : { type: 'idle' };
      // Execute zone-specific effects (need deltas, item production).
      // Keyed on the zone ACTIVITY ('fish', 'garden', ...), not the action type —
      // zone activities all ride on `type: 'idle'` with the intent in `zoneActivity`.
      executeZoneAction(resolvedAction.zoneActivity ?? resolvedAction.type, agent.id);
      db.update(agents)
        .set({
          current_destination: null,
          current_path: null,
          current_action: resolvedAction,
          action_started: gameMinutes(world.time),
          action_duration: minDuration > 0 ? minDuration : null,
          action_queue: queue,
        })
        .where(eq(agents.id, agent.id))
        .run();
    } else {
      db.update(agents)
        .set({
          current_destination: null,
          current_path: null,
          current_action: nextAction ?? { type: 'idle' },
          action_started: gameMinutes(world.time),
          action_duration: minDuration > 0 ? minDuration : null,
          action_queue: queue,
        })
        .where(eq(agents.id, agent.id))
        .run();
    }
  }
}

/**
 * A walker reached its destination: start the queued action (handleArrival) and
 * move the agent's location bookkeeping to the place the destination is in.
 */
function completeArrival(
  agent: AgentRow,
  destPoint: { x: number; y: number },
  world: WorldRow,
  allLocations: LocationRow[],
): void {
  handleArrival(agent, world, allLocations);

  // Handle zone transition on arrival
  const oldLocationId = agent.current_location;
  const newLocationId = findContainingLocation(destPoint, allLocations);

  // Emit arrival event when entering a new location
  if (newLocationId && newLocationId !== oldLocationId) {
    const arrivedLoc = allLocations.find((l) => l.id === newLocationId);
    if (arrivedLoc) {
      simEvents.emit('agent:arrived', { agentId: agent.id, locationName: arrivedLoc.name });
    }
  }

  // Emit departure event when leaving a location
  if (oldLocationId && newLocationId !== oldLocationId) {
    const departedLoc = allLocations.find((l) => l.id === oldLocationId);
    if (departedLoc) {
      simEvents.emit('agent:departed', { agentId: agent.id, locationName: departedLoc.name });
    }
  }

  if (oldLocationId !== newLocationId) {
    // Agent left a building — clear zone occupancy
    if (oldLocationId) {
      zoneOccupancy.leave(agent.id);

      const oldLoc = allLocations.find((l) => l.id === oldLocationId);
      if (oldLoc) {
        const updatedOccupants = oldLoc.current_occupants.filter((id) => id !== agent.id);
        db.update(locations)
          .set({ current_occupants: updatedOccupants })
          .where(eq(locations.id, oldLoc.id))
          .run();
        // Mirror change in local array so subsequent agents see fresh data
        oldLoc.current_occupants = updatedOccupants;
      }
    }
    if (newLocationId) {
      const newLoc = allLocations.find((l) => l.id === newLocationId);
      if (newLoc && !newLoc.current_occupants.includes(agent.id)) {
        const updatedOccupants = [...newLoc.current_occupants, agent.id];
        db.update(locations)
          .set({ current_occupants: updatedOccupants })
          .where(eq(locations.id, newLoc.id))
          .run();
        // Mirror change in local array so subsequent agents see fresh data
        newLoc.current_occupants = updatedOccupants;
      }
    }

    db.update(agents)
      .set({ current_location: newLocationId })
      .where(eq(agents.id, agent.id))
      .run();
  }
}

// --- Main Tick ---

export function tick(world: WorldRow): void {
  const activeAgents = db
    .select()
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();

  const allLocations = db.select().from(locations).all();

  let dirty = false;

  for (const agent of activeAgents) {
    // Handle smooth interior transitions
    const action = agent.current_action as any;
    if (action?._transitioning) {
      const ticks = (action._transitionTicks ?? 0) + 1;
      const t = Math.min(1, ticks / 5);
      const newX = action._fromX + (action._toX - action._fromX) * t;
      const newY = action._fromY + (action._toY - action._fromY) * t;

      if (t >= 1) {
        // Transition complete — remove transition metadata
        const { _transitioning, _transitionTicks, _fromX, _fromY, _toX, _toY, ...cleanAction } = action;
        // Execute zone-specific effects on transition completion
        const zoneKey = cleanAction.zoneActivity ?? cleanAction.type;
        if (zoneKey) {
          executeZoneAction(zoneKey, agent.id);
        }
        db.update(agents).set({
          position: { x: action._toX, y: action._toY },
          current_action: cleanAction,
        }).where(eq(agents.id, agent.id)).run();
      } else {
        db.update(agents).set({
          position: { x: newX, y: newY },
          current_action: { ...action, _transitionTicks: ticks },
        }).where(eq(agents.id, agent.id)).run();
      }
      dirty = true;
      continue;
    }

    if (agent.current_destination === null) continue;
    if ((agent.current_action as any)?.type !== 'walking') continue;

    // Stuck detection: if agent hasn't made 4px of progress in 30 game minutes,
    // force idle. Game minutes, not ticks: a walker covers `tick_speed` minutes of
    // ground per tick, so a 30-tick watchdog left a stuck agent frozen on screen
    // for two game hours at 4x.
    const prevPos = stuckTracker.get(agent.id);
    if (prevPos) {
      if (Math.abs(agent.position.x - prevPos.x) < 4 && Math.abs(agent.position.y - prevPos.y) < 4) {
        prevPos.minutes += world.tick_speed;
        if (prevPos.minutes >= 30) {
          db.update(agents).set({
            current_action: { type: 'idle' },
            current_destination: null,
            action_duration: 10,
            action_started: gameMinutes(world.time),
            current_path: null,
          }).where(eq(agents.id, agent.id)).run();
          stuckTracker.delete(agent.id);

          logActivity({
            type: 'state_gained',
            initiator: agent.id,
            templateData: { agent: agent.name, state: 'stuck' },
          });
          dirty = true;
          continue;
        }
      } else {
        stuckTracker.set(agent.id, { x: agent.position.x, y: agent.position.y, minutes: 0 });
      }
    } else {
      stuckTracker.set(agent.id, { x: agent.position.x, y: agent.position.y, minutes: 0 });
    }

    const dest = agent.current_destination;
    const destPoint = { x: dest.x, y: dest.y };
    const distToDest = distance(agent.position, destPoint);

    // Check arrival (a walker that reached the spot on an earlier tick, e.g.
    // one whose destination was set right on top of it).
    if (distToDest < CONFIG.MOVEMENT.ARRIVAL_THRESHOLD_PX) {
      completeArrival(agent, destPoint, world, allLocations);
      dirty = true;
      continue;
    }

    const agentStateTypes = getAgentStates(agent.id);
    let speedMultiplier = 1.0;
    if (agentStateTypes.includes('drunk')) speedMultiplier *= 0.7;
    if (agentStateTypes.includes('sick')) speedMultiplier *= 0.6;

    const moveDistance =
      CONFIG.MOVEMENT.PIXELS_PER_GAME_MINUTE * world.tick_speed * speedMultiplier;

    let position: { x: number; y: number };
    let remainingPath: number[][];

    {
      // Get or compute the route. Computed once per walk: the world collision
      // grid is fixed for a world's life (worldgen writes it, nothing edits it),
      // so a route cannot become blocked under a walker. The old per-tick
      // "next waypoint is on a blocked tile → recompute on the world grid" check
      // fired on every interior leg (interior waypoints sit on footprint tiles,
      // which the world grid marks solid) and replaced a correct indoor route
      // with a world-grid one to an in-building point: an unroutable destination
      // or, from inside a building, no route at all — both straight lines
      // through walls. It was most of P1's fallbacks.
      let path = agent.current_path;
      if (!path || path.length === 0) {
        path = planRoute(agent.position, destPoint, world, allLocations, getWorldCostMap(world, allLocations));
        if (path.length === 0) path = [[destPoint.x, destPoint.y]];
        db.update(agents)
          .set({ current_path: path })
          .where(eq(agents.id, agent.id))
          .run();
      }

      const result = advanceAlongPath(agent.position, path, moveDistance);
      position = result.position;
      remainingPath = result.remainingPath;
    }

    // Update location zones
    const oldLocationId = agent.current_location;
    const newLocationId = findContainingLocation(position, allLocations);

    const updates: Partial<typeof agents.$inferInsert> = {
      position,
      current_path: remainingPath.length > 0 ? remainingPath : null,
      current_location: newLocationId,
    };

    // Handle zone transitions
    if (oldLocationId !== newLocationId) {
      // Agent left a building — clear zone occupancy
      if (oldLocationId) {
        zoneOccupancy.leave(agent.id);

        const oldLoc = allLocations.find((l) => l.id === oldLocationId);
        if (oldLoc) {
          const updatedOccupants = oldLoc.current_occupants.filter((id) => id !== agent.id);
          db.update(locations)
            .set({ current_occupants: updatedOccupants })
            .where(eq(locations.id, oldLoc.id))
            .run();
          // Mirror change in local array so subsequent agents see fresh data
          oldLoc.current_occupants = updatedOccupants;
        }
      }
      if (newLocationId) {
        const newLoc = allLocations.find((l) => l.id === newLocationId);
        if (newLoc && !newLoc.current_occupants.includes(agent.id)) {
          const updatedOccupants = [...newLoc.current_occupants, agent.id];
          db.update(locations)
            .set({ current_occupants: updatedOccupants })
            .where(eq(locations.id, newLoc.id))
            .run();
          // Mirror change in local array so subsequent agents see fresh data
          newLoc.current_occupants = updatedOccupants;
        }
      }
    }

    db.update(agents)
      .set(updates)
      .where(eq(agents.id, agent.id))
      .run();

    // Arrive on the tick the walker gets there. Checking only at the top of the
    // next tick left every walk standing on its destination for one extra tick
    // before the queued action started — a whole tick_speed of game minutes per
    // walk (4 at 4x), and every trip was two walks (door, then spot). Measured
    // as ~1 h a day of "walking" per agent at 4x that was really standing still.
    if (remainingPath.length === 0 && distance(position, destPoint) < CONFIG.MOVEMENT.ARRIVAL_THRESHOLD_PX) {
      completeArrival(
        { ...agent, position, current_location: newLocationId, current_path: null },
        destPoint, world, allLocations,
      );
    }

    dirty = true;
  }

  if (dirty) {
    emitter.markDirty('agents.all');
  }
}
