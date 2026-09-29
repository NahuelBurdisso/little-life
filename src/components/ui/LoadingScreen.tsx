import { HealthBanner } from "./HealthBanner";

/**
 * Shown until the first world snapshot arrives (the WebSocket is still
 * connecting or the server is booting). A townsperson strolls along a ground
 * line under the title, so the wait reads as the game starting, not as a hang.
 * The sprite is the same sheet the canvas uses (canvas/agentFrames.ts).
 *
 * The health banner lives here too: when the socket is down on first load the
 * world query never resolves, so this screen is all the player ever sees and
 * the banner mounted in App's main layout would never render. Mounting it here
 * also keeps `useHealthBanner`'s reconnect handler alive, which is what
 * refetches the world once the socket finally comes up.
 */
export function LoadingScreen() {
  return (
    <div className="h-screen w-screen bg-ui-deep text-ui-text flex flex-col select-none">
      <HealthBanner />
      <div
        className="flex-1 min-h-0 flex flex-col items-center justify-center gap-6"
        role="status"
        aria-live="polite"
      >
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-[0.25em] uppercase text-ui-gold">Little Life</h1>
          <p className="mt-1 text-[11px] tracking-widest uppercase text-ui-muted">a small town, watched</p>
        </div>

        <div className="relative w-[320px] h-[72px] overflow-hidden flex items-end justify-center">
          <div
            className="ui-walker"
            style={{ backgroundImage: "url(/sprites/agents/carlos_mendez_sheet.png)" }}
          />
          <div className="absolute bottom-[6px] left-0 right-0 border-t-2 border-dashed border-ui-line" />
        </div>

        <p className="text-sm text-ui-dim">
          Connecting to the town
          <span className="ui-dot" style={{ animationDelay: "0s" }}>.</span>
          <span className="ui-dot" style={{ animationDelay: "0.2s" }}>.</span>
          <span className="ui-dot" style={{ animationDelay: "0.4s" }}>.</span>
        </p>
      </div>
    </div>
  );
}
