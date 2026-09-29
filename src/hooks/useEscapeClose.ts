import { useEffect, useRef } from "react";

/**
 * Escape closes this overlay and nothing else. App's own Escape handler closes
 * whatever panel is topmost by a fixed chain it can't extend to layers it doesn't
 * know about, so the guide overlays take the key in the capture phase and stop it
 * there (same trick as the TopBar confirm dialog).
 */
export function useEscapeClose(active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [active]);
}
