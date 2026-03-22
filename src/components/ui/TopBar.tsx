import { formatTime, weatherEmoji, seasonEmoji } from "../../lib/formatters";
import { SpeedControls } from "./SpeedControls";

interface TopBarProps {
  world: {
    time: { day: number; hour: number; minute: number; season: string; totalTicks: number };
    weather: string;
    isPaused: boolean;
    tickSpeed: number;
  };
  events: unknown[];
  onShowEvents: () => void;
  onShowStats: () => void;
}

export function TopBar({ world, events, onShowEvents, onShowStats }: TopBarProps) {
  return (
    <div className="h-12 bg-gray-800 border-b border-gray-700 flex items-center px-4 gap-4 shrink-0">
      {/* Left: Time info */}
      <div className="flex items-center gap-3 text-sm">
        <span className="font-bold">Day {world.time.day}</span>
        <span>{formatTime(world.time)}</span>
        <span>{weatherEmoji(world.weather)}</span>
        <span className="text-gray-400 capitalize">
          {seasonEmoji(world.time.season)} {world.time.season}
        </span>
        <span className="text-gray-600 text-xs">tick:{world.time.totalTicks}</span>
      </div>

      {/* Center: Speed controls */}
      <div className="flex-1 flex justify-center">
        <SpeedControls isPaused={world.isPaused} currentSpeed={world.tickSpeed} />
      </div>

      {/* Right: Menu buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={onShowStats}
          className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors"
        >
          📊 Stats
        </button>
        <button
          onClick={onShowEvents}
          className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors relative"
        >
          ⚡ Events
          {events.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-yellow-500 text-black text-xs rounded-full w-4 h-4 flex items-center justify-center">
              {events.length}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
