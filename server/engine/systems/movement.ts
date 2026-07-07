import { db } from '../../db';
import { agents, locations } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '../../lib/activityLogger';
import { CONFIG } from '../../lib/constants';
import { distance } from '../../lib/utils';
import { computeAStarPath, pixelToTile } from '../../lib/pathfinding';
import { emitter } from '../emitter';
import { getAgentStates } from '../../lib/states';
import { simEvents } from '../../lib/simEvents';
import { getInteriorGrid, zoneOccupancy, getOpenAreaTerrainCosts } from '../../lib/interiorGrid';
import { INTERIOR_ZONES } from '../../data/interiors';
import { executeZoneAction } from './zoneActions';
import { OPEN_AREA_TYPES } from '../../lib/worldgen/buildingTemplates';

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
const stuckTracker = new Map<number, { x: number; y: number; ticks: number }>();
const lastRecalcTick = new Map<number, number>();

// Cached terrain cost map — rebuilt when season changes
let cachedCostMap: Float32Array | null = null;
let cachedSeason: string = '';

function getWorldCostMap(world: WorldRow, allLocations: LocationRow[]): Float32Array {
  const season = world.time.season;
  if (cachedCostMap && cachedSeason === season) return cachedCostMap;

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

function isClosedBuilding(locType: string): boolean {
  return !OPEN_AREA_TYPES.has(locType);
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
          );

          if (interiorPath && interiorPath.length > 0) {
            // Set the agent walking along the interior path to the zone center
            // The destination is the last waypoint (zone center in world coords)
            const finalWp = interiorPath[interiorPath.length - 1];
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
                action_started: world.time.totalTicks,
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
        action_started: world.time.totalTicks,
        action_duration: minDuration > 0 ? minDuration + 5 : null, // add 5 ticks for transition
        action_queue: queue,
      })
      .where(eq(agents.id, agent.id))
      .run();
  } else {
    // Check if this is an interior A* arrival (agent walked to zone center)
    const interiorZoneId = (nextAction as any)?._interiorArrivalZone as string | undefined;
    const interiorBuilding = (nextAction as any)?._interiorArrivalBuilding as string | undefined;
    if (interiorZoneId && interiorBuilding) {
      zoneOccupancy.enter(agent.id, interiorBuilding, interiorZoneId);
      // Strip interior metadata from the action
      const { _interiorArrivalZone, _interiorArrivalBuilding, ...cleanAction } = nextAction as any;
      const resolvedAction = cleanAction.type ? cleanAction : { type: 'idle' };
      // Execute zone-specific effects (need deltas, item production)
      executeZoneAction(resolvedAction.type, agent.id);
      db.update(agents)
        .set({
          current_destination: null,
          current_path: null,
          current_action: resolvedAction,
          action_started: world.time.totalTicks,
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
          action_started: world.time.totalTicks,
          action_duration: minDuration > 0 ? minDuration : null,
          action_queue: queue,
        })
        .where(eq(agents.id, agent.id))
        .run();
    }
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
        if (cleanAction.type) {
          executeZoneAction(cleanAction.type, agent.id);
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

    // Stuck detection: if agent hasn't moved for 30 ticks, force idle
    const prevPos = stuckTracker.get(agent.id);
    if (prevPos) {
      if (Math.abs(agent.position.x - prevPos.x) < 4 && Math.abs(agent.position.y - prevPos.y) < 4) {
        prevPos.ticks++;
        if (prevPos.ticks >= 30) {
          db.update(agents).set({
            current_action: { type: 'idle' },
            current_destination: null,
            action_duration: 10,
            action_started: world.time.totalTicks,
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
        stuckTracker.set(agent.id, { x: agent.position.x, y: agent.position.y, ticks: 0 });
      }
    } else {
      stuckTracker.set(agent.id, { x: agent.position.x, y: agent.position.y, ticks: 0 });
    }

    const dest = agent.current_destination;
    const destPoint = { x: dest.x, y: dest.y };
    const distToDest = distance(agent.position, destPoint);

    // Check arrival
    if (distToDest < CONFIG.MOVEMENT.ARRIVAL_THRESHOLD_PX) {
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
      // Get or compute A* path
      let path = agent.current_path;
      if (!path || path.length === 0) {
        // If agent is inside a building, first move to the door exit
        let pathStart = agent.position;
        const insideBuilding = agent.current_location != null
          ? allLocations.find(l => l.id === agent.current_location)
          : null;

        if (insideBuilding && isClosedBuilding(insideBuilding.type)) {
          const interiorGrid = getInteriorGrid(insideBuilding.type);
          const buildingPos = insideBuilding.position;

          // Check if destination is inside the same building (interior-to-interior)
          const destInsideSameBuilding = isInsideLocation(destPoint, insideBuilding);

          if (destInsideSameBuilding && interiorGrid) {
            // Interior-to-interior: A* on interior grid
            const relStartX = agent.position.x - buildingPos.x;
            const relStartY = agent.position.y - buildingPos.y;
            const relEndX = destPoint.x - buildingPos.x;
            const relEndY = destPoint.y - buildingPos.y;

            const interiorPath = computeAStarPath(
              { x: relStartX, y: relStartY },
              { x: relEndX, y: relEndY },
              interiorGrid.collisionString,
              interiorGrid.width,
              interiorGrid.height,
              CONFIG.MOVEMENT.TILE_SIZE,
            );

            if (interiorPath && interiorPath.length > 0) {
              path = interiorPath.map(([px, py]) => [px + buildingPos.x, py + buildingPos.y]);
            } else {
              path = [[destPoint.x, destPoint.y]];
            }
          } else if (interiorGrid) {
            // Agent is inside a closed building, destination is outside.
            // First: interior A* from current position to door tile, then world A* from door to destination.
            const relStartX = agent.position.x - buildingPos.x;
            const relStartY = agent.position.y - buildingPos.y;
            const [doorGridX, doorGridY] = interiorGrid.doorTile;
            const doorRelX = doorGridX * CONFIG.MOVEMENT.TILE_SIZE + CONFIG.MOVEMENT.TILE_SIZE / 2;
            const doorRelY = doorGridY * CONFIG.MOVEMENT.TILE_SIZE + CONFIG.MOVEMENT.TILE_SIZE / 2;

            const exitPath = computeAStarPath(
              { x: relStartX, y: relStartY },
              { x: doorRelX, y: doorRelY },
              interiorGrid.collisionString,
              interiorGrid.width,
              interiorGrid.height,
              CONFIG.MOVEMENT.TILE_SIZE,
            );

            const exitWorldPath = (exitPath && exitPath.length > 0)
              ? exitPath.map(([px, py]) => [px + buildingPos.x, py + buildingPos.y])
              : [[insideBuilding.entry_point.x, insideBuilding.entry_point.y]];

            // World A* from door to destination
            const doorX = insideBuilding.entry_point.x;
            const doorY = insideBuilding.entry_point.y;
            const costMap = getWorldCostMap(world, allLocations);
            const outerPath = computeAStarPath(
              { x: doorX, y: doorY },
              destPoint,
              world.collision_grid,
              world.map_width,
              world.map_height,
              CONFIG.MOVEMENT.TILE_SIZE,
              costMap,
            );

            path = [...exitWorldPath, ...(outerPath ?? [[destPoint.x, destPoint.y]])];
          } else {
            // No interior grid (e.g. home) — use old behavior: route from door
            const doorX = insideBuilding.entry_point.x;
            const doorY = insideBuilding.entry_point.y;
            const costMap = getWorldCostMap(world, allLocations);
            const outerPath = computeAStarPath(
              { x: doorX, y: doorY },
              destPoint,
              world.collision_grid,
              world.map_width,
              world.map_height,
              CONFIG.MOVEMENT.TILE_SIZE,
              costMap,
            );
            // Prepend the door as first waypoint so agent exits building first
            path = [[doorX, doorY], ...(outerPath ?? [[destPoint.x, destPoint.y]])];
          }
        } else {
          const costMap = getWorldCostMap(world, allLocations);
          path = computeAStarPath(
            pathStart,
            destPoint,
            world.collision_grid,
            world.map_width,
            world.map_height,
            CONFIG.MOVEMENT.TILE_SIZE,
            costMap,
          );
        }

        if (!path || path.length === 0) {
          path = [[destPoint.x, destPoint.y]];
        }
        // Store path immediately
        db.update(agents)
          .set({ current_path: path })
          .where(eq(agents.id, agent.id))
          .run();
      }

      // Path validity: check if next tile is blocked, recalculate if so
      if (path.length > 0) {
        const [nextWpX, nextWpY] = path[0];
        const [tileX, tileY] = pixelToTile(nextWpX, nextWpY, CONFIG.MOVEMENT.TILE_SIZE);
        const tileIdx = tileY * world.map_width + tileX;
        if (tileX >= 0 && tileX < world.map_width && tileY >= 0 && tileY < world.map_height &&
            world.collision_grid[tileIdx] === '1') {
          const lastRecalc = lastRecalcTick.get(agent.id) ?? 0;
          if (world.time.totalTicks - lastRecalc > 10) {
            const costMap = getWorldCostMap(world, allLocations);
            path = computeAStarPath(
              agent.position, destPoint,
              world.collision_grid, world.map_width, world.map_height,
              CONFIG.MOVEMENT.TILE_SIZE,
              costMap,
            );
            if (!path || path.length === 0) path = [[destPoint.x, destPoint.y]];
            db.update(agents).set({ current_path: path }).where(eq(agents.id, agent.id)).run();
            lastRecalcTick.set(agent.id, world.time.totalTicks);
          }
        }
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

    dirty = true;
  }

  if (dirty) {
    emitter.markDirty('agents.all');
  }
}
