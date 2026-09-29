import { useEffect, useState } from "react";
import { useEscapeClose } from "../../hooks/useEscapeClose";
import { W } from "./warmClasses";

interface CoachMarksProps {
  isOpen: boolean;
  /** Finished, skipped or Escape: all the same, the marks are never shown twice. */
  onClose: () => void;
}

interface Step {
  icon: string;
  title: string;
  body: string;
  /** `data-coach` values of the controls to ring. */
  anchors?: string[];
  place: "bottom" | "top-right";
}

const STEPS: Step[] = [
  {
    icon: "👆",
    title: "Click someone to look inside",
    body: "Click any resident on the map to open their panel: needs, thoughts, plans, memories and who they love or loathe. Click a building to see who is in it.",
    place: "bottom",
  },
  {
    icon: "🖱️",
    title: "Right-click to meddle",
    body: "Right-click a resident to poke the story: suggest a chat or a destination, give them money, pair them with someone, slip them a secret or stage a confrontation. This is the game.",
    place: "bottom",
  },
  {
    icon: "⚡",
    title: "Events, weather and the Journal",
    body: "Events (top right) starts a festival, a storm or a scandal and sets the weather. Journal: the paper, alerts and stories — the Town Crier's daily edition, what your meddling came to, and what is about to boil over (J opens it). Press ? any time for the hotkeys.",
    anchors: ["events", "paper"],
    place: "top-right",
  },
];

const PLACE_CLASS: Record<Step["place"], string> = {
  bottom: "left-1/2 -translate-x-1/2 bottom-44",
  "top-right": "right-4 top-16",
};

/** Screen rectangles of the controls a step points at; re-measured on resize. */
function useAnchorRects(anchors: string[] | undefined, active: boolean) {
  const [rects, setRects] = useState<DOMRect[]>([]);
  const key = anchors?.join(",") ?? "";
  useEffect(() => {
    if (!active || !key) {
      setRects([]);
      return;
    }
    const measure = () => {
      const found: DOMRect[] = [];
      for (const name of key.split(",")) {
        const el = document.querySelector(`[data-coach="${name}"]`);
        if (el) found.push(el.getBoundingClientRect());
      }
      setRects(found);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active, key]);
  return rects;
}

/**
 * Three dismissible cards after "Meet the town": inspect, meddle, events/journal.
 * Non-blocking - the map stays clickable underneath, so step 1 and 2 can be tried
 * while they are on screen.
 */
export function CoachMarks({ isOpen, onClose }: CoachMarksProps) {
  const [index, setIndex] = useState(0);
  useEscapeClose(isOpen, onClose);

  // A fresh run (new world, replay) starts at the first card.
  useEffect(() => {
    if (isOpen) setIndex(0);
  }, [isOpen]);

  const step = STEPS[Math.min(index, STEPS.length - 1)];
  const rects = useAnchorRects(step.anchors, isOpen);

  if (!isOpen) return null;
  const last = index >= STEPS.length - 1;

  return (
    <>
      {rects.map((r, i) => (
        <div
          key={i}
          aria-hidden
          className="fixed z-50 pointer-events-none border-2 border-[var(--ui-accent-gold)] animate-pulse"
          style={{ left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 }}
        />
      ))}
      <div
        className={`fixed z-50 w-[340px] max-w-[92vw] ${PLACE_CLASS[step.place]} ${W.card} border-[var(--ui-border-accent)] shadow-2xl`}
        role="dialog"
        aria-label={`Tip ${index + 1} of ${STEPS.length}`}
      >
        <div className="flex items-start gap-2.5 p-3.5">
          <span aria-hidden className="text-2xl leading-none">
            {step.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className={`${W.title} mb-1`}>{step.title}</div>
            <p className="text-xs leading-relaxed text-[var(--ui-text-primary)]">{step.body}</p>
          </div>
          <button onClick={onClose} className={W.close} aria-label="Dismiss tips">
            &times;
          </button>
        </div>
        <div className="flex items-center justify-between px-3.5 py-2 border-t border-[var(--ui-border)] bg-[var(--ui-bg-panel)]">
          <div className="flex items-center gap-1.5" aria-hidden>
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${i === index ? "bg-[var(--ui-accent-gold)]" : "bg-[var(--ui-border)]"}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <button onClick={() => setIndex(index - 1)} className={`px-2.5 py-1 text-xs ${W.btn}`}>
                Back
              </button>
            )}
            <button
              onClick={() => (last ? onClose() : setIndex(index + 1))}
              className={`px-3 py-1 text-xs font-semibold ${W.btnPrimary}`}
            >
              {last ? "Got it" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
