/**
 * Fire-and-forget events from the React UI to the Pixi canvas — things the canvas
 * can't learn from a query because they happen on the client first (the player
 * clicked something). Canvas systems subscribe; UI components emit. A few are
 * canvas → canvas (`lightning`), where one renderer owns a moment another reacts to.
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
  | 'arrange_rendezvous'
  | 'introduce_agent'
  | 'remove_agent'
  | 'whisper_thought'
  | 'start_rumor'
  | 'stir_feeling'
  | 'event'
  | 'weather';

export type CanvasBusEvent =
  /**
   * The player intervened on an agent (nudge, secret, confrontation...). Emitted only
   * once the server accepted it. `locationId` is the destination of `suggest_go_to`;
   * `amount` the coins of `give_money`; `x`/`y` (world px) where the agent last stood,
   * for `remove_agent` — its sprite is gone by the time the canvas hears about it.
   * `feeling` is the state `stir_feeling` planted (infatuated, jealous...).
   */
  | {
      type: 'intervention';
      agentIds: number[];
      kind: InterventionKind | string;
      locationId?: number;
      amount?: number;
      feeling?: string;
      x?: number;
      y?: number;
    }
  /**
   * One of the player's goals settled (hooks/useChallenges.ts): a challenge
   * completed or failed, or an achievement unlocked. `success` picks a gold
   * burst and a fanfare over a sigh; `agentIds` are the residents it was about
   * (empty for town-wide goals: the burst then fills the screen).
   */
  | { type: 'celebrate'; kind: 'challenge' | 'achievement'; success: boolean; agentIds: number[] }
  /** Pan the camera to a world-pixel point (does not change the selection). */
  | { type: 'focus'; x: number; y: number }
  /** Pan the camera to a location's centre. */
  | { type: 'focusLocation'; locationId: number }
  /**
   * Lightning just flashed (canvas → canvas: LightingSystem owns the only lightning, the
   * audio system rolls the thunder after it). `strength` 0..1.
   */
  | { type: 'lightning'; strength: number };

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
