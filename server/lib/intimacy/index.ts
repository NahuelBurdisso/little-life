import { db } from '../../db';
import { runGuarded } from '../../engine/runGuarded';
import { gameMinutes, type ClockTime } from '../gameClock';
import { registerKissListener } from './kiss';
import { longingPass } from './longing';
import { pregnancyPass } from './pregnancy';
import { registerRendezvousListener, rendezvousPass } from './rendezvous';
import { registerSuspicionListeners, suspicionPass } from './suspicion';
import { trystPass } from './tryst';

// ─── Intimacy: the periodic pass ─────────────────────────────────────────────
//
// Side-effect module, imported by server/index.ts like giftEngine and
// milestonesEngine (later tasks register their `conversation:ended` /
// `intimacy:*` listeners here). The periodic pass runs from the tick loop every
// 10 game minutes (engine/tick.ts), next to milestones.

// A warm conversation can end in a kiss (kiss.ts). The listener registers on import,
// like milestonesEngine's; later tasks add theirs next to it.
registerKissListener();
// A lover's invitation is answered on the asker's conversation:ended (rendezvous.ts, adult layer).
registerRendezvousListener();
// A partner's empty bed becomes suspicion, a confrontation and (badly ended) a breakup (suspicion.ts, adult layer).
registerSuspicionListeners();

/**
 * One pass, each step guarded and in its own transaction. The state these passes
 * keep (state.ts) is in memory and is NOT undone by a rollback: with one
 * transaction around all five, a throw in the last one rolled back the DB writes
 * of the first four while their in-memory changes (an evening begun, a stay set,
 * an invitation consumed) stayed, so the town and its checkpoint disagreed. Per
 * pass, a failure costs only that pass's own writes, and its neighbours still run.
 *
 * Order: longing first (the rendezvous pass reads it), then invitations, then the
 * evenings they led to (an agreed pair is settled the same tick it is agreed),
 * then, once each game morning, the partners who noticed an empty bed, and last
 * the unwed pregnancies (told to the father, showing, the scandal).
 */
export function intimacyTick(time: ClockTime): void {
  const now = gameMinutes(time);
  const step = (name: string, fn: () => void) => runGuarded(`intimacy.${name}`, () => db.transaction(() => fn()));
  step('longing', () => longingPass(now));
  step('rendezvous', () => rendezvousPass(time));
  step('tryst', () => trystPass(time));
  step('suspicion', () => suspicionPass(time));
  step('pregnancy', () => pregnancyPass(now));
}
