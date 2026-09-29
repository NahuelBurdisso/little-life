import { useState, useEffect } from "react";
import { formatTime, weatherEmoji, seasonEmoji } from "../../lib/formatters";
import { SpeedControls } from "./SpeedControls";
import { SavesDialog } from "./SavesDialog";
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
  onShowGazette: () => void;
  /** An edition of The Town Crier the player hasn't opened yet. */
  hasNewGazette: boolean;
  /**
   * Called after this tab replaced the world. Agent ids restart at 1, so App
   * must drop its selection — its own clock-drop check misses a restart of a
   * world that was still at totalTicks 0.
   */
  onWorldReplaced: () => void;
}

/** Shared look for the top-bar buttons: flat, warm, bordered like the panels below. */
const BAR_BTN =
  "px-3 py-1 text-sm bg-ui-raised hover:bg-ui-hover border border-ui-line hover:border-ui-line-accent rounded-sm transition-colors disabled:opacity-50";

export function TopBar({ world, events, liveConversations, awakeAgents, onShowEvents, onShowStats, onShowGazette, hasNewGazette, onWorldReplaced }: TopBarProps) {
  const [confirmAction, setConfirmAction] = useState<'restart' | 'reset' | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [showSaves, setShowSaves] = useState(false);

  // Both replace the world wholesale, but the server's `markAllDirty` only
  // reaches queries a subscription hook is wired to — `locations.getAll` isn't,
  // so the old town's buildings and relationship graph lingered on screen.
  // Invalidate the entire cache instead. App also catches this via the clock
  // running backwards, but that can't see a restart made while `totalTicks` is
  // still 0, and this is the direct path for the tab that asked for it.
  const utils = trpc.useUtils();

  const restartMutation = trpc.setup.restart.useMutation({
    onSuccess: () => { setIsResetting(false); setConfirmAction(null); utils.invalidate(); onWorldReplaced(); },
    onError: () => { setIsResetting(false); },
  });

  const resetToWizardMutation = trpc.setup.resetToWizard.useMutation({
    onSuccess: () => { setIsResetting(false); setConfirmAction(null); utils.invalidate(); onWorldReplaced(); },
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
  // Per-purpose latency since server start, for the 🧠 tooltip: says *what* is
  // slow when the queue grows (dialogue vs planning vs reflection).
  const { data: llmMetrics } = trpc.world.getLLMMetrics.useQuery(undefined, { refetchInterval: 10000 });
  const llmTitle = [
    'LLM calls running / queued — a growing queue means the model can\'t keep up with this speed',
    ...(llmMetrics ?? []).slice(0, 8).map((m) =>
      `${m.purpose}: ${m.calls} calls · p50 ${(m.p50Ms / 1000).toFixed(1)}s · p95 ${(m.p95Ms / 1000).toFixed(1)}s` +
      (m.tokPerSec ? ` · ${m.tokPerSec} tok/s` : '') +
      (m.errors ? ` · ${m.errors} errors` : ''),
    ),
  ].join('\n');

  const hasConfig = !!world.setup_config;

  return (
    <>
      <div className="h-12 bg-ui-panel border-b border-ui-line flex items-center px-4 gap-4 shrink-0">
        {/* Left: Time info. The raw tick counter lives in the tooltip: it is a debugging figure, not something to read. */}
        <div className="flex items-center gap-3 text-sm" title={`Tick ${world.time.totalTicks}`}>
          <span className="font-bold text-ui-gold">Day {world.time.day}</span>
          <span>{formatTime(world.time)}</span>
          <span>{weatherEmoji(world.weather)}</span>
          <span className="text-ui-dim capitalize">
            {seasonEmoji(world.time.season)} {world.time.season}
          </span>
        </div>

        {/* Live activity readout */}
        <div className="flex items-center gap-3 text-xs text-ui-dim">
          <span title="Conversations happening right now">💬 {liveConversations}</span>
          <span title="Agents awake">🚶 {awakeAgents}</span>
          {llm && (
            <span
              className={llm.waiting > 0 ? "text-ui-warn" : ""}
              title={llmTitle}
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
            className={BAR_BTN}
          >
            📊 Stats
          </button>
          <button
            onClick={onShowGazette}
            disabled={isResetting}
            title="The Town Crier — the town's daily paper"
            className={`${BAR_BTN} relative`}
          >
            📰 Paper
            {hasNewGazette && (
              <span className="absolute -top-1 -right-1 bg-ui-gold text-ui-deep font-bold text-[10px] rounded-full px-1 h-4 flex items-center justify-center">
                new
              </span>
            )}
          </button>
          <button
            onClick={onShowEvents}
            disabled={isResetting}
            className={`${BAR_BTN} relative`}
          >
            ⚡ Events
            {events.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-ui-warn text-ui-deep font-bold text-xs rounded-full w-4 h-4 flex items-center justify-center">
                {events.length}
              </span>
            )}
          </button>
          <div className="w-px h-6 bg-ui-line" />
          <button
            onClick={() => setShowSaves(true)}
            disabled={isResetting}
            title="Save or load a town"
            className={`${BAR_BTN} !px-2`}
            aria-label="Saves"
          >
            💾
          </button>
          <button
            onClick={() => setConfirmAction('restart')}
            disabled={isResetting || !hasConfig}
            title={hasConfig ? "Restart with same settings" : "No saved config — use Reset to Wizard"}
            className={`${BAR_BTN} !px-2 disabled:cursor-not-allowed`}
          >
            {isResetting && confirmAction === 'restart' ? '...' : '↻'}
          </button>
          <button
            onClick={() => setConfirmAction('reset')}
            disabled={isResetting}
            title="Reset to Setup Wizard"
            className={`${BAR_BTN} !px-2 hover:!bg-ui-bad/30 hover:!border-ui-bad/60`}
          >
            {isResetting && confirmAction === 'reset' ? '...' : '⟲'}
          </button>
        </div>
      </div>

      {showSaves && (
        <SavesDialog
          onClose={() => setShowSaves(false)}
          // A load replaces the world exactly like Restart does: same cache
          // invalidation, same selection drop in App.
          onLoaded={() => { utils.invalidate(); onWorldReplaced(); }}
          canSave={hasConfig}
          defaultName={`Day ${world.time.day}, ${world.time.season}`}
        />
      )}

      {/* Confirmation dialog overlay */}
      {confirmAction && !isResetting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-ui-panel border border-ui-line p-6 max-w-sm mx-4 shadow-xl">
            <h3 className="text-lg font-bold mb-2">
              {confirmAction === 'restart' ? 'Restart Simulation?' : 'Reset to Setup Wizard?'}
            </h3>
            <p className="text-sm text-ui-dim mb-6">
              {confirmAction === 'restart'
                ? 'All progress will be lost. The simulation will restart with the same settings.'
                : "All progress will be lost. You'll return to the setup wizard to reconfigure everything."}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 text-sm bg-ui-raised hover:bg-ui-hover border border-ui-line rounded-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className={`px-4 py-2 text-sm rounded-sm transition-colors font-medium ${
                  confirmAction === 'reset'
                    ? 'bg-ui-bad text-ui-deep font-semibold hover:brightness-110'
                    : 'bg-ui-gold text-ui-deep font-semibold hover:brightness-110'
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
