import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { weatherEmoji } from "../../lib/formatters";
import { pushToast } from "../../lib/toast";
import { emitCanvasEvent } from "../../lib/canvasBus";
import { eventBlurb, eventFocusLocation, eventIcon, EVENT_UI, formatTimeLeft } from "../../lib/eventUi";
import { PLAYER_EVENT_TYPES, WORLD_EVENTS } from "../../../server/data/worldEventCatalog";
import { eventMinutesLeft } from "../../../server/lib/gameClock";
import { W } from "./warmClasses";
import type { WorldEventView } from '../../lib/apiTypes';

interface EventMenuProps {
  isOpen: boolean;
  onClose: () => void;
  activeEvents: WorldEventView[];
  /**
   * The world clock in game minutes. The "time left" label used to read a
   * `remainingTicks` field nothing produced, so it never showed; it is now
   * derived from each event's `started_at` + `duration` (hours) against this.
   */
  nowMinutes: number | null;
}

// Name and duration come from the shared catalog so the card always matches what
// `world.triggerEvent` actually starts; only the icon and blurb are UI-side (lib/eventUi).
const EVENT_CARDS = PLAYER_EVENT_TYPES.map((type) => ({
  type,
  icon: EVENT_UI[type].icon,
  name: WORLD_EVENTS[type].name,
  duration: `${WORLD_EVENTS[type].durationHours}h`,
  description: EVENT_UI[type].blurb,
}));

const WEATHERS = ["sunny", "cloudy", "rainy", "stormy", "foggy", "snowy", "windy", "hot"] as const;
const WEATHER_HOURS = [2, 4, 8, 12] as const;

function errMessage(err: unknown): string {
  return `Server error: ${err instanceof Error ? err.message : String(err)}`;
}

export function EventMenu({ isOpen, onClose, activeEvents, nowMinutes }: EventMenuProps) {
  const triggerEvent = trpc.world.triggerEvent.useMutation();
  const setWeather = trpc.world.setWeather.useMutation();
  // Both are already cached by App/useWorldState; reading them here keeps App's
  // wiring for this menu at zero props while still knowing the current weather and
  // where the town square is.
  const { data: world } = trpc.world.getState.useQuery();
  const { data: locations } = trpc.locations.getAll.useQuery();

  // One request at a time: the clicked control shows "…" and everything else in
  // its group is inert, so a slow reply can't be answered by a second click.
  const [pending, setPending] = useState<string | null>(null);
  const [weatherHours, setWeatherHours] = useState<number>(4);

  if (!isOpen) return null;

  const activeTypes = new Set(activeEvents.map((e) => e.type));
  const currentWeather: string | null = world?.weather ?? null;
  const weatherLeft: number = world?.weather_duration ?? 0;

  const startEvent = async (card: (typeof EVENT_CARDS)[number]) => {
    if (pending) return;
    setPending(`event:${card.type}`);
    try {
      const r: { ok: boolean; error?: string; event?: string } = await triggerEvent.mutateAsync({ type: card.type });
      if (!r.ok) {
        // e.g. "already active" or the concurrent-event cap: stay open so the
        // player can pick something else.
        pushToast(r.error ?? "Could not start that event", "warning", card.icon);
        return;
      }
      pushToast(`${r.event ?? card.name} has begun`, "success", card.icon);
      // The row a player event creates has no location, so aim the canvas at the
      // place the event is about (the square for a festival, the farm for a harvest).
      const locationId = eventFocusLocation(card.type, locations ?? []) ?? undefined;
      emitCanvasEvent({ type: "intervention", kind: "event", agentIds: [], locationId });
      if (locationId != null) emitCanvasEvent({ type: "focusLocation", locationId });
      onClose();
    } catch (err) {
      pushToast(errMessage(err), "error");
    } finally {
      setPending(null);
    }
  };

  const changeWeather = async (weather: (typeof WEATHERS)[number]) => {
    if (pending) return;
    setPending(`weather:${weather}`);
    try {
      const r = await setWeather.mutateAsync({ weather, durationHours: weatherHours });
      if (!r.ok) {
        pushToast("Could not change the weather", "warning", weatherEmoji(weather));
        return;
      }
      pushToast(`Weather: ${weather} for ${weatherHours}h`, "success", weatherEmoji(weather));
      emitCanvasEvent({ type: "intervention", kind: "weather", agentIds: [] });
      onClose();
    } catch (err) {
      pushToast(errMessage(err), "error");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={W.backdrop} onClick={onClose}>
      <div
        className={`${W.modal} w-[500px] max-w-[95vw] max-h-[85vh]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={W.modalHeader}>
          <h2 className={W.title}>Events &amp; Weather</h2>
          <button onClick={onClose} className={W.close} aria-label="Close">
            &times;
          </button>
        </div>

        {/* Active events */}
        {activeEvents.length > 0 && (
          <div className={W.section}>
            <h3 className={W.sectionTitle}>Happening now</h3>
            <div className="space-y-1.5">
              {activeEvents.map((event, i) => {
                const type: string = event.type ?? "";
                const left =
                  nowMinutes != null && event.started_at != null && event.duration != null
                    ? formatTimeLeft(eventMinutesLeft(event, nowMinutes))
                    : null;
                return (
                  <div key={event.id ?? i} className={`${W.card} flex items-start gap-2.5 px-3 py-2`}>
                    <span className="text-lg leading-none mt-0.5">{eventIcon(type)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-bold text-[var(--ui-text-primary)]">
                          {event.name ?? type.replace(/_/g, " ")}
                        </span>
                        {left && (
                          <span className="text-[10px] text-[var(--ui-accent-gold)] shrink-0">{left}</span>
                        )}
                      </div>
                      <div className={`text-[10px] ${W.muted}`}>
                        {eventBlurb(type, event.description ?? "")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Trigger new events */}
        <div className={W.section}>
          <h3 className={W.sectionTitle}>Trigger event</h3>
          <div className="grid grid-cols-2 gap-2">
            {EVENT_CARDS.map((card) => {
              const isActive = activeTypes.has(card.type);
              const isPending = pending === `event:${card.type}`;
              return (
                <div
                  key={card.type}
                  className={`${W.card} p-2.5 flex flex-col ${isActive ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-lg leading-none">{card.icon}</span>
                    <div className="min-w-0">
                      <div className="text-xs font-bold truncate">{card.name}</div>
                      <div className="text-[10px] text-[var(--ui-accent-gold)]">{card.duration}</div>
                    </div>
                  </div>
                  <div className={`text-[10px] ${W.muted} mb-2 flex-1`}>{card.description}</div>
                  <button
                    disabled={isActive || pending !== null}
                    aria-busy={isPending}
                    onClick={() => startEvent(card)}
                    className={`w-full px-2 py-1 text-xs ${W.btnPrimary}`}
                  >
                    {isPending ? "Starting…" : isActive ? "Active" : "Trigger"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Weather */}
        <div className={W.section}>
          <div className="flex items-center justify-between mb-2">
            <h3 className={`${W.sectionTitle} mb-0`}>Set weather</h3>
            <div className="flex items-center gap-1" role="group" aria-label="Weather duration">
              {WEATHER_HOURS.map((h) => (
                <button
                  key={h}
                  onClick={() => setWeatherHours(h)}
                  aria-pressed={weatherHours === h}
                  className={`px-1.5 py-0.5 text-[10px] border transition-colors ${
                    weatherHours === h
                      ? "border-[var(--ui-accent-gold)] text-[var(--ui-accent-gold)] bg-[var(--ui-accent-gold)]/15"
                      : "border-[var(--ui-border)] text-[var(--ui-text-secondary)] hover:border-[var(--ui-border-accent)]"
                  }`}
                >
                  {h}h
                </button>
              ))}
            </div>
          </div>
          {currentWeather && (
            <p className={`text-[10px] ${W.muted} mb-2`}>
              Now: {weatherEmoji(currentWeather, world?.time?.hour)} <span className="capitalize">{currentWeather}</span>
              {weatherLeft >= 1 ? ` · ${formatTimeLeft(weatherLeft)}` : ""}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {WEATHERS.map((weather) => {
              const isCurrent = currentWeather === weather;
              const isPending = pending === `weather:${weather}`;
              return (
                <button
                  key={weather}
                  disabled={pending !== null}
                  aria-pressed={isCurrent}
                  aria-busy={isPending}
                  onClick={() => changeWeather(weather)}
                  className={`px-2 py-1 text-xs capitalize ${
                    isCurrent
                      ? "border border-[var(--ui-accent-gold)] bg-[var(--ui-accent-gold)]/15 text-[var(--ui-accent-gold)] disabled:opacity-50"
                      : W.btn
                  }`}
                >
                  {isPending ? "…" : weatherEmoji(weather)} {weather}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
