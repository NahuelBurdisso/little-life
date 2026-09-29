/**
 * Shown until the first world snapshot arrives (the WebSocket is still
 * connecting or the server is booting). A townsperson strolls along a ground
 * line under the title, so the wait reads as the game starting, not as a hang.
 * The sprite is the same sheet the canvas uses (canvas/agentFrames.ts).
 */
export function LoadingScreen() {
  return (
    <div
      className="h-screen w-screen bg-ui-deep text-ui-text flex flex-col items-center justify-center gap-6 select-none"
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
  );
}
