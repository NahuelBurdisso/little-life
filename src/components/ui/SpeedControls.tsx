import { useNudge } from "../../hooks/useNudge";

interface SpeedControlsProps {
  isPaused: boolean;
  currentSpeed: number;
}

export function SpeedControls({ isPaused, currentSpeed }: SpeedControlsProps) {
  const { togglePause, changeSpeed } = useNudge();
  const speeds = [0.5, 1, 2, 4];

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => togglePause()}
        className="px-3 py-1 text-sm rounded bg-gray-700 hover:bg-gray-600 transition-colors"
        title={isPaused ? "Resume (Space)" : "Pause (Space)"}
      >
        {isPaused ? "▶" : "⏸"}
      </button>
      {speeds.map((s) => (
        <button
          key={s}
          onClick={() => changeSpeed(s)}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            !isPaused && currentSpeed === s
              ? "bg-blue-600 text-white"
              : "bg-gray-700 hover:bg-gray-600 text-gray-300"
          }`}
          title={`${s}x speed (${speeds.indexOf(s) + 1})`}
        >
          {s}x
        </button>
      ))}
    </div>
  );
}
