import { useEffect, useState } from "react";
import type { Caption, CaptionLine } from "../../lib/directorCaption";

/** Fade time in and out; short enough to feel like a cut, long enough not to pop. */
const FADE_MS = 280;
/** Typewriter pace for the newest line, capped so a long speech still lands in ~2 s. */
const CHAR_MS = 26;
const MAX_TYPE_MS = 2200;


function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Reveals `text` character by character; everything else shows in full straight away. */
function useTypewriter(text: string, enabled: boolean): string {
  const [count, setCount] = useState(enabled ? 0 : text.length);
  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const step = Math.min(CHAR_MS, MAX_TYPE_MS / Math.max(1, text.length));
    const id = window.setInterval(() => {
      setCount((c) => {
        if (c + 1 >= text.length) window.clearInterval(id);
        return c + 1;
      });
    }, step);
    return () => window.clearInterval(id);
  }, [text, enabled]);
  return text.slice(0, count);
}

function CaptionLineView({ line, newest }: { line: CaptionLine; newest: boolean }) {
  const shown = useTypewriter(line.text, newest);
  if (line.narration) {
    return <div className={`text-xs italic ${newest ? "text-ui-dim" : "text-ui-muted"}`}>{shown}</div>;
  }
  return (
    <div className={`director-line text-[13px] leading-snug ${newest ? "text-ui-text" : "text-ui-dim"}`}>
      <span className="font-semibold mr-1.5" style={{ color: `var(--ui-speaker-${line.color})` }}>
        {line.name}:
      </span>
      {shown}
    </div>
  );
}

interface DirectorCaptionProps {
  /** The current shot's caption, or null when there is nothing to say. */
  caption: Caption | null;
  /** Identifies the camera cut; a new value fades the bar out, then in with the new content. */
  cut: number;
  /**
   * Space kept clear on the right so the bar never sits on the tools strip
   * (toolbarClearance(): the icon rail or the open w-44 strip plus its margin).
   */
  rightClearance: number;
}

/**
 * The director's lower-third: one line of context ("Mara confronts Jonas") over
 * the conversation's latest lines, speaker names in their own colour. Lines
 * stream in as turns arrive (the parent re-renders with the new `caption`); a
 * change of `cut` fades the whole bar out before the next shot's text appears.
 *
 * Lives inside the canvas container (absolute, bottom) so it follows the map
 * when the side panels resize, keeps clear of the toolbar on the right, and
 * never takes the pointer.
 */
export function DirectorCaption({ caption, cut, rightClearance }: DirectorCaptionProps) {
  const [shown, setShown] = useState<{ cut: number; caption: Caption | null }>({ cut: 0, caption: null });
  // True while the old shot's bar fades out, before the next shot's text replaces it.
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (cut === shown.cut || !shown.caption) {
      // Same shot (new lines, or the conversation's end), or nothing on screen
      // to fade: update in place. The identity check stops a re-render loop, since
      // the parent hands over a freshly built caption object each time.
      setShown((s) => (s.cut === cut && s.caption === caption ? s : { cut, caption }));
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setShown({ cut, caption });
      setLeaving(false);
    }, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [cut, caption, shown.cut, shown.caption]);

  if (!shown.caption) return null;
  const { context, lines } = shown.caption;

  return (
    <div
      className="absolute inset-x-0 bottom-3 z-20 flex justify-center pointer-events-none pl-4"
      style={{ paddingRight: rightClearance }}
      role="status"
      aria-live="polite"
    >
      {/* Keyed by the cut so each new shot's bar mounts fresh and plays the entrance. */}
      <div
        key={shown.cut}
        className="director-caption w-full max-w-2xl border border-ui-line border-l-4 border-l-ui-gold px-4 py-2 shadow-lg"
        data-leaving={leaving}
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-ui-gold mb-1 truncate">
          <span aria-hidden="true" className="mr-1.5">🎬</span>
          {context}
        </div>
        {lines.map((line, i) => (
          // Keyed by the line's place in the conversation: a new turn mounts a
          // fresh row (and restarts its typewriter); an old one keeps its text.
          <CaptionLineView key={line.index} line={line} newest={i === lines.length - 1} />
        ))}
      </div>
    </div>
  );
}

interface DirectorChipProps {
  paused: boolean;
  onResume: () => void;
}

/** "Director paused": the player took the camera, the director steps back for ~20 s. */
export function DirectorChip({ paused, onResume }: DirectorChipProps) {
  if (!paused) return null;
  return (
    <button
      type="button"
      onClick={onResume}
      className="absolute top-2 right-2 z-20 px-2 py-1 text-[11px] border border-ui-line-accent bg-ui-panel/90 text-ui-dim shadow hover:bg-ui-hover hover:text-ui-text transition-colors"
      title="You moved the camera, so the Director stepped back. Click to hand it back now."
    >
      <span aria-hidden="true" className="mr-1">⏸</span>
      Director paused
      <span className="text-ui-muted"> · resume</span>
    </button>
  );
}
