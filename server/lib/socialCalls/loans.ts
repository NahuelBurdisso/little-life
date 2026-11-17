/**
 * Lending money: the one social call that leaves a debt behind.
 *
 * A well-off, warm close friend of someone who has fallen on hard times
 * (`in_debt`, or the night they fall onto the town stipend) walks over and
 * offers a loan. The money moves through economyTransfers (`payResident`), so
 * the money supply the treasury balances stays whole: every dollar the borrower
 * gains the lender loses. The loan is a row in `loans` — a debt has to outlive
 * a restart and travel with a save.
 *
 * Who lends: a warm friend, or one who owes the borrower a kindness (reciprocity).
 *
 * Then it plays out on its own (the hourly sweep, `loansHourly`):
 *   - the borrower back on their feet (cash above the money target plus what
 *     they owe) pays it back: a transfer, a memory each, a warmer friendship and
 *     one feed row;
 *   - still unpaid after LOAN_TERM_DAYS, it sours: the lender's regard and trust
 *     drop, they remember it, and it becomes a `debt` fact the lender knows —
 *     and may gossip about (gossip.ts spreads facts its knowers hold). It can
 *     still be repaid later, and that is a story too;
 *   - a borrower or lender who dies or leaves voids it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents, economy, loans, worldState } from '../../db/schema';
import { CONFIG } from '../constants';
import { payResident } from '../economyTransfers';
import { learnFact } from '../gossip';
import { callRecordsFor } from './engine';
import { favour, feed, feel, firstOf, mood, nameOf, remember, whereIs } from './effects';
import { produceCalls } from './produce';
import { RETURN_MIN } from './pickCallers';
import { favorsOwed } from '../favorEngine';
import { CALL_TOPIC } from './topics';
import type { SocialCall, SocialCallKind } from './types';

const HOUR = 60;
const DAY = 24 * HOUR;

export const LOANS = {
  /** A lender must hold at least this share of the money target... */
  LENDER_RICH_SHARE: 1.3,
  /** ...and be at least this warm. */
  LENDER_MIN_WARMTH: 50,
  /** Lent: the smaller of this share of the money target and half the lender's surplus over it. */
  AMOUNT_TARGET_SHARE: 0.5,
  /** Below this a "loan" is pocket change: no loan. */
  MIN_AMOUNT: 5,
  /** Game days before an unpaid loan sours. */
  TERM_DAYS: 14,
  /** The borrower repays once their cash is at least the money target plus the debt. */
  REPAY_TARGET_SHARE: 1.0,
  /** At most one loan between a pair in this many game days. */
  PAIR_COOLDOWN_DAYS: 10,
} as const;

export function moneyTarget(): number {
  return db.select({ t: worldState.money_target_per_capita }).from(worldState).limit(1).get()?.t ?? CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY;
}

function moneyOf(id: number): number {
  return db.select({ m: economy.money }).from(economy).where(eq(economy.agent_id, id)).get()?.m ?? 0;
}

/** What `lenderMoney` can lend against `target`: 0 when nothing worth lending. */
export function loanAmount(lenderMoney: number, target: number): number {
  const amount = Math.floor(Math.min(target * LOANS.AMOUNT_TARGET_SHARE, (lenderMoney - target) * 0.5));
  return amount >= LOANS.MIN_AMOUNT ? amount : 0;
}

/** Open or overdue loans `borrowerId` owes. */
export function openLoansOf(borrowerId: number): Array<typeof loans.$inferSelect> {
  return db.select().from(loans)
    .where(and(eq(loans.borrower_id, borrowerId), inArray(loans.status, ['open', 'overdue']))).all();
}

export const LEND_MONEY_KIND: SocialCallKind = {
  id: 'lend_money',
  maxPendingPerTarget: 1,
  pairCooldownMin: LOANS.PAIR_COOLDOWN_DAYS * DAY,
  windowMin: DAY,
  // Still short, and not already in someone's debt.
  stillRelevant: (call) => moneyOf(call.targetId) < moneyTarget() * 0.5 && openLoansOf(call.targetId).length === 0,
  topic: () => CALL_TOPIC.lend_money,
  label: (_c, n) => ({ walking: `On the way to offer ${n} a loan`, there: `Offering ${n} a loan` }),
  // Pride is the only way it goes badly, and pride doesn't refuse money it needs.
  judge: () => true,
  consequence(call, r) {
    const caller = nameOf(call.callerId), target = nameOf(call.targetId);
    const amount = loanAmount(moneyOf(call.callerId), moneyTarget());
    const paid = amount > 0 ? payResident(call.callerId, call.targetId, amount, 'loan') : 0;
    if (paid <= 0) {
      // The purse emptied between the promise and the visit: they came anyway.
      feed(call, 'consolation', `${caller} came to help ${target} with money, but had none left to spare.`, 0.1, whereIs(call.callerId));
      return;
    }
    db.insert(loans).values({
      lender_id: call.callerId, borrower_id: call.targetId, amount: paid,
      lent_at_min: r.nowMin, due_at_min: r.nowMin + LOANS.TERM_DAYS * DAY, status: 'open', settled_at_min: null,
    }).run();
    favour(call.callerId, call.targetId, 2);
    mood(call.targetId, 5, 'loan_received', DAY, r.nowMin);
    feel(call.callerId, call.targetId, 'loan', `${caller} lent ${target} $${paid}`, {
      fromCaller: { trust: -1 }, fromTarget: { friendship: 4, trust: 4 }, sentiment: 0.5,
    });
    remember(call.callerId, `I lent ${firstOf(call.targetId)} $${paid} to tide them over. I hope I see it again.`, 0.1, 6, call.targetId);
    remember(call.targetId, `${firstOf(call.callerId)} lent me $${paid} when I had nothing. I must pay it back.`, 0.5, 7, call.callerId);
    feed(call, 'loan', `${caller} lent ${target} $${paid} to see them through hard times.`, 0.5, whereIs(call.callerId));
  },
};

/** A neighbour has fallen on hard times: one well-off warm friend may come with a loan. */
export function onHardTimes(agentId: number, nowMin: number): void {
  if (openLoansOf(agentId).length > 0) return;
  if (callRecordsFor(agentId, 'lend_money', nowMin - 3 * DAY).length > 0) return;
  const target = moneyTarget();
  produceCalls({
    kind: 'lend_money', targetId: agentId, nowMin,
    spec: { ties: ['family', 'best_friend', 'friend'], max: 1, eagerness: 0.9 },
    stagger: { first: 2 * HOUR, spacing: 0, jitter: 4 * HOUR },
    // A cold purse still opens for someone it owes: whoever helped the lender
    // before is lent to even by a lender not warm enough to offer a stranger.
    filter: (c) => (c.warmth >= LOANS.LENDER_MIN_WARMTH || (c.owes ?? 0) >= RETURN_MIN)
      && c.money >= target * LOANS.LENDER_RICH_SHARE && loanAmount(c.money, target) > 0,
  });
}

/** Repayments, souring, and loans nobody is left to settle. Hourly, in a transaction (tick.ts). */
export function loansHourly(nowMin: number): void {
  const live = db.select().from(loans).where(inArray(loans.status, ['open', 'overdue'])).all();
  if (live.length === 0) return;
  const active = new Set(db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().map((r) => r.id));
  const target = moneyTarget();
  for (const loan of live) {
    if (!active.has(loan.borrower_id) || !active.has(loan.lender_id)) {
      db.update(loans).set({ status: 'void', settled_at_min: nowMin }).where(eq(loans.id, loan.id)).run();
      continue;
    }
    const call: SocialCall = {
      id: 0, kind: 'lend_money', callerId: loan.borrower_id, targetId: loan.lender_id,
      createdAtMin: nowMin, notBeforeMin: nowMin, expiresAtMin: nowMin, urgent: false, payload: {}, seatedAtMin: null,
    };
    const lender = nameOf(loan.lender_id), borrower = nameOf(loan.borrower_id);
    if (moneyOf(loan.borrower_id) >= target * LOANS.REPAY_TARGET_SHARE + loan.amount) {
      const paid = payResident(loan.borrower_id, loan.lender_id, loan.amount, 'loan_repayment');
      if (paid < loan.amount) continue;
      db.update(loans).set({ status: 'repaid', settled_at_min: nowMin }).where(eq(loans.id, loan.id)).run();
      // Paying it back settles the debt of gratitude the loan left (the lender's
      // favour of 2, lend_money's consequence) — only what is owed: a borrower who
      // had helped the lender first doesn't put the lender in their debt by repaying.
      favour(loan.borrower_id, loan.lender_id, Math.min(2, favorsOwed(loan.borrower_id, loan.lender_id)));
      const late = loan.status === 'overdue';
      feel(loan.borrower_id, loan.lender_id, 'loan_repaid', `${borrower} paid back ${lender}'s loan`, {
        fromCaller: { friendship: 2 }, fromTarget: { friendship: late ? 2 : 3, trust: late ? 4 : 6 }, sentiment: 0.5,
      });
      remember(loan.lender_id, `${firstOf(loan.borrower_id)} paid back the $${loan.amount} I lent them${late ? ', at long last' : ''}.`, 0.4, 5, loan.borrower_id);
      remember(loan.borrower_id, `I paid ${firstOf(loan.lender_id)} back the $${loan.amount} they lent me. It's a weight off.`, 0.5, 5, loan.lender_id);
      feed(call, 'loan_repaid', `${borrower} paid back the $${loan.amount} ${lender} lent them${late ? ', long overdue' : ''}.`, 0.3);
      continue;
    }
    if (loan.status === 'open' && nowMin >= loan.due_at_min) {
      db.update(loans).set({ status: 'overdue' }).where(eq(loans.id, loan.id)).run();
      feel(loan.lender_id, loan.borrower_id, 'loan_unpaid', `${borrower} never paid back ${lender}'s loan`, {
        fromCaller: { friendship: -6, trust: -10 }, fromTarget: {}, sentiment: -0.5,
      });
      mood(loan.lender_id, -3, 'loan_unpaid', DAY, nowMin);
      remember(loan.lender_id, `Two weeks, and ${firstOf(loan.borrower_id)} still hasn't paid back the $${loan.amount} I lent them. Not a word about it.`, -0.5, 7, loan.borrower_id);
      // A secret the lender holds, and may let slip (createFact dedupes: learnFact adds the knower to an existing one).
      learnFact('debt', loan.borrower_id, loan.lender_id, 2, [loan.lender_id], 'observed', { detail: `$${loan.amount} lent and never repaid` });
      feed({ ...call, callerId: loan.lender_id, targetId: loan.borrower_id }, 'loan_unpaid',
        `${lender} is still waiting for ${borrower} to pay back the $${loan.amount} they lent.`, 0.6);
    }
  }
}
