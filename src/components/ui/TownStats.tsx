import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAgents } from "../../hooks/useAgents";
import { COLORS } from "../../lib/constants";

interface TownStatsProps {
  isOpen: boolean;
  onClose: () => void;
}

function moodColor(mood: number): string {
  if (mood >= 80) return COLORS.mood.happy;
  if (mood >= 60) return COLORS.mood.content;
  if (mood >= 40) return COLORS.mood.okay;
  if (mood >= 20) return COLORS.mood.down;
  return COLORS.mood.miserable;
}

function moodLabel(mood: number): string {
  if (mood >= 80) return "Happy";
  if (mood >= 60) return "Content";
  if (mood >= 40) return "Okay";
  if (mood >= 20) return "Down";
  return "Miserable";
}

export function TownStats({ isOpen, onClose }: TownStatsProps) {
  const economyStats = useQuery(api.queries.economy.getTownEconomyStats);
  const { agents } = useAgents();

  if (!isOpen) return null;

  const avgMood =
    agents.length > 0
      ? agents.reduce((sum: number, a: any) => sum + (a.mood ?? 50), 0) / agents.length
      : 50;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[420px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-sm font-bold text-white">Town Statistics</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Summary stats */}
        <div className="px-5 py-3 border-b border-gray-700">
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <div className="text-2xl font-bold text-white">{agents.length}</div>
              <div className="text-[10px] text-gray-400 uppercase">Population</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold" style={{ color: moodColor(avgMood) }}>
                {Math.round(avgMood)}
              </div>
              <div className="text-[10px] text-gray-400 uppercase">Avg Mood</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-400">
                {economyStats?.totalMoney ?? 0}
              </div>
              <div className="text-[10px] text-gray-400 uppercase">Total Coins</div>
            </div>
          </div>
        </div>

        {/* Average mood bar */}
        <div className="px-5 py-3 border-b border-gray-700">
          <div className="text-xs text-gray-400 mb-1">
            Town Mood: {moodLabel(avgMood)}
          </div>
          <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${avgMood}%`,
                backgroundColor: moodColor(avgMood),
              }}
            />
          </div>
        </div>

        {/* Per-agent mood breakdown */}
        <div className="px-5 py-3">
          <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">
            Agent Moods
          </div>
          <div className="space-y-1.5">
            {agents
              .slice()
              .sort((a: any, b: any) => (b.mood ?? 50) - (a.mood ?? 50))
              .map((agent: any) => {
                const mood = agent.mood ?? 50;
                return (
                  <div key={agent._id} className="flex items-center gap-2">
                    <div className="text-xs text-white w-20 truncate">{agent.name}</div>
                    <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${mood}%`,
                          backgroundColor: moodColor(mood),
                        }}
                      />
                    </div>
                    <div className="text-[10px] text-gray-500 w-6 text-right">
                      {Math.round(mood)}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
