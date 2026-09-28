import { useEffect, useRef } from "react";

export function useKeyboardControls(callbacks: {
  /** False while the sim isn't running yet (setup wizard, loading screen). */
  enabled: boolean;
  onTogglePause: () => void;
  onChangeSpeed: (speed: number) => void;
}) {
  // Callers pass a fresh object literal every render, and the app re-renders on
  // every subscription push — several times a second. Read the callbacks through
  // a ref so only `enabled` can resubscribe the listener.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    if (!cbRef.current.enabled) return;
    const handler = (e: KeyboardEvent) => {
      // Auto-repeat would fire one togglePause round trip per repeat event, so
      // holding Space flickers the sim and lands on whichever mutation resolves
      // last rather than on what the user asked for.
      if (e.repeat) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      switch (e.code) {
        case "Space":
          // Pause wins over button activation: clicking any button leaves it
          // focused, and buttons are still reachable by keyboard via Enter.
          e.preventDefault();
          cbRef.current.onTogglePause();
          break;
        case "Digit1":
          cbRef.current.onChangeSpeed(0.5);
          break;
        case "Digit2":
          cbRef.current.onChangeSpeed(1);
          break;
        case "Digit3":
          cbRef.current.onChangeSpeed(2);
          break;
        case "Digit4":
          cbRef.current.onChangeSpeed(4);
          break;
        // Escape is owned by App's overlay handler, which closes only the topmost
        // layer. Deselecting here too would close the agent panel underneath it.
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [callbacks.enabled]);
}
