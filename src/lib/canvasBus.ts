/**
 * Fire-and-forget events from the React UI to the Pixi canvas — things the canvas
 * can't learn from a query because they happen on the client first (the player
 * clicked something). Canvas systems subscribe; UI components emit.
 *
 * Kept tiny and synchronous: listeners must not throw or do heavy work.
 */
export type CanvasBusEvent =
  /** The player intervened on an agent (nudge, secret, confrontation, event...). */
  | { type: 'intervention'; agentIds: number[]; kind: string };

type Listener = (e: CanvasBusEvent) => void;
const listeners = new Set<Listener>();

export function emitCanvasEvent(e: CanvasBusEvent): void {
  for (const l of listeners) l(e);
}

/** Returns the unsubscribe function. */
export function onCanvasEvent(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
