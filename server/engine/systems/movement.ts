import { db } from '../../db';
import { agents, locations } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { distance } from '../../lib/utils';
import { computeAStarPath } from '../../lib/pathfinding';
import { emitter } from '../emitter';

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

// --- Main Tick ---

export async function tick(world: WorldRow): Promise<void> {
  const activeAgents = db
    .select()
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();

  const allLocations = db.select().from(locations).all();

  let dirty = false;

  for (const agent of activeAgents) {
    if (agent.current_destination === null) continue;
    if ((agent.current_action as any)?.type !== 'walking') continue;

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
            db.update(locations)
              .set({
                current_occupants: oldLoc.current_occupants.filter((id) => id !== agent.id),
              })
              .where(eq(locations.id, oldLoc.id))
              .run();
          }
        }
        if (newLocationId) {
          const newLoc = allLocations.find((l) => l.id === newLocationId);
          if (newLoc && !newLoc.current_occupants.includes(agent.id)) {
            db.update(locations)
              .set({
                current_occupants: [...newLoc.current_occupants, agent.id],
              })
              .where(eq(locations.id, newLoc.id))
              .run();
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

    const moveDistance =
      CONFIG.MOVEMENT.PIXELS_PER_GAME_MINUTE * world.tick_speed;

    let position: { x: number; y: number };
    let remainingPath: number[][];

    if (distToDest < 48) {
      // Direct movement — no pathfinding needed
      if (distToDest <= moveDistance) {
        position = destPoint;
      } else {
        const ratio = moveDistance / distToDest;
        position = {
          x: agent.position.x + (destPoint.x - agent.position.x) * ratio,
          y: agent.position.y + (destPoint.y - agent.position.y) * ratio,
        };
      }
      remainingPath = [];
    } else {
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
          db.update(locations)
            .set({
              current_occupants: oldLoc.current_occupants.filter((id) => id !== agent.id),
            })
            .where(eq(locations.id, oldLoc.id))
            .run();
        }
      }
      if (newLocationId) {
        const newLoc = allLocations.find((l) => l.id === newLocationId);
        if (newLoc && !newLoc.current_occupants.includes(agent.id)) {
          db.update(locations)
            .set({
              current_occupants: [...newLoc.current_occupants, agent.id],
            })
            .where(eq(locations.id, newLoc.id))
            .run();
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
