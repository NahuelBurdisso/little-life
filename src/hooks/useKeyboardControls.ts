import { useEffect } from "react";

export function useKeyboardControls(callbacks: {
  onTogglePause: () => void;
  onChangeSpeed: (speed: number) => void;
  onDeselect: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      switch (e.code) {
        case "Space":
          e.preventDefault();
          callbacks.onTogglePause();
          break;
        case "Digit1":
          callbacks.onChangeSpeed(0.5);
          break;
        case "Digit2":
          callbacks.onChangeSpeed(1);
          break;
        case "Digit3":
          callbacks.onChangeSpeed(2);
          break;
        case "Digit4":
          callbacks.onChangeSpeed(4);
          break;
        case "Escape":
          callbacks.onDeselect();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [callbacks]);
}
