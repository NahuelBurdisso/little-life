import { trpc } from "../../lib/trpc";
import { weatherEmoji } from "../../lib/formatters";

interface EventMenuProps {
  isOpen: boolean;
  onClose: () => void;
  activeEvents: any[];
}

// Durations mirror `world.triggerEvent`'s EVENT_DEFS, which is the endpoint
// these cards call. Keep them in step when the server-side defs change.
const EVENT_CARDS = [
  { type: "festival", icon: "🎉", name: "Town Festival", duration: "6 hours", description: "Everyone gathers for food and music!" },
  { type: "market_day", icon: "🏪", name: "Market Day", duration: "8 hours", description: "Special prices at all shops." },
  { type: "storm", icon: "⛈️", name: "Storm", duration: "3 hours", description: "Everyone heads indoors." },
  { type: "sickness", icon: "🤒", name: "Flu Outbreak", duration: "24 hours", description: "Energy drains faster." },
  { type: "harvest", icon: "🌾", name: "Harvest Bounty", duration: "12 hours", description: "Farm production doubles!" },
  { type: "scandal", icon: "🗞️", name: "Town Scandal", duration: "4 hours", description: "A shocking rumor puts everyone on edge." },
  { type: "blessing", icon: "🌤️", name: "Beautiful Day", duration: "6 hours", description: "Everyone feels lighter." },
] as const;

const WEATHERS = ["sunny", "cloudy", "rainy", "stormy", "foggy", "snowy", "windy", "hot"] as const;

export function EventMenu({ isOpen, onClose, activeEvents }: EventMenuProps) {
  const triggerEventMutation = trpc.world.triggerEvent.useMutation();
  const setWeatherMutation = trpc.world.setWeather.useMutation();

  if (!isOpen) return null;

  const activeTypes = new Set(activeEvents.map((e: any) => e.type ?? e.eventType));

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-sm font-bold text-white">Events</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Active events */}
        {activeEvents.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-700">
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
              Active Events
            </h3>
            <div className="space-y-2">
              {activeEvents.map((event: any, i: number) => (
                <div key={i} className="flex items-center justify-between bg-gray-700/50 rounded-lg px-3 py-2">
                  <div>
                    <span className="text-sm text-white capitalize">
                      {(event.type ?? event.eventType ?? "").replace(/_/g, " ")}
                    </span>
                    {event.remainingTicks != null && (
                      <span className="ml-2 text-xs text-gray-400">
                        {Math.ceil(event.remainingTicks / 60)} min left
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Trigger new events */}
        <div className="px-5 py-3">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
            Trigger Event
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {EVENT_CARDS.map((card) => {
              const isActive = activeTypes.has(card.type);
              return (
                <div
                  key={card.type}
                  className={`rounded-lg border p-3 transition-colors ${
                    isActive
                      ? "border-gray-700 bg-gray-700/30 opacity-50"
                      : "border-gray-600 bg-gray-700/50 hover:bg-gray-700"
                  }`}
                >
                  <div className="text-lg mb-1">{card.icon}</div>
                  <div className="text-xs font-bold text-white">{card.name}</div>
                  <div className="text-[10px] text-gray-400 mb-1">{card.duration}</div>
                  <div className="text-[10px] text-gray-500 mb-2">{card.description}</div>
                  <button
                    disabled={isActive}
                    onClick={() => {
                      triggerEventMutation.mutate({ type: card.type });
                      onClose();
                    }}
                    className={`w-full px-2 py-1 text-xs rounded transition-colors ${
                      isActive
                        ? "bg-gray-600 text-gray-500 cursor-not-allowed"
                        : "bg-blue-600 hover:bg-blue-500 text-white"
                    }`}
                  >
                    {isActive ? "Active" : "Trigger"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Weather */}
        <div className="px-5 py-3 border-t border-gray-700">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
            Set Weather
          </h3>
          <div className="flex flex-wrap gap-2">
            {WEATHERS.map((weather) => (
              <button
                key={weather}
                onClick={() => setWeatherMutation.mutate({ weather, durationHours: 4 })}
                className="px-2 py-1 text-xs rounded bg-gray-700/50 border border-gray-600 hover:bg-gray-700 text-white capitalize transition-colors"
              >
                {weatherEmoji(weather)} {weather}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
