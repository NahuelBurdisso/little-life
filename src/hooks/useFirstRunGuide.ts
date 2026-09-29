import { useCallback, useEffect, useRef, useState } from "react";
import {
  initialPhase,
  phaseAfterCoach,
  phaseAfterSkip,
  phaseAfterTour,
  type GuidePhase,
} from "../lib/firstRun";
import type { TourExit } from "../components/ui/MeetTheTown";

/**
 * Drives the first-run guide: "Meet the town" then the coach marks, once per world
 * seed, plus the "?" help and a replay of the tour from the toolbar.
 *
 * `ready` is false in the wizard and while the cast is still loading, so nothing
 * opens over a half-built screen. Each new `worldKey` is evaluated once: a restart
 * replays the same seeds and finds them already seen.
 */
export function useFirstRunGuide({ worldKey, ready }: { worldKey: string | null; ready: boolean }) {
  const [phase, setPhase] = useState<GuidePhase>("idle");
  const [replay, setReplay] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const evaluatedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !worldKey) {
      evaluatedKey.current = null;
      return;
    }
    if (evaluatedKey.current === worldKey) return;
    evaluatedKey.current = worldKey;
    setReplay(false);
    setPhase(initialPhase(worldKey));
  }, [ready, worldKey]);

  const closeTour = useCallback(
    (exit: TourExit) => {
      if (replay) {
        setReplay(false);
        setPhase("idle");
        return;
      }
      setPhase(exit === "skip" ? phaseAfterSkip(worldKey) : phaseAfterTour(worldKey));
    },
    [replay, worldKey],
  );

  const closeCoach = useCallback(() => setPhase(phaseAfterCoach(worldKey)), [worldKey]);

  const openTour = useCallback(() => {
    setReplay(true);
    setPhase("tour");
  }, []);

  return {
    tourOpen: phase === "tour",
    coachOpen: phase === "coach",
    tourIsReplay: replay,
    helpOpen,
    closeTour,
    closeCoach,
    openTour,
    openHelp: useCallback(() => setHelpOpen(true), []),
    closeHelp: useCallback(() => setHelpOpen(false), []),
    toggleHelp: useCallback(() => setHelpOpen((v) => !v), []),
  };
}
