/**
 * Reciprocity: kindness comes back, and ingratitude is noticed.
 *
 * Why this exists. The favour ledger (lib/favorEngine.ts) has been fed by every
 * visit, loan, gift, round and fire bucket since the social calls and the
 * gatherings, but its only reader was a few points of social score: nobody ever
 * paid a kindness back, and nobody minded when they didn't. Two halves:
 *
 *   - the debt brings people (pickCallers.ts `gratitude`, produce.ts `returning`):
 *     someone who owes the target comes a little more readily, and the feed row and
 *     the target's memory say that is why (kinds.ts `warmVisit`, effects.ts `feed`);
 *   - an ordeal is a test: when X has a bad stretch of their own (ill, grieving,
 *     burned out, in debt), the close tie who owes X most and never came — no call,
 *     not at the funeral or the fire with them — is remembered for it, once:
 *     "after all I did for her". That is a slight like a skipped funeral: a
 *     relationship event (`ingratitude`) the factions read (lib/factions).
 *
 * In memory, per world (cleared by worldCaches.ts through index.ts). The ordeals
 * are a few days long; a restart in the middle forgets one, which only means an
 * ingratitude that goes unnoticed.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents } from '../../db/schema';
import { favorsOwed } from '../favorEngine';
import { logActivity } from '../activityLogger';
import { gatheringRecords } from '../gatherings/engine';
import { excused, regard } from '../gatherings/common';
import { callsMadeTo } from './engine';
import { feel, firstOf, nameOf, remember } from './effects';
import { gatherCandidates } from './ties';

const HOUR = 60;
const DAY = 24 * HOUR;

export const RECIPROCITY = {
  /** Favours owed before staying away from someone's ordeal reads as ingratitude. */
  INGRATITUDE_MIN_OWED: 3,
  /** The ordeal is judged this long after it began: time enough for anyone to come. */
  JUDGE_AFTER_MIN: 2 * DAY,
  /** A pair's ingratitude is held against them at most once in this long. */
  PAIR_COOLDOWN_MIN: 20 * DAY,
  /** The creditor's own regard for the debtor at or above this: someone they counted on. */
  CLOSE_REGARD: 30,
} as const;

export type OrdealKind = 'sick' | 'grieving' | 'fire' | 'in_debt';

/** The ordeal, in the creditor's own words and in the feed's. */
const ORDEAL_PHRASE: Record<OrdealKind, { me: string; them: (name: string) => string }> = {
  sick: { me: 'when I was ill', them: (n) => `when ${n} was ill` },
  grieving: { me: 'when I was grieving', them: (n) => `when ${n} was grieving` },
  fire: { me: 'when the fire came', them: (n) => `when the fire came to ${n}'s door` },
  in_debt: { me: 'when I had nothing', them: (n) => `when ${n} had nothing` },
};

interface Ordeal {
  kind: OrdealKind;
  sinceMin: number;
  dueMin: number;
}

const ordeals = new Map<number, Ordeal>();
const lastIngratitude = new Map<string, number>();
const tally = { favoursReturned: 0, ingratitude: 0 };

/** Kindnesses returned and ingratitudes noticed since the last clear (scripts/soak.ts). */
export function reciprocityTally(): { favoursReturned: number; ingratitude: number } {
  return { ...tally };
}

/** A caller came because they owed the target (kinds.ts `warmVisit`). */
export function noteFavourReturned(): void {
  tally.favoursReturned++;
}

export function clearReciprocity(): void {
  ordeals.clear();
  lastIngratitude.clear();
  tally.favoursReturned = 0;
  tally.ingratitude = 0;
}

/**
 * Something hard has happened to `agentId`: the first such stretch is the one
 * judged (a second illness inside the window doesn't restart the clock).
 */
export function noteOrdeal(agentId: number, kind: OrdealKind, nowMin: number): void {
  if (ordeals.has(agentId)) return;
  ordeals.set(agentId, { kind, sinceMin: nowMin, dueMin: nowMin + RECIPROCITY.JUDGE_AFTER_MIN });
}

export interface DebtorCandidate {
  id: number;
  /** Favours they owe the one in trouble. */
  owes: number;
  /** The creditor's regard for them. */
  regard: number;
  /** Holds a kin tie to the creditor (spouse, partner, family, household). */
  kin: boolean;
  /** Came: a call made, or there at the same gathering. */
  came: boolean;
  /** Ill, jailed, depressed or gone: nobody holds that against them. */
  excused: boolean;
  /** Their ingratitude to this creditor was already noticed recently. */
  onCooldown: boolean;
}

/**
 * Pure: the ungrateful one, if any — the close tie who owes most among those
 * who stayed away without cause. One per ordeal, so a bad week makes one story,
 * not a list of grudges.
 */
export function pickUngrateful(cands: readonly DebtorCandidate[]): number | null {
  const best = cands
    .filter((c) => c.owes >= RECIPROCITY.INGRATITUDE_MIN_OWED && !c.came && !c.excused && !c.onCooldown
      && (c.kin || c.regard >= RECIPROCITY.CLOSE_REGARD))
    .sort((a, b) => b.owes - a.owes || b.regard - a.regard || a.id - b.id)[0];
  return best?.id ?? null;
}

function isActive(id: number): boolean {
  return db.select({ a: agents.is_active }).from(agents).where(eq(agents.id, id)).get()?.a === true;
}

const KIN = new Set(['spouse', 'partner', 'fiance', 'family', 'housemate']);

/** Judge every ordeal that has run its course. Hourly, in a transaction (socialCallsHourly). */
export function reciprocityHourly(nowMin: number): void {
  for (const [creditor, o] of [...ordeals]) {
    if (nowMin < o.dueMin) continue;
    ordeals.delete(creditor);
    if (!isActive(creditor)) continue;
    judgeOrdeal(creditor, o, nowMin);
  }
}

function judgeOrdeal(creditor: number, o: Ordeal, nowMin: number): void {
  const came = new Set(callsMadeTo(creditor, undefined, o.sinceMin).map((r) => r.callerId));
  // Being there with them counts: at the funeral they mourned at, at their fire.
  for (const r of gatheringRecords(undefined, o.sinceMin)) {
    if (r.attended.includes(creditor) || r.hostIds.includes(creditor)) for (const id of r.attended) came.add(id);
  }
  const cands: DebtorCandidate[] = gatherCandidates(creditor)
    .filter((c) => c.age >= 16)
    .map((c) => ({
      id: c.id,
      owes: favorsOwed(c.id, creditor),
      regard: regard(creditor, c.id),
      kin: c.ties.some((t) => KIN.has(t)),
      came: came.has(c.id),
      excused: excused(c.id),
      onCooldown: (lastIngratitude.get(`${creditor}>${c.id}`) ?? -Infinity) > nowMin - RECIPROCITY.PAIR_COOLDOWN_MIN,
    }));
  const debtor = pickUngrateful(cands);
  if (debtor == null) return;
  lastIngratitude.set(`${creditor}>${debtor}`, nowMin);
  tally.ingratitude++;
  const when = ORDEAL_PHRASE[o.kind];
  feel(creditor, debtor, 'ingratitude', `${nameOf(debtor)} never came ${when.them(nameOf(creditor))}`, {
    fromCaller: { friendship: -6, trust: -4 }, fromTarget: {}, sentiment: -0.5,
  });
  remember(creditor, `After all I did for ${firstOf(debtor)}, they never once came to see me ${when.me}.`, -0.6, 7, debtor);
  logActivity({
    type: 'social_call',
    initiator: creditor,
    target: debtor,
    // social_call base 0.5: ingratitude sits at 0.55.
    severity: 0.17,
    templateData: { description: `${nameOf(creditor)} did a great deal for ${nameOf(debtor)} — and ${firstOf(debtor)} never came ${when.them(firstOf(creditor))}.` },
    metadata: { beat: 'ingratitude', callKind: 'ingratitude' },
  });
}
