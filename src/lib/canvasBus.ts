/**
 * Fire-and-forget events from the React UI to the Pixi canvas — things the canvas
 * can't learn from a query because they happen on the client first (the player
 * clicked something). Canvas systems subscribe; UI components emit.
 *
 * Kept tiny and synchronous: listeners must not throw or do heavy work.
 */

/**
 * What the player did. The server-side nudge type, plus `event` (world event started
 * from the menu) and `weather`. Canvas systems pick an effect per kind; an unknown
 * kind falls back to the generic ping.
 */
export type InterventionKind =
  | 'suggest_talk'
  | 'suggest_go_to'
  | 'give_money'
  | 'tell_secret'
  | 'force_confront'
  | 'introduce_agent'
  | 'remove_agent'
  | 'event'
  | 'weather';

export type CanvasBusEvent =
  /**
   * The player intervened on an agent (nudge, secret, confrontation...). Emitted only
   * once the server accepted it. `locationId` is the destination of `suggest_go_to`;
   * `amount` the coins of `give_money`; `x`/`y` (world px) where the agent last stood,
   * for `remove_agent` — its sprite is gone by the time the canvas hears about it.
   */
  | {
      type: 'intervention';
      agentIds: number[];
      kind: InterventionKind | string;
      locationId?: number;
      amount?: number;
      x?: number;
      y?: number;
    }
  /** Pan the camera to a world-pixel point (does not change the selection). */
  | { type: 'focus'; x: number; y: number }
  /** Pan the camera to a location's centre. */
  | { type: 'focusLocation'; locationId: number };

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
