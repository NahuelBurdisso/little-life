import { useActivityFeed } from "../../hooks/useActivityFeed";
import { useWorldState } from "../../hooks/useWorldState";
import { timeAgo } from "../../lib/formatters";

export function ActivityFeed() {
  const { activities } = useActivityFeed();
  const { world } = useWorldState();

  return (
    <div className="h-[120px] bg-gray-800 border-t border-gray-700 overflow-y-auto px-4 py-2 shrink-0">
      {activities.length === 0 ? (
        <p className="text-gray-500 text-sm">No activity yet...</p>
      ) : (
        <div className="space-y-1">
          {activities.map((entry: { _id?: string; timestamp: number; message: string }, i: number) => (
            <div key={entry._id ?? i} className="text-sm flex gap-2">
              <span className="text-gray-500 shrink-0 w-16 text-right">
                {world
                  ? timeAgo(entry.timestamp, world.time.totalTicks, world.tickSpeed)
                  : ""}
              </span>
              <span className="text-gray-300">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
