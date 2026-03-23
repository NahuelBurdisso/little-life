import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { CONFIG } from "../engine/constants";
import { distance } from "../lib/utils";
import { computeAStarPath } from "../lib/pathfinding";

export async function tick(
  ctx: MutationCtx,
  world: Doc<"worldState">
): Promise<void> {
  const agents = await ctx.db
    .query("agents")
    .filter((q) => q.eq(q.field("isActive"), true))
    .collect();

  const locations = await ctx.db.query("locations").collect();

  for (const agent of agents) {
    if (agent.currentDestination === null) continue;
    if (agent.currentAction?.type !== "walking") continue;

    const dest = agent.currentDestination;
    const destPoint = { x: dest.x, y: dest.y };
    const distToDest = distance(agent.position, destPoint);

    // Check arrival
    if (distToDest < CONFIG.MOVEMENT.ARRIVAL_THRESHOLD_PX) {
      await handleArrival(ctx, agent, world);
      continue;
    }

    const moveDistance =
      CONFIG.MOVEMENT.PIXELS_PER_GAME_MINUTE * world.tickSpeed;

    // If close to destination (< 48px), skip A* and move directly
    let position: { x: number; y: number };
    let remainingPath: number[][];

    if (distToDest < 48) {
      // Direct movement toward destination — no pathfinding needed
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
      let path = agent.currentPath;
      if (!path || path.length === 0) {
        path = computeAStarPath(
          agent.position,
          destPoint,
          world.collisionGrid,
          world.mapWidth,
          world.mapHeight,
          CONFIG.MOVEMENT.TILE_SIZE
        );
        // Fallback: if path computation returns empty, move directly
        if (!path || path.length === 0) {
          path = [[destPoint.x, destPoint.y]];
        }
        // Store path immediately so we don't recompute next tick
        await ctx.db.patch(agent._id, { currentPath: path });
      }

      // Advance position along path
      const result = advanceAlongPath(agent.position, path, moveDistance);
      position = result.position;
      remainingPath = result.remainingPath;
    }

    // Update location zones
    const oldLocationId = agent.currentLocation;
    const newLocationId = findContainingLocation(position, locations);

    const updates: Record<string, unknown> = {
      position,
      currentPath: remainingPath.length > 0 ? remainingPath : null,
      currentLocation: newLocationId,
    };

    // Handle zone transitions
    if (oldLocationId !== newLocationId) {
      // Remove from old location occupants
      if (oldLocationId) {
        const oldLoc = locations.find((l) => l._id === oldLocationId);
        if (oldLoc) {
          await ctx.db.patch(oldLoc._id, {
            currentOccupants: oldLoc.currentOccupants.filter(
              (id) => id !== agent._id
            ),
          });
        }
      }

      // Add to new location occupants
      if (newLocationId) {
        const newLoc = locations.find((l) => l._id === newLocationId);
        if (newLoc) {
          if (!newLoc.currentOccupants.includes(agent._id)) {
            await ctx.db.patch(newLoc._id, {
              currentOccupants: [...newLoc.currentOccupants, agent._id],
            });
          }
        }
      }
    }

    await ctx.db.patch(agent._id, updates);
  }
}

async function handleArrival(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  world: Doc<"worldState">
): Promise<void> {
  const queue = [...agent.actionQueue];
  const nextAction = queue.shift() ?? null;

  const actionType = nextAction?.type ?? "idle";
  const minDuration = getMinDuration(actionType);

  await ctx.db.patch(agent._id, {
    currentDestination: null,
    currentPath: null,
    currentAction: nextAction ?? { type: "idle" },
    actionStarted: world.time.totalTicks,
    actionDuration: minDuration > 0 ? minDuration : null,
    actionQueue: queue,
  });
}

function getMinDuration(actionType: string): number {
  return CONFIG.DECISIONS.ACTION_MIN_DURATIONS[actionType] ?? 10;
}

function advanceAlongPath(
  current: { x: number; y: number },
  path: number[][],
  totalDistance: number
): { position: { x: number; y: number }; remainingPath: number[][] } {
  let pos = { x: current.x, y: current.y };
  let remaining = totalDistance;
  let pathIndex = 0;

  while (remaining > 0 && pathIndex < path.length) {
    const waypoint = { x: path[pathIndex][0], y: path[pathIndex][1] };
    const dist = distance(pos, waypoint);

    if (dist <= remaining) {
      // We can reach this waypoint
      pos = waypoint;
      remaining -= dist;
      pathIndex++;
    } else {
      // Move partially toward this waypoint
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
  loc: { position: { x: number; y: number; width: number; height: number } }
): boolean {
  return (
    pos.x >= loc.position.x &&
    pos.x < loc.position.x + loc.position.width &&
    pos.y >= loc.position.y &&
    pos.y < loc.position.y + loc.position.height
  );
}

function findContainingLocation(
  pos: { x: number; y: number },
  locations: Doc<"locations">[]
): Id<"locations"> | null {
  for (const loc of locations) {
    if (isInsideLocation(pos, loc)) {
      return loc._id;
    }
  }
  return null;
}
