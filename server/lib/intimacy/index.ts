import { gameMinutes, type ClockTime } from '../gameClock';
import { longingPass } from './longing';

// ─── Intimacy: the periodic pass ─────────────────────────────────────────────
//
// Side-effect module, imported by server/index.ts like giftEngine and
// milestonesEngine (later tasks register their `conversation:ended` /
// `intimacy:*` listeners here). The periodic pass runs from the tick loop every
// 10 game minutes inside one transaction (engine/tick.ts), next to milestones.

/** One pass. For now only longing; rendezvous, suspicion and pregnancy join it. */
export function intimacyTick(time: ClockTime): void {
  longingPass(gameMinutes(time));
}
