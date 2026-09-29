/**
 * The part of the map the camera shows, for code outside the canvas.
 *
 * GameCanvas owns the camera; the spotlight hook (hooks/useSpotlight.ts) wants
 * to know who is on screen every few seconds. Rather than push a rect out of
 * the render loop 60 times a second, the canvas registers a getter and the
 * hook pulls when it needs it. No canvas mounted (setup wizard, tests) → null.
 */

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let getter: (() => ViewRect) | null = null;

/** Register the live camera; returns the unregister function for the effect cleanup. */
export function registerCameraView(get: () => ViewRect): () => void {
  getter = get;
  return () => {
    if (getter === get) getter = null;
  };
}

export function getCameraView(): ViewRect | null {
  return getter ? getter() : null;
}
