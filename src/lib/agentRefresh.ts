import { throttle } from './throttle';

/**
 * How the agent/relationship queries refresh when the server pushes.
 *
 * Why (playtest #3): in 21 real minutes at 4x the client made ~5,700 calls each
 * to agents.getActive and relationships.getGraph and 5,425 to
 * agents.getAgentSummary — one per `agents.all` flush, and needs + movement
 * mark that channel every tick (four a second at 4x). Every one of them re-sent
 * the whole roster, the whole relationship table, or the selected agent's
 * memories + relationships + conversation history.
 *
 *  - getActive carries positions, so it stays quick — but at most every
 *    ACTIVE_MS. Sprites walk at constant speed between server positions
 *    (AgentSprite.setTarget) and treat a jump over 400 px as a teleport; at 4x
 *    a walker covers 192 px a tick, so two ticks per refresh stay a walk.
 *  - Everything else under `agents` (the selected agent's summary and
 *    thoughts — only mounted queries refetch, so that is the selected agent)
 *    and the town stats: every DETAIL_MS. A panel a second behind is invisible;
 *    a panel refetching its memory list four times a second is not.
 *  - The Hearts ledger (intimacy.getLedger) also folds in-memory state that no table
 *    write announces (longing grows hourly, a night is in the intimacy state before
 *    its relationship event lands), so it follows BOTH channels, throttled to LEDGER_MS.
 *    Only the mounted (open) modal actually refetches.
 *  - The relationship graph and the open pair dossier refresh on their own
 *    channel (relationships.onUpdate), which fires only when the table was
 *    written, and are throttled on top since a conversation burst writes
 *    several pairs over consecutive ticks.
 *
 * Leading + trailing throttles (lib/throttle.ts): the first change shows at
 * once, the last change is never lost. Module-level in the caller (useAgents)
 * because half a dozen components mount that hook, each with a subscription.
 */
export const REFRESH_MS = {
  ACTIVE: 500,
  DETAIL: 2000,
  GRAPH: 1000,
  PAIR_DOSSIER: 3000,
  LEDGER: 4000,
} as const;

export interface RefreshTargets {
  /** agents.getActive */
  active(): void;
  /** Every other agents.* query (summary, thoughts) + economy.getTownStats. */
  details(): void;
  /** relationships.getGraph */
  graph(): void;
  /** relationships.getPair (the open dossier) */
  pair(): void;
  /** intimacy.getLedger (the Hearts ledger) */
  ledger(): void;
}

export interface AgentRefresh {
  /** `flushTs`: the server's flush timestamp, identical for every subscriber of one flush. */
  onAgentsFlush(flushTs?: number): void;
  onRelationshipsFlush(flushTs?: number): void;
  cancel(): void;
}

export function createAgentRefresh(
  targets: RefreshTargets,
  now?: () => number,
  timers?: Parameters<typeof throttle>[3],
): AgentRefresh {
  const active = throttle(() => targets.active(), REFRESH_MS.ACTIVE, now, timers);
  const details = throttle(() => targets.details(), REFRESH_MS.DETAIL, now, timers);
  const graph = throttle(() => targets.graph(), REFRESH_MS.GRAPH, now, timers);
  const pair = throttle(() => targets.pair(), REFRESH_MS.PAIR_DOSSIER, now, timers);
  const ledger = throttle(() => targets.ledger(), REFRESH_MS.LEDGER, now, timers);
  // Six subscriptions deliver the same flush six times. Without this the
  // first call ran the leading edge and the other five scheduled a trailing
  // run, so every flush that opened a window still cost two refetches.
  let lastAgentsTs: number | undefined;
  let lastRelTs: number | undefined;
  return {
    onAgentsFlush(flushTs) {
      if (flushTs !== undefined && flushTs === lastAgentsTs) return;
      lastAgentsTs = flushTs;
      active();
      details();
      ledger();
    },
    onRelationshipsFlush(flushTs) {
      if (flushTs !== undefined && flushTs === lastRelTs) return;
      lastRelTs = flushTs;
      graph();
      pair();
      ledger();
    },
    cancel() {
      active.cancel();
      details.cancel();
      graph.cancel();
      pair.cancel();
      ledger.cancel();
    },
  };
}
