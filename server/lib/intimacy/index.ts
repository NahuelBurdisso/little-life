import { gameMinutes, type ClockTime } from '../gameClock';
import { registerKissListener } from './kiss';
import { longingPass } from './longing';

// ─── Intimacy: the periodic pass ─────────────────────────────────────────────
//
// Side-effect module, imported by server/index.ts like giftEngine and
// milestonesEngine (later tasks register their `conversation:ended` /
// `intimacy:*` listeners here). The periodic pass runs from the tick loop every
// 10 game minutes inside one transaction (engine/tick.ts), next to milestones.

// A warm conversation can end in a kiss (kiss.ts). The listener registers on import,
// like milestonesEngine's; later tasks add theirs next to it.
registerKissListener();

/** One pass. For now only longing; rendezvous, suspicion and pregnancy join it. */
export function intimacyTick(time: ClockTime): void {
  longingPass(gameMinutes(time));
}
