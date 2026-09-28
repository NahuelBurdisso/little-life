import { useState, useEffect } from "react";
import { formatTime, weatherEmoji, seasonEmoji } from "../../lib/formatters";
import { SpeedControls } from "./SpeedControls";
import { trpc } from "../../lib/trpc";

interface TopBarProps {
  world: {
    time: { day: number; hour: number; minute: number; season: string; totalTicks: number };
    weather: string;
    is_paused: boolean;
    tick_speed: number;
    setup_config?: unknown;
  };
  events: unknown[];
  /** Conversations currently in progress — the headline "is anything happening" number. */
  liveConversations: number;
  awakeAgents: number;
  onShowEvents: () => void;
  onShowStats: () => void;
}

export function TopBar({ world, events, liveConversations, awakeAgents, onShowEvents, onShowStats }: TopBarProps) {
  const [confirmAction, setConfirmAction] = useState<'restart' | 'reset' | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  // Both replace the world wholesale, but the server's `markAllDirty` only
  // reaches queries a subscription hook is wired to — `locations.getAll` isn't,
  // so the old town's buildings and relationship graph lingered on screen.
  // Invalidate the entire cache instead. App also catches this via the clock
  // running backwards, but that can't see a restart made while `totalTicks` is
  // still 0, and this is the direct path for the tab that asked for it.
  const utils = trpc.useUtils();

  const restartMutation = trpc.setup.restart.useMutation({
    onSuccess: () => { setIsResetting(false); setConfirmAction(null); utils.invalidate(); },
    onError: () => { setIsResetting(false); },
  });

  const resetToWizardMutation = trpc.setup.resetToWizard.useMutation({
    onSuccess: () => { setIsResetting(false); setConfirmAction(null); utils.invalidate(); },
    onError: () => { setIsResetting(false); },
  });

  const handleConfirm = () => {
    setIsResetting(true);
    if (confirmAction === 'restart') {
      restartMutation.mutate();
    } else if (confirmAction === 'reset') {
      resetToWizardMutation.mutate();
    }
  };

  // This dialog is the topmost layer (z-50) but App owns the Escape chain and
  // can't see it, so Escape used to close the panel *underneath* and leave the
  // destructive prompt up. Capture phase + stopPropagation means the event never
  // reaches App's document listener while the dialog is open.
  useEffect(() => {
    if (!confirmAction || isResetting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setConfirmAction(null);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [confirmAction, isResetting]);

  // Polled, not subscribed: the semaphore is in-memory and changes between
  // ticks, so there is no dirty-channel to hang a subscription off.
  const { data: llm } = trpc.world.getLLMStats.useQuery(undefined, { refetchInterval: 2000 });

  const hasConfig = !!world.setup_config;

  return (
    <>
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

        {/* Live activity readout */}
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span title="Conversations happening right now">💬 {liveConversations}</span>
          <span title="Agents awake">🚶 {awakeAgents}</span>
          {llm && (
            <span
              className={llm.waiting > 0 ? "text-yellow-400" : ""}
              title="LLM calls running / queued — a growing queue means the model can't keep up with this speed"
            >
              🧠 {llm.active}
              {llm.waiting > 0 && `+${llm.waiting}`}
            </span>
          )}
        </div>

        {/* Center: Speed controls */}
        <div className="flex-1 flex justify-center">
          <SpeedControls isPaused={world.is_paused} currentSpeed={world.tick_speed} />
        </div>

        {/* Right: Menu buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={onShowStats}
            disabled={isResetting}
            className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
          >
            📊 Stats
          </button>
          <button
            onClick={onShowEvents}
            disabled={isResetting}
            className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors relative disabled:opacity-50"
          >
            ⚡ Events
            {events.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-yellow-500 text-black text-xs rounded-full w-4 h-4 flex items-center justify-center">
                {events.length}
              </span>
            )}
          </button>
          <div className="w-px h-6 bg-gray-600" />
          <button
            onClick={() => setConfirmAction('restart')}
            disabled={isResetting || !hasConfig}
            title={hasConfig ? "Restart with same settings" : "No saved config — use Reset to Wizard"}
            className="px-2 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isResetting && confirmAction === 'restart' ? '...' : '↻'}
          </button>
          <button
            onClick={() => setConfirmAction('reset')}
            disabled={isResetting}
            title="Reset to Setup Wizard"
            className="px-2 py-1 text-sm bg-gray-700 hover:bg-red-700 rounded transition-colors disabled:opacity-50"
          >
            {isResetting && confirmAction === 'reset' ? '...' : '⟲'}
          </button>
        </div>
      </div>

      {/* Confirmation dialog overlay */}
      {confirmAction && !isResetting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-800 border border-gray-600 rounded-lg p-6 max-w-sm mx-4 shadow-xl">
            <h3 className="text-lg font-bold mb-2">
              {confirmAction === 'restart' ? 'Restart Simulation?' : 'Reset to Setup Wizard?'}
            </h3>
            <p className="text-sm text-gray-300 mb-6">
              {confirmAction === 'restart'
                ? 'All progress will be lost. The simulation will restart with the same settings.'
                : "All progress will be lost. You'll return to the setup wizard to reconfigure everything."}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className={`px-4 py-2 text-sm rounded transition-colors font-medium ${
                  confirmAction === 'reset'
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {confirmAction === 'restart' ? 'Restart' : 'Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
