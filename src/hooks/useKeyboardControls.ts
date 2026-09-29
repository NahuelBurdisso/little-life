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
  /** Tab (+1) / Shift+Tab (-1): step through the cast. */
  onCycleAgent: (direction: 1 | -1) => void;
  /** F: lock or release the camera on the selected resident. */
  onToggleFollow: () => void;
  /** C: show or hide the Director's lower-third captions. */
  onToggleCaptions?: () => void;
  /**
   * M: mute or unmute the town's sound. Returns whether it is muted now, so the
   * toast can say which way it went (the speaker button is easy to miss).
   */
  onToggleMute?: () => boolean;
  /**
   * False while a modal or menu is open. Tab must keep moving focus inside a
   * dialog (and F is not for the map behind it), so the resident keys stand down.
   */
  agentKeysEnabled: boolean;
  /** "?" opens the help overlay (src/lib/helpContent.ts lists every key). */
  onToggleHelp?: () => void;
  /** J: open or close the Town Journal. */
  onToggleJournal?: () => void;
  /**
   * Like `agentKeysEnabled`, except that the Journal itself doesn't count as a
   * blocking overlay: J must also close it. False while any OTHER modal or menu
   * is open, so J never stacks the Journal over a dialog.
   */
  journalKeyEnabled?: boolean;
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
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }
      // Ctrl/Cmd+1 switches browser tabs, Alt+digit is a browser shortcut too.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // By character, not code: "?" sits on a different physical key per layout.
      if (e.key === "?") {
        cbRef.current.onToggleHelp?.();
        return;
      }
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
        case "Tab":
          // Shift+Tab goes back. Focus stays where it is: the map is the point,
          // not the next button in DOM order.
          if (!cbRef.current.agentKeysEnabled) break;
          e.preventDefault();
          cbRef.current.onCycleAgent(e.shiftKey ? -1 : 1);
          break;
        case "KeyF":
          if (!cbRef.current.agentKeysEnabled) break;
          cbRef.current.onToggleFollow();
          break;
        case "KeyC":
          // Same guard as F: with a dialog open the key belongs to the dialog.
          if (!cbRef.current.agentKeysEnabled) break;
          cbRef.current.onToggleCaptions?.();
          break;
        case "KeyM": {
          // Same guard as F and C: with a dialog open the key belongs to the dialog.
          if (!cbRef.current.agentKeysEnabled || !cbRef.current.onToggleMute) break;
          const muted = cbRef.current.onToggleMute();
          pushToast(muted ? "Sound off" : "Sound on", "info", muted ? "🔇" : "🔊");
          break;
        }
        case "KeyJ":
          if (!(cbRef.current.journalKeyEnabled ?? cbRef.current.agentKeysEnabled)) break;
          cbRef.current.onToggleJournal?.();
          break;
        // Escape is owned by App's overlay handler, which closes only the topmost
        // layer. Deselecting here too would close the agent panel underneath it.
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [callbacks.enabled]);
}
