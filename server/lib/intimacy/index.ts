import { gameMinutes, type ClockTime } from '../gameClock';
import { registerKissListener } from './kiss';
import { longingPass } from './longing';
import { registerRendezvousListener, rendezvousPass } from './rendezvous';
import { trystPass } from './tryst';

// ─── Intimacy: the periodic pass ─────────────────────────────────────────────
//
// Side-effect module, imported by server/index.ts like giftEngine and
// milestonesEngine (later tasks register their `conversation:ended` /
// `intimacy:*` listeners here). The periodic pass runs from the tick loop every
// 10 game minutes inside one transaction (engine/tick.ts), next to milestones.

// A warm conversation can end in a kiss (kiss.ts). The listener registers on import,
// like milestonesEngine's; later tasks add theirs next to it.
registerKissListener();
// A lover's invitation is answered on the asker's conversation:ended (rendezvous.ts, adult layer).
registerRendezvousListener();

/**
 * One pass: longing first (the rendezvous pass reads it), then invitations, then
 * the evenings they led to (an agreed pair is settled the same tick it is agreed).
 * Suspicion and pregnancy join it later.
 */
export function intimacyTick(time: ClockTime): void {
  longingPass(gameMinutes(time));
  rendezvousPass(time);
  trystPass(time);
}
