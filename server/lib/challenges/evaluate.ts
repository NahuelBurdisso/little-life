import { emitter } from '../../engine/emitter';
import { logActivity } from '../activityLogger';
import { ENGAGED_TAG, MARRIED_TAG } from '../marriage';
import {
  BEST_FRIEND_AT, CHALLENGE_KINDS, FRIENDS_AT, HISTORY_CAP, MINUTES_PER_DAY, PARTNERS_ROMANCE,
  RIVALS_AT, SCANDAL_SECRETS, SCANDAL_WINDOW_MINUTES,
  agentOf, firstName, guardianDeadline, pairKey, pairOf,
  type Challenge, type ChallengeBaseline, type ChallengeProgress, type SnapAgent, type TownSnapshot,
} from './catalog';
import { loadStore, saveStore, type ChallengeStore } from './store';
import { readTownSnapshot } from './snapshot';

/**
 * Settling challenges: once per game hour (engine/tick.ts), every active
 * challenge is checked against a fresh snapshot of the town.
 *
 * STATE, not events. "Marry X and Y" asks whether their row carries the
 * `married` tag, not whether a `wedding` event fired: a wedding that happened
 * while the evaluator was down, in a phase that errored, or an hour before the
 * check is still a wedding. The only history a check keeps is in the
 * challenge's `baseline` (who was already dead, which secrets were already out
 * when it began, and when each new one was first seen).
 *
 * An hour is fine grain for goals measured in days, and it keeps the cost at a
 * handful of small queries per game hour.
 */

export interface Verdict {
  status: 'active' | 'completed' | 'failed' | 'expired';
  progress: ChallengeProgress;
  /** Updated baseline when the check learned something (scandal's first sightings). */
  baseline?: ChallengeBaseline;
  /** Why it ended, in a sentence ("Ada and Tom are married."). */
  outcome?: string;
}

type Check = (c: Challenge, snap: TownSnapshot) => Verdict;

/** Statuses that count as "fallen out": feud's check, and what an aim to sunder refuses. */
export const HOSTILE = new Set(['rivals', 'enemies', 'estranged']);

const round = (n: number) => Math.round(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** "Ada died." / "Ada left town." — for a challenge whose resident is gone. */
function goneText(a: SnapAgent | undefined, snap: TownSnapshot, id: number): string {
  const name = firstName(snap, id);
  return a?.dead ? `${name} died.` : `${name} left town.`;
}

/** The first of `ids` no longer in town, or null. */
function firstGone(snap: TownSnapshot, ids: number[]): number | null {
  for (const id of ids) if (!agentOf(snap, id)?.active) return id;
  return null;
}

function hasTag(tags: string[], tag: string): boolean {
  return tags.includes(tag);
}

const matchmaker: Check = (c, snap) => {
  const [x, y] = c.agentIds;
  const p = pairOf(snap, x, y);
  const names = `${firstName(snap, x)} and ${firstName(snap, y)}`;
  if (hasTag(p.tags, MARRIED_TAG)) {
    return { status: 'completed', progress: { value: 100, target: 100, label: 'married' }, outcome: `${names} are married.` };
  }
  // A resident who is gone can't marry; checked after the tag, so a wedding the
  // same hour as a death still counts.
  const gone = firstGone(snap, [x, y]);
  let progress: ChallengeProgress;
  if (hasTag(p.tags, ENGAGED_TAG)) progress = { value: 80, target: 100, label: 'engaged — the wedding is coming' };
  else if (p.status === 'partners') progress = { value: 60, target: 100, label: 'a couple — waiting for a proposal' };
  else {
    progress = {
      value: round(clamp(p.romanceMin / PARTNERS_ROMANCE, 0, 1) * 50),
      target: 100,
      // Both sides must pass the bar, and the warmer one is usually far ahead
      // (the offer picked them for it): show both, or "romance 4" reads as
      // though they were never sweet on each other.
      label: `romance ${round(p.romanceMax)} and ${round(p.romanceMin)} (both need ${PARTNERS_ROMANCE})`,
    };
  }
  if (gone != null) return { status: 'failed', progress, outcome: goneText(agentOf(snap, gone), snap, gone) };
  if (p.status === 'estranged') return { status: 'failed', progress, outcome: `${names} are estranged for good.` };
  return { status: 'active', progress };
};

const peacemaker: Check = (c, snap) => {
  const [x, y] = c.agentIds;
  const f = pairOf(snap, x, y).friendship;
  // The bar spans the whole friendship scale up to the goal (-100 → 40).
  const progress = {
    value: round(clamp(f + 100, 0, FRIENDS_AT + 100)),
    target: FRIENDS_AT + 100,
    label: `friendship ${round(f)} → ${FRIENDS_AT}`,
  };
  const gone = firstGone(snap, [x, y]);
  if (gone != null) return { status: 'failed', progress, outcome: goneText(agentOf(snap, gone), snap, gone) };
  if (f >= FRIENDS_AT) {
    return { status: 'completed', progress, outcome: `${firstName(snap, x)} and ${firstName(snap, y)} are friends now.` };
  }
  return { status: 'active', progress };
};

function elapsedProgress(c: Challenge, snap: TownSnapshot, noun: string): ChallengeProgress {
  const start = c.startedAt ?? snap.nowMinute;
  const total = Math.max(1, Math.round(((c.deadline ?? start) - start) / MINUTES_PER_DAY));
  const done = clamp(Math.floor((snap.nowMinute - start) / MINUTES_PER_DAY), 0, total);
  return { value: done, target: total, label: `${done} of ${total} days ${noun}` };
}

const guardian: Check = (c, snap) => {
  const before = new Set(c.baseline?.deadIds ?? []);
  const progress = elapsedProgress(c, snap, 'without a death');
  const died = snap.agents.find((a) => a.dead && !before.has(a.id));
  if (died) return { status: 'failed', progress, outcome: `${firstName(snap, died.id)} died.` };
  return { status: 'active', progress };
};

/** Most sightings inside any window of `span` minutes. */
function densestWindow(minutes: number[], span: number): number {
  const sorted = [...minutes].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] >= span) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

const scandal: Check = (c, snap) => {
  const before = new Set(c.baseline?.publicIds ?? []);
  const revealedAt = { ...(c.baseline?.revealedAt ?? {}) };
  let learned = false;
  for (const id of snap.publicSecretIds) {
    if (before.has(id) || revealedAt[String(id)] != null) continue;
    // First seen now. `revealed_at` on the fact is wall-clock ms, useless as
    // game time, and an hour of latency is nothing against a day-long window.
    revealedAt[String(id)] = snap.nowMinute;
    learned = true;
  }
  const baseline = learned ? { ...c.baseline, revealedAt } : undefined;
  const times = Object.values(revealedAt);
  const recent = times.filter((t) => snap.nowMinute - t < SCANDAL_WINDOW_MINUTES).length;
  const progress = { value: recent, target: SCANDAL_SECRETS, label: `${recent} of ${SCANDAL_SECRETS} secrets out in the last day` };
  if (densestWindow(times, SCANDAL_WINDOW_MINUTES) >= SCANDAL_SECRETS) {
    return {
      status: 'completed',
      progress: { ...progress, value: Math.max(recent, SCANDAL_SECRETS) },
      baseline,
      outcome: `${SCANDAL_SECRETS} secrets became common knowledge in one day.`,
    };
  }
  return { status: 'active', progress, baseline };
};

const handsOff: Check = (c, snap) => {
  const start = c.baseline?.hands ?? { actionId: snap.lastPlayerActionId, handsOn: snap.handsOnCount };
  const progress = elapsedProgress(c, snap, 'hands off');
  if (snap.lastPlayerActionId > start.actionId || snap.handsOnCount > start.handsOn) {
    return { status: 'failed', progress, outcome: 'You meddled.' };
  }
  return { status: 'active', progress };
};

const fullHouse: Check = (c, snap) => {
  const target = c.target ?? 0;
  const n = snap.agents.filter((a) => a.active).length;
  const progress = { value: n, target, label: `${n} of ${target} residents` };
  if (n >= target) return { status: 'completed', progress, outcome: `The town has ${n} residents.` };
  return { status: 'active', progress };
};

function isEngagedOrMarried(tags: string[]): boolean {
  return tags.includes(ENGAGED_TAG) || tags.includes(MARRIED_TAG);
}

const firstEngagement: Check = (c, snap) => {
  const before = new Set(c.baseline?.engagedPairs ?? []);
  const fresh = snap.pairs.find((p) => isEngagedOrMarried(p.tags) && !before.has(pairKey(p.a, p.b)));
  if (fresh) {
    return {
      status: 'completed',
      progress: { value: 1, target: 1, label: 'engaged' },
      outcome: `${firstName(snap, fresh.a)} and ${firstName(snap, fresh.b)} are engaged.`,
    };
  }
  const couples = snap.pairs.filter(
    (p) => p.status === 'partners' && !isEngagedOrMarried(p.tags) && agentOf(snap, p.a)?.active && agentOf(snap, p.b)?.active,
  ).length;
  const label = couples === 0 ? 'no couple in town yet' : couples === 1 ? '1 couple could propose' : `${couples} couples could propose`;
  return { status: 'active', progress: { value: 0, target: 1, label } };
};

const feud: Check = (c, snap) => {
  let closest: { f: number; a: number; b: number } | null = null;
  for (const [x, y] of c.baseline?.friendPairs ?? []) {
    if (firstGone(snap, [x, y]) != null) continue;
    const p = pairOf(snap, x, y);
    if (p.friendship <= RIVALS_AT || HOSTILE.has(p.status)) {
      return {
        status: 'completed',
        progress: { value: 1, target: 1, label: 'a feud' },
        outcome: `${firstName(snap, x)} and ${firstName(snap, y)} fell out.`,
      };
    }
    if (!closest || p.friendship < closest.f) closest = { f: p.friendship, a: x, b: y };
  }
  const span = FRIENDS_AT - RIVALS_AT;
  const progress = closest
    ? {
        value: round(clamp(FRIENDS_AT - closest.f, 0, span)),
        target: span,
        label: `closest: ${firstName(snap, closest.a)} & ${firstName(snap, closest.b)} at ${round(closest.f)} → ${RIVALS_AT}`,
      }
    : { value: 0, target: span, label: 'no friendships left to break' };
  return { status: 'active', progress };
};

const recluse: Check = (c, snap) => {
  const [x] = c.agentIds;
  let best: { f: number; id: number } | null = null;
  for (const p of snap.pairs) {
    if (p.a !== x && p.b !== x) continue;
    const other = p.a === x ? p.b : p.a;
    if (!agentOf(snap, other)?.active) continue;
    if (!best || p.friendship > best.f) best = { f: p.friendship, id: other };
  }
  const f = best?.f ?? 0;
  const progress = {
    value: round(clamp(f, 0, BEST_FRIEND_AT)),
    target: BEST_FRIEND_AT,
    label: best ? `closest tie ${round(f)} / ${BEST_FRIEND_AT} (${firstName(snap, best.id)})` : `no friends yet (0 / ${BEST_FRIEND_AT})`,
  };
  if (firstGone(snap, [x]) != null) return { status: 'failed', progress, outcome: goneText(agentOf(snap, x), snap, x) };
  if (best && f >= BEST_FRIEND_AT) {
    return { status: 'completed', progress, outcome: `${firstName(snap, x)} has a best friend: ${firstName(snap, best.id)}.` };
  }
  return { status: 'active', progress };
};

/**
 * First baby: a child born anywhere in town since the challenge began (born
 * state, like everything here: a child in the table who wasn't at the start).
 * Progress counts the couples on the way — expecting is a secret the player
 * can't always see, so the bar shows the married couples who could.
 */
const firstBaby: Check = (c, snap) => {
  const before = new Set(c.baseline?.childIds ?? []);
  const born = (snap.children ?? []).find((k) => !before.has(k.id));
  if (born) {
    const parents = [born.motherId, born.fatherId].filter((id): id is number => id != null).map((id) => firstName(snap, id)).join(' and ');
    return {
      status: 'completed',
      progress: { value: 1, target: 1, label: 'a baby!' },
      outcome: `${parents} welcomed little ${born.name}.`,
    };
  }
  const couples = snap.pairs.filter((p) => p.tags.includes(MARRIED_TAG) && agentOf(snap, p.a)?.active && agentOf(snap, p.b)?.active).length;
  const label = couples === 0 ? 'no married couple in town yet' : couples === 1 ? '1 married couple' : `${couples} married couples`;
  return { status: 'active', progress: { value: 0, target: 1, label } };
};

/**
 * Kingmaker: the resident is mayor. Judged on the chair (economy.job), not on
 * the count's feed row, like every other check. Fails the moment the election
 * it was set for (`target`, a game day) goes to someone else.
 */
const kingmaker: Check = (c, snap) => {
  const [x] = c.agentIds;
  const electionDay = c.target ?? 0;
  const name = firstName(snap, x);
  if (snap.mayorId === x) {
    return { status: 'completed', progress: { value: 2, target: 2, label: 'mayor' }, outcome: `${name} is the mayor.` };
  }
  const onBallot = (snap.candidates ?? []).includes(x);
  const progress: ChallengeProgress = onBallot
    ? { value: 1, target: 2, label: `on the ballot — the town votes on day ${electionDay}` }
    : { value: 0, target: 2, label: `not on the ballot yet — the vote is on day ${electionDay}` };
  if (firstGone(snap, [x]) != null) return { status: 'failed', progress, outcome: goneText(agentOf(snap, x), snap, x) };
  const last = snap.lastElection;
  if (last && last.electionDay >= electionDay && last.winnerId !== x) {
    return { status: 'failed', progress, outcome: `${firstName(snap, last.winnerId)} won the election.` };
  }
  return { status: 'active', progress };
};

const CHECKS: Record<Challenge['kind'], Check> = {
  matchmaker,
  peacemaker,
  guardian,
  scandal,
  hands_off: handsOff,
  full_house: fullHouse,
  first_engagement: firstEngagement,
  feud,
  recluse,
  first_baby: firstBaby,
  kingmaker,
};

/** What running out the clock means for the kinds where that is the win. */
const SURVIVED: Partial<Record<Challenge['kind'], string>> = {
  guardian: 'Nobody died before the season ended.',
  hands_off: 'Two whole days without lifting a finger.',
};

/**
 * Judge one active challenge. The kind's own check runs first — a goal met in
 * the same hour the deadline passes still counts, and a death in the last hour
 * of Guardian still fails it — and only then does the clock settle it:
 * completed for the "nothing happens" kinds, expired for the rest.
 */
export function evaluateChallenge(c: Challenge, snap: TownSnapshot): Verdict {
  const v = CHECKS[c.kind](c, snap);
  if (v.status !== 'active') return v;
  if (c.deadline != null && snap.nowMinute >= c.deadline) {
    if (CHALLENGE_KINDS[c.kind].survive) {
      return { ...v, status: 'completed', progress: { ...v.progress, value: v.progress.target }, outcome: SURVIVED[c.kind] };
    }
    return { ...v, status: 'expired', outcome: 'Ran out of time.' };
  }
  return v;
}

/**
 * An accepted offer, ready to run: the clock starts now and the baseline
 * records what "new" will be measured against.
 */
export function beginChallenge(offer: Challenge, snap: TownSnapshot): Challenge {
  const startedAt = snap.nowMinute;
  // Kingmaker runs to the end of its election day (the count is at 18:00).
  const deadline = offer.kind === 'guardian'
    ? guardianDeadline(snap)
    : offer.kind === 'kingmaker' && offer.target != null
      ? (offer.target + 1) * MINUTES_PER_DAY
      : startedAt + offer.durationDays * MINUTES_PER_DAY;
  const baseline: ChallengeBaseline = {};
  switch (offer.kind) {
    case 'guardian':
      baseline.deadIds = snap.agents.filter((a) => a.dead).map((a) => a.id);
      break;
    case 'scandal':
      baseline.publicIds = [...snap.publicSecretIds];
      baseline.revealedAt = {};
      break;
    case 'hands_off':
      baseline.hands = { actionId: snap.lastPlayerActionId, handsOn: snap.handsOnCount };
      break;
    case 'first_engagement':
      baseline.engagedPairs = snap.pairs.filter((p) => isEngagedOrMarried(p.tags)).map((p) => pairKey(p.a, p.b));
      break;
    case 'first_baby':
      baseline.childIds = (snap.children ?? []).map((k) => k.id);
      break;
    case 'feud':
      // A feud the player aimed at one pair watches only that pair (offers
      // built from the town's friendships name nobody and watch them all).
      // Otherwise a stranger's quarrel would win the player's goal for them.
      baseline.friendPairs = offer.agentIds.length === 2
        ? [[Math.min(offer.agentIds[0], offer.agentIds[1]), Math.max(offer.agentIds[0], offer.agentIds[1])]]
        : snap.pairs
          .filter((p) => p.friendship >= FRIENDS_AT && agentOf(snap, p.a)?.active && agentOf(snap, p.b)?.active)
          .map((p) => [p.a, p.b] as [number, number]);
      break;
  }
  const started: Challenge = {
    ...offer,
    status: 'active',
    startedAt,
    deadline,
    durationDays: Math.max(1, Math.round((deadline - startedAt) / MINUTES_PER_DAY)),
    baseline,
  };
  started.progress = CHECKS[offer.kind](started, snap).progress;
  return started;
}

// ─── The hourly run (engine/tick.ts) ──────────────────────────────────────────

const FEED_TYPE: Record<'completed' | 'failed' | 'expired', 'challenge_completed' | 'challenge_failed'> = {
  completed: 'challenge_completed',
  failed: 'challenge_failed',
  expired: 'challenge_failed',
};

function logOutcome(c: Challenge): void {
  const def = CHALLENGE_KINDS[c.kind];
  const status = c.status as 'completed' | 'failed' | 'expired';
  const lead = status === 'completed' ? `Challenge complete — ${def.name}` : status === 'expired' ? `Challenge expired — ${def.name}` : `Challenge failed — ${def.name}`;
  logActivity({
    type: FEED_TYPE[status],
    agents: c.agentIds,
    templateData: {
      description: `${lead}: ${c.outcome ?? c.goal}`,
      challenge: c.kind,
      challengeId: c.id,
      status,
      icon: def.icon,
    },
  });
}

/**
 * The winter watch: at each season change, a town that came through a whole
 * winter without a death gets a feed row (the client's "Survived a winter"
 * achievement keys on it). State again: who is dead now vs. who was dead when
 * the season began.
 */
function watchSeason(store: ChallengeStore, snap: TownSnapshot): boolean {
  const deadNow = snap.agents.filter((a) => a.dead).map((a) => a.id);
  const w = store.seasonWatch;
  if (!w) {
    store.seasonWatch = { season: snap.season, fromStart: false, deadIds: deadNow };
    return true;
  }
  if (w.season === snap.season) return false;
  const before = new Set(w.deadIds);
  if (w.fromStart && w.season === 'winter' && snap.deathEnabled && deadNow.every((id) => before.has(id))) {
    logActivity({
      type: 'season_survived',
      templateData: {
        description: 'The town came through the whole winter without losing a soul.',
        season: w.season,
      },
    });
  }
  store.seasonWatch = { season: snap.season, fromStart: true, deadIds: deadNow };
  return true;
}

/**
 * Check every active challenge, move the settled ones to the history with a
 * feed row each, and save. Called inside a transaction once per game hour.
 * Returns the challenges that ended (tests read it).
 */
export function runChallengeChecks(): Challenge[] {
  const store = loadStore();
  if (!store) return [];
  const snap = readTownSnapshot(store.handsOnCount);
  if (!snap) return [];

  let changed = watchSeason(store, snap);
  const ended: Challenge[] = [];
  const stillActive: Challenge[] = [];
  for (const c of store.active) {
    const v = evaluateChallenge(c, snap);
    const next: Challenge = { ...c, progress: v.progress, ...(v.baseline ? { baseline: v.baseline } : {}) };
    if (JSON.stringify(next.progress) !== JSON.stringify(c.progress) || v.baseline) changed = true;
    if (v.status === 'active') {
      stillActive.push(next);
      continue;
    }
    const done: Challenge = { ...next, status: v.status, endedAt: snap.nowMinute, outcome: v.outcome };
    ended.push(done);
    changed = true;
  }
  // Yesterday's offers are rebuilt when the tab next asks (service.ts); tell an
  // open tab to ask, or it shows them until something else moves.
  if (store.offersDay != null && store.offersDay !== snap.day) emitter.markDirty('challenges');
  if (!changed) return [];

  store.active = stillActive;
  store.history = [...ended.reverse(), ...store.history].slice(0, HISTORY_CAP);
  saveStore(store);
  for (const c of ended) logOutcome(c);
  emitter.markDirty('challenges');
  return ended;
}
