import { trpc } from "../../lib/trpc";
import { weatherEmoji } from "../../lib/formatters";
import { PLAYER_EVENT_TYPES, WORLD_EVENTS } from "../../../server/data/worldEventCatalog";
import { eventMinutesLeft } from "../../../server/lib/gameClock";

type PlayerEventType = (typeof PLAYER_EVENT_TYPES)[number];

interface EventMenuProps {
  isOpen: boolean;
  onClose: () => void;
  activeEvents: any[];
  /**
   * The world clock in game minutes. The "time left" label used to read a
   * `remainingTicks` field nothing produced, so it never showed; it is now
   * derived from each event's `started_at` + `duration` (hours) against this.
   */
  nowMinutes: number | null;
}

/** Game minutes as "2h 15m left" / "40 min left". */
function formatTimeLeft(minutes: number): string {
  const m = Math.ceil(minutes);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h left` : `${h}h ${rest}m left`;
}

// Name and duration come from the shared catalog so the card always matches what
// `world.triggerEvent` actually starts; only the icon and blurb are UI-side.
const CARD_UI: Record<PlayerEventType, { icon: string; blurb: string }> = {
  festival: { icon: "🎉", blurb: "Everyone gathers for food and music!" },
  market_day: { icon: "🏪", blurb: "Special prices at all shops." },
  storm: { icon: "⛈️", blurb: "Everyone heads indoors." },
  sickness: { icon: "🤒", blurb: "Energy drains faster." },
  harvest: { icon: "🌾", blurb: "Farm production doubles!" },
  scandal: { icon: "🗞️", blurb: "Rumors spread twice as fast; the town is on edge." },
  blessing: { icon: "🌤️", blurb: "Everyone's mood lifts." },
};

const EVENT_CARDS = PLAYER_EVENT_TYPES.map((type) => ({
  type,
  icon: CARD_UI[type].icon,
  name: WORLD_EVENTS[type].name,
  duration: `${WORLD_EVENTS[type].durationHours} hours`,
  description: CARD_UI[type].blurb,
}));

const WEATHERS = ["sunny", "cloudy", "rainy", "stormy", "foggy", "snowy", "windy", "hot"] as const;

export function EventMenu({ isOpen, onClose, activeEvents, nowMinutes }: EventMenuProps) {
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
                    {nowMinutes != null && event.started_at != null && event.duration != null && (
                      <span className="ml-2 text-xs text-gray-400">
                        {formatTimeLeft(eventMinutesLeft(event, nowMinutes))}
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
