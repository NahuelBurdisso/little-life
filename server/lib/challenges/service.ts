import { emitter } from '../../engine/emitter';
import { HISTORY_CAP, MAX_ACTIVE_CHALLENGES, type Challenge, type ChallengeKind } from './catalog';
import { beginChallenge } from './evaluate';
import { readTownSnapshot } from './snapshot';
import { loadStore, saveStore, type ChallengeStore } from './store';
import { buildOffers, type Rng } from './suggest';

/**
 * What the `challenges` router does: read the world's challenges (building
 * today's offers on the way when they are stale), accept an offer, abandon an
 * active one. Every change announces itself on the `challenges` channel.
 */

export interface ChallengeView {
  nowMinute: number;
  offers: Challenge[];
  active: Challenge[];
  history: Challenge[];
  maxActive: number;
}

export type ChallengeResult = { ok: true; challenge: Challenge } | { ok: false; reason: string };

function announce(): void {
  emitter.markDirty('challenges');
  emitter.flushChannel('challenges');
}

/**
 * Rebuild the offers when they were made for another game day (or never).
 * A new day brings a new menu: the pair who were sweet on each other on day 3
 * may be a couple by day 5. Returns whether it rebuilt.
 */
export function refreshOffers(store: ChallengeStore, rng: Rng = Math.random, force = false): boolean {
  const snap = readTownSnapshot(store.handsOnCount);
  if (!snap) return false;
  if (!force && store.offersDay === snap.day) return false;
  const running = new Set<ChallengeKind>(store.active.map((c) => c.kind));
  store.offers = buildOffers(snap, rng, () => `c${store.nextId++}`, running);
  store.offersDay = snap.day;
  return true;
}

export function getChallengeView(rng: Rng = Math.random): ChallengeView | null {
  const store = loadStore();
  if (!store) return null;
  if (refreshOffers(store, rng)) saveStore(store);
  const snap = readTownSnapshot(store.handsOnCount);
  return {
    nowMinute: snap?.nowMinute ?? 0,
    offers: store.offers,
    active: store.active,
    history: store.history,
    maxActive: MAX_ACTIVE_CHALLENGES,
  };
}

export function chooseChallenge(id: string): ChallengeResult {
  const store = loadStore();
  if (!store) return { ok: false, reason: 'No town yet' };
  const offer = store.offers.find((c) => c.id === id);
  if (!offer) return { ok: false, reason: 'That offer is gone — the list was refreshed' };
  if (store.active.length >= MAX_ACTIVE_CHALLENGES) {
    return { ok: false, reason: `You already have ${MAX_ACTIVE_CHALLENGES} challenges running` };
  }
  if (store.active.some((c) => c.kind === offer.kind)) return { ok: false, reason: 'You are already running one like it' };
  const snap = readTownSnapshot(store.handsOnCount);
  if (!snap) return { ok: false, reason: 'No town yet' };
  const started = beginChallenge(offer, snap);
  store.offers = store.offers.filter((c) => c.id !== id);
  store.active = [...store.active, started];
  saveStore(store);
  announce();
  return { ok: true, challenge: started };
}

/** Give up on an active challenge: it goes to the history as abandoned, with no feed row. */
export function abandonChallenge(id: string): ChallengeResult {
  const store = loadStore();
  if (!store) return { ok: false, reason: 'No town yet' };
  const c = store.active.find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'No such challenge running' };
  const snap = readTownSnapshot(store.handsOnCount);
  const done: Challenge = { ...c, status: 'abandoned', endedAt: snap?.nowMinute ?? c.startedAt, outcome: 'Abandoned.' };
  store.active = store.active.filter((x) => x.id !== id);
  store.history = [done, ...store.history].slice(0, HISTORY_CAP);
  saveStore(store);
  announce();
  return { ok: true, challenge: done };
}
