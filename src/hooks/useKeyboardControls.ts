import { useEffect, useRef } from "react";
import { pushToast } from "../lib/toast";

/** A nudge round trip; only `success` matters here. */
type Ack = Promise<{ success: boolean }> | void;

/** "Speed 0.5×", "Speed 4×" — the same speeds as the buttons. */
function speedLabel(speed: number): string {
  return `Speed ${speed}×`;
}

export function useKeyboardControls(callbacks: {
  /** False while the sim isn't running yet (setup wizard, loading screen). */
  enabled: boolean;
  /** Whether the sim is paused right now, to say what a Space press just did. */
  isPaused: boolean;
  onTogglePause: () => Ack;
  onChangeSpeed: (speed: number) => Ack;
}) {
  // Callers pass a fresh object literal every render, and the app re-renders on
  // every subscription push — several times a second. Read the callbacks through
  // a ref so only `enabled` can resubscribe the listener.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    if (!cbRef.current.enabled) return;

    // Space and 1-4 have no button press to watch, so each answers with a brief
    // toast once the server accepted it (failures are toasted by useNudge itself).
    const announce = (ack: Ack, message: string, icon: string) => {
      if (!ack) return;
      void ack.then((r) => {
        if (r?.success) pushToast(message, "info", icon);
      });
    };
    const setSpeed = (speed: number) =>
      announce(cbRef.current.onChangeSpeed(speed), speedLabel(speed), "⏩");

    const handler = (e: KeyboardEvent) => {
      // Auto-repeat would fire one togglePause round trip per repeat event, so
      // holding Space flickers the sim and lands on whichever mutation resolves
      // last rather than on what the user asked for.
      if (e.repeat) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      // Ctrl/Cmd+1 switches browser tabs, Alt+digit is a browser shortcut too.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.code) {
        case "Space": {
          // Pause wins over button activation: clicking any button leaves it
          // focused, and buttons are still reachable by keyboard via Enter.
          e.preventDefault();
          const willPause = !cbRef.current.isPaused;
          announce(
            cbRef.current.onTogglePause(),
            willPause ? "Paused" : "Resumed",
            willPause ? "⏸" : "▶",
          );
          break;
        }
        case "Digit1":
          setSpeed(0.5);
          break;
        case "Digit2":
          setSpeed(1);
          break;
        case "Digit3":
          setSpeed(2);
          break;
        case "Digit4":
          setSpeed(4);
          break;
        // Escape is owned by App's overlay handler, which closes only the topmost
        // layer. Deselecting here too would close the agent panel underneath it.
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [callbacks.enabled]);
}
