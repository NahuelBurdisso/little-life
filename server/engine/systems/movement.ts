import { db } from '../../db';
import { agents, locations, activityLog } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { distance } from '../../lib/utils';
import { computeAStarPath, pixelToTile } from '../../lib/pathfinding';
import { emitter } from '../emitter';
import { getAgentStates } from '../../lib/states';

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

// --- Arrival Handler ---

function handleArrival(
  agent: AgentRow,
  world: WorldRow,
): void {
  const queue = [...agent.action_queue];
  const nextAction = queue.shift() ?? null;

  const actionType = (nextAction as any)?.type ?? 'idle';
  const minDuration = getMinDuration(actionType);

  // Two-phase interior movement: if the queued action carries zone coordinates,
  // teleport the agent directly to the zone position inside the building.
  // Interior movement doesn't need A* — the agent is already at the entry point.
  const zoneX = (nextAction as any)?.zoneX as number | undefined;
  const zoneY = (nextAction as any)?.zoneY as number | undefined;
  if (zoneX !== undefined && zoneY !== undefined) {
    // Smooth interior transition: lerp over 5 ticks instead of instant teleport
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

          db.insert(activityLog).values({
            type: 'state_change',
            message: `${agent.name} got lost and gave up walking.`,
            agent_ids: [agent.id],
            timestamp: world.time.totalTicks,
            real_timestamp: Date.now(),
          }).run();
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
      handleArrival(agent, world);

      // Handle zone transition on arrival
      const oldLocationId = agent.current_location;
      const newLocationId = findContainingLocation(destPoint, allLocations);

      if (oldLocationId !== newLocationId) {
        if (oldLocationId) {
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
        path = computeAStarPath(
          agent.position,
          destPoint,
          world.collision_grid,
          world.map_width,
          world.map_height,
          CONFIG.MOVEMENT.TILE_SIZE,
        );
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
            path = computeAStarPath(
              agent.position, destPoint,
              world.collision_grid, world.map_width, world.map_height,
              CONFIG.MOVEMENT.TILE_SIZE,
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
      if (oldLocationId) {
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
