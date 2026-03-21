import { COLORS } from "../../lib/constants";

interface NeedsBarsProps {
  needs: {
    hunger: number;
    energy: number;
    social: number;
    comfort: number;
    fun: number;
    mood: number;
    stress: number;
  };
}

function getMoodColor(mood: number): string {
  if (mood > 80) return COLORS.mood.happy;
  if (mood > 60) return COLORS.mood.content;
  if (mood > 40) return COLORS.mood.okay;
  if (mood > 20) return COLORS.mood.down;
  return COLORS.mood.miserable;
}

export function NeedsBars({ needs }: NeedsBarsProps) {
  const bars = [
    { label: "Hunger", value: needs.hunger, key: "hunger" },
    { label: "Energy", value: needs.energy, key: "energy" },
    { label: "Social", value: needs.social, key: "social" },
    { label: "Comfort", value: needs.comfort, key: "comfort" },
    { label: "Fun", value: needs.fun, key: "fun" },
  ];

  return (
    <div className="px-3 py-2 border-b border-gray-700 space-y-1.5">
      {bars.map(({ label, value, key }) => (
        <div key={key} className="flex items-center gap-2 text-xs">
          <span className="w-14 text-gray-400">{label}</span>
          <div className="flex-1 h-2.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${value}%`,
                backgroundColor:
                  value > 70
                    ? COLORS.needBar.high
                    : value > 35
                      ? COLORS.needBar.medium
                      : COLORS.needBar.low,
              }}
            />
          </div>
          <span className="w-6 text-right text-gray-500">
            {Math.round(value)}
          </span>
        </div>
      ))}
      {/* Mood bar - wider, separate */}
      <div className="flex items-center gap-2 text-xs pt-1 border-t border-gray-700/50 mt-1">
        <span className="w-14 text-gray-300 font-medium">Mood</span>
        <div className="flex-1 h-3 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${needs.mood}%`,
              backgroundColor: getMoodColor(needs.mood),
            }}
          />
        </div>
        <span className="w-6 text-right text-gray-300">
          {Math.round(needs.mood)}
        </span>
      </div>
      {/* Stress indicator */}
      {needs.stress > 30 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="w-14 text-red-400">Stress</span>
          <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-red-500/80 transition-all duration-300"
              style={{ width: `${needs.stress}%` }}
            />
          </div>
          <span className="w-6 text-right text-red-400">
            {Math.round(needs.stress)}
          </span>
        </div>
      )}
    </div>
  );
}
