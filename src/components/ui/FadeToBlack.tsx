import { useEffect, useRef, useState } from "react";
import { trpc } from "../../lib/trpc";
import { takeNewRows, type RowWatch } from "../../lib/achievements";
import { createFadeState, fadeLine, fadeRequestFor, type FadeRequest, type FadeRow } from "./fadeTrigger";

/** Ease to the vignette, hold it while the line reads, ease back. The plan's 2.5 s fade. */
const FADE_IN_MS = 2500;
const HOLD_MS = 3000;
const FADE_OUT_MS = 2500;
/** With reduced motion the screen dims and clears almost at once instead of easing. */
const REDUCED_FADE_MS = 300;

/** Darkest at the edges (the 88% of the plan); the middle stays a little lighter, like a lamp's reach. */
const VIGNETTE = "radial-gradient(ellipse at center, rgba(4,3,2,0.7) 0%, rgba(4,3,2,0.88) 100%)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

type Phase = "in" | "out";

interface FadeToBlackProps {
  /** The world is loaded and playing. */
  enabled: boolean;
  /** The "Cinematic moments" preference (lib/cinematic.ts). Off keeps watching rows but never fades. */
  cinematic: boolean;
  /** Agent id as a string, the way App keeps it. */
  selectedAgentId: string | null;
  favorites: ReadonlySet<string>;
}

/**
 * The camera looks away: when a couple the player is watching (the selected resident or a
 * favourite) slips away for the night, the screen eases down to a vignette and a single italic
 * line says the lamp was turned down (see `fadeTrigger.ts` for when). It never covers pointer
 * input, so the player can keep clicking underneath.
 *
 * Reads the same `getRecent` query the canvas and the goal watcher share (no extra request; the
 * canvas's subscription keeps it fresh). The rows are diffed every poll even while the setting
 * is off, so switching it back on cannot replay what happened meanwhile.
 */
export function FadeToBlack({ enabled, cinematic, selectedAgentId, favorites }: FadeToBlackProps) {
  const { data } = trpc.activity.getRecent.useQuery({ limit: 50 }, { enabled });
  const watch = useRef<RowWatch>({ watermark: null });
  const fadeState = useRef(createFadeState());
  // Read inside the row effect without re-running it: changing the selection must not re-diff rows.
  const context = useRef({ selectedAgentId, favorites, cinematic });
  context.current = { selectedAgentId, favorites, cinematic };

  const [request, setRequest] = useState<FadeRequest | null>(null);
  const [phase, setPhase] = useState<Phase>("out");
  const reduced = useRef(false);

  useEffect(() => {
    if (!data) return;
    const rows = takeNewRows(watch.current, data as unknown as FadeRow[]);
    if (rows.length === 0) return;
    const ctx = context.current;
    if (!ctx.cinematic) return;
    const next = fadeRequestFor(rows, ctx.selectedAgentId, ctx.favorites, Date.now(), fadeState.current);
    if (!next) return;
    reduced.current = prefersReducedMotion();
    setPhase("out"); // mount transparent, then transition in below
    setRequest(next);
  }, [data]);

  // The timeline: in -> hold -> out -> gone. One effect per request so unmounting clears it all.
  useEffect(() => {
    if (!request) return;
    const inMs = reduced.current ? REDUCED_FADE_MS : FADE_IN_MS;
    const outMs = reduced.current ? REDUCED_FADE_MS : FADE_OUT_MS;
    // Two frames: the overlay has to paint at opacity 0 before the transition to 1 can run.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase("in")));
    const toOut = window.setTimeout(() => setPhase("out"), inMs + HOLD_MS);
    const done = window.setTimeout(() => setRequest(null), inMs + HOLD_MS + outMs + 50);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(toOut);
      window.clearTimeout(done);
    };
  }, [request]);

  // Turning the setting off mid-fade lets the screen clear straight away.
  useEffect(() => {
    if (!cinematic) setRequest(null);
  }, [cinematic]);

  if (!request) return null;
  const shown = phase === "in";
  const ms = reduced.current ? REDUCED_FADE_MS : shown ? FADE_IN_MS : FADE_OUT_MS;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="fade-to-black"
      className="pointer-events-none fixed inset-0 z-[45] flex items-center justify-center"
      style={{
        background: VIGNETTE,
        opacity: shown ? 1 : 0,
        transition: `opacity ${ms}ms ease-in-out`,
      }}
    >
      <p
        className="max-w-[80%] text-center font-serif text-lg italic tracking-wide"
        style={{
          color: "rgba(240,226,200,0.92)",
          textShadow: "0 1px 6px rgba(0,0,0,0.8)",
          // The words arrive once the screen is mostly dark, and leave with it.
          opacity: shown ? 1 : 0,
          transition: `opacity ${ms}ms ease-in-out ${shown && !reduced.current ? Math.round(FADE_IN_MS * 0.5) : 0}ms`,
        }}
      >
        {fadeLine(request)}
      </p>
    </div>
  );
}
