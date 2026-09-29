import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { simSnapshots, worldState } from '../../db/schema';
import { loadSnapshots, saveSnapshots } from '../simSnapshots';
import { decodeStamp, encodeStamp, type SnapshotStore } from '../snapshotCodec';
import {
  clearPerWorldCaches,
  persistedStoreKeys,
  restoreWorldCaches,
  saveWorldCaches,
} from '../worldCaches';
import { hobbySnapshotStore, getHobbyLevel, practiceHobby, clearHobbySkills } from '../../lib/hobbyEngine';
import { favorSnapshotStore, getNetFavorBalance, initFavorTracking, clearFavorLedger } from '../../lib/favorEngine';
import {
  moodMomentumSnapshotStore,
  getMoodMomentum,
  sampleMood,
  processDayEnd,
  clearMoodTrackers,
} from '../../lib/moodMomentum';
import { personalityBaselineSnapshotStore, clearPersonalityBaselines } from '../../lib/personalityDrift';
import { hungerSnapshotStore, hungerZeroMinutes, updateHungerTracking, clearHungerTracking } from '../../lib/lifeEventsEngine';
import { statesTrackersSnapshotStore, clearStatesTrackers } from '../systems/states';
import { tensionSnapshotStore, resetCascade } from '../../lib/cascade';
import { TensionTracker } from '../../lib/cascade/TensionTracker';
import { simEvents } from '../../lib/simEvents';
import type { PersonalityProfile } from '../../lib/personality';

// No such agents: the stores are keyed by id only, and the level-up activity
// log looks the name up and skips a missing agent.
const A = 912_001;
const B = 912_002;

function ensureWorld(): number {
  const existing = db.select({ id: worldState.id }).from(worldState).get();
  if (existing) return existing.id;
  return db.insert(worldState).values({
    time: { day: 3, hour: 10, minute: 0, totalTicks: 3000, seasonDay: 3, season: 'spring' },
    day_phase: 'morning',
    weather: 'sunny',
    weather_duration: 120,
    tick_speed: 1,
    is_paused: true,
    last_tick_completed: 0,
    current_tick_phase: 0,
    tick_id: 'test',
    pending_transitions: [],
    tax_pool: 0,
    map_width: 40,
    map_height: 30,
    collision_grid: '',
  }).returning({ id: worldState.id }).get().id;
}

/** What survives a trip through the TEXT column. */
function throughJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

/** serialize → JSON → restore → serialize must be a fixed point. */
function expectRoundTrip(store: SnapshotStore): unknown {
  const before = store.serialize();
  store.restore(throughJson(before));
  expect(store.serialize()).toEqual(before);
  return before;
}

function profile(v: number): PersonalityProfile {
  return {
    honesty: v, aggression: v, warmth: v, impulsiveness: v, vanity: v,
    curiosity: v, loyalty: v, morality: v, sensuality: v, neuroticism: v,
  };
}

const STATE_TRACKERS_FIXTURE = {
  stressRemovedAt: { [A]: 1200 },
  gamblingCooldowns: { [`${A}-${B}`]: 900 },
  lowMoodSince: { [A]: 1300 },
  lowSocialSince: { [B]: 1100 },
  sickRecoveredAt: { [B]: 40 },
  drunkHistory: { [A]: [100, 1540, 2980] },
  alcoholRecoveredAt: { [B]: 777 },
  brokeSince: { [A]: 12 },
  gamblingHistory: { [B]: [5, 6] },
};

describe('snapshot codec', () => {
  it('writes "never" stamps as null and reads them back as -Infinity', () => {
    expect(encodeStamp(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(encodeStamp(42)).toBe(42);
    expect(decodeStamp(null)).toBe(Number.NEGATIVE_INFINITY);
    expect(decodeStamp('junk')).toBe(Number.NEGATIVE_INFINITY);
    expect(decodeStamp(42)).toBe(42);
  });

  it('has one row key per persisted store', () => {
    const keys = persistedStoreKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining([
      'hobbies', 'favors', 'tension', 'moodMomentum', 'personalityBaselines', 'stateTrackers', 'hungerZero',
    ]));
  });
});

describe('store round trips', () => {
  beforeAll(() => initFavorTracking());

  it('hobby skills keep level, XP and the practice stamp', () => {
    clearHobbySkills();
    for (let i = 0; i < 40; i++) practiceHobby(A, 'fish', 100 + i * 60);
    practiceHobby(B, 'cook', 50);
    const level = getHobbyLevel(A, 'fish');
    expect(level).toBeGreaterThan(0);

    const saved = expectRoundTrip(hobbySnapshotStore);
    clearHobbySkills();
    expect(getHobbyLevel(A, 'fish')).toBe(0);
    hobbySnapshotStore.restore(throughJson(saved));
    expect(getHobbyLevel(A, 'fish')).toBe(level);
    expect(getHobbyLevel(B, 'cook')).toBe(0); // one session: XP only
    expect(hobbySnapshotStore.serialize()).toEqual(saved);
  });

  it('hobby restore skips unknown hobbies and malformed skills', () => {
    hobbySnapshotStore.restore({
      [A]: { fishing: { level: 7, experience: 1, lastPracticed: null }, juggling: { level: 99, experience: 0 } },
      [B]: { cooking: { level: 'high' } },
      notAnId: { fishing: { level: 1, experience: 0 } },
    });
    expect(getHobbyLevel(A, 'fish')).toBe(7);
    expect(hobbySnapshotStore.serialize()).toEqual({
      [A]: { fishing: { level: 7, experience: 1, lastPracticed: null } },
    });
  });

  it('favor ledger keeps both sides of every balance', () => {
    clearFavorLedger();
    simEvents.emit('gift:given', { giverId: A, receiverId: B });
    simEvents.emit('gift:given', { giverId: A, receiverId: B });
    simEvents.emit('gift:given', { giverId: B, receiverId: A });
    expect(getNetFavorBalance(A, B)).toBe(1);

    const saved = expectRoundTrip(favorSnapshotStore);
    clearFavorLedger();
    expect(getNetFavorBalance(A, B)).toBe(0);
    favorSnapshotStore.restore(throughJson(saved));
    expect(getNetFavorBalance(A, B)).toBe(1);
    expect(getNetFavorBalance(B, A)).toBe(-1);
  });

  it('mood momentum keeps momentum, streak and the day in progress', () => {
    clearMoodTrackers();
    for (let i = 0; i < 5; i++) sampleMood(A, 90);
    processDayEnd(A); // good day → positive momentum
    sampleMood(A, 20); // today's first sample
    const momentum = getMoodMomentum(A);
    expect(momentum).toBeGreaterThan(0);

    const saved = expectRoundTrip(moodMomentumSnapshotStore);
    clearMoodTrackers();
    expect(getMoodMomentum(A)).toBe(0);
    moodMomentumSnapshotStore.restore(throughJson(saved));
    expect(getMoodMomentum(A)).toBe(momentum);
    expect(moodMomentumSnapshotStore.serialize()).toEqual({
      [A]: { moodSamples: [20], momentum, streak: 1 },
    });
  });

  it('personality baselines keep complete profiles and drop partial ones', () => {
    clearPersonalityBaselines();
    personalityBaselineSnapshotStore.restore({
      [A]: profile(40),
      [B]: { honesty: 50 }, // partial: would disable the cap on nine axes
    });
    expect(personalityBaselineSnapshotStore.serialize()).toEqual({ [A]: profile(40) });
    expectRoundTrip(personalityBaselineSnapshotStore);
  });

  it('states trackers keep every map, lists included', () => {
    clearStatesTrackers();
    statesTrackersSnapshotStore.restore(throughJson(STATE_TRACKERS_FIXTURE));
    expect(statesTrackersSnapshotStore.serialize()).toEqual(STATE_TRACKERS_FIXTURE);
    expectRoundTrip(statesTrackersSnapshotStore);

    // Malformed entries are skipped, the rest of the blob still loads.
    statesTrackersSnapshotStore.restore({ brokeSince: { [A]: 'x', [B]: 5 }, drunkHistory: { [A]: [1, 'x', 3] } });
    const out = statesTrackersSnapshotStore.serialize() as Record<string, unknown>;
    expect(out.brokeSince).toEqual({ [B]: 5 });
    expect(out.drunkHistory).toEqual({ [A]: [1, 3] });
    expect(out.lowMoodSince).toEqual({});
  });

  it('starvation counters survive', () => {
    clearHungerTracking();
    updateHungerTracking(A, 0, 2000);
    expectRoundTrip(hungerSnapshotStore);
    const saved = throughJson(hungerSnapshotStore.serialize());
    clearHungerTracking();
    hungerSnapshotStore.restore(saved);
    expect(hungerZeroMinutes.get(A)).toBe(2000);
  });

  it('tension keeps value, grievances, snap count and the snap cooldown', () => {
    const p = profile(50);
    const tracker = new TensionTracker();
    tracker.addTension(A, 150, { event: 'need:critical', description: 'starving', tick: 10, agentInvolved: 'Omar' });
    tracker.recordSnap(A, 500); // value → 20, cooldown until 700
    tracker.addTension(A, 200, { event: 'x', description: 'y', tick: 20 });
    tracker.addTension(B, 200, { event: 'x', description: 'never snapped', tick: 30 });

    const restored = new TensionTracker();
    restored.restore(throughJson(tracker.serialize()));
    expect(restored.serialize()).toEqual(tracker.serialize());
    expect(restored.getTension(A)).toBe(220);
    expect(restored.getSources(B)).toEqual([{ event: 'x', description: 'never snapped', tick: 30 }]);
    // The cooldown stamp came back: no immediate second snap after a restart...
    expect(restored.shouldSnap(A, p, 600)).toBe(false);
    expect(restored.shouldSnap(A, p, 700)).toBe(true);
    // ...and "never snapped" is still -Infinity, not null → 0.
    expect(restored.shouldSnap(B, p, 0)).toBe(true);
  });
});

describe('sim_snapshots table', () => {
  let worldId = 0;
  const rows = () => db.select().from(simSnapshots).all();

  beforeEach(() => {
    worldId = ensureWorld();
    db.delete(simSnapshots).run();
  });

  function memoryStore(key: string, version = 1): SnapshotStore & { value: unknown } {
    return {
      key,
      version,
      value: undefined as unknown,
      serialize() { return this.value; },
      restore(data) { this.value = data; },
    };
  }

  it('writes one row per store, stamped with the world and its clock', () => {
    const s = memoryStore('t1');
    s.value = { a: 1 };
    expect(saveSnapshots([s])).toBe(1);
    const [row] = rows();
    expect(row).toMatchObject({ key: 't1', world_id: worldId, version: 1, data: { a: 1 } });
    expect(Number.isInteger(row.game_minute)).toBe(true);

    // Upsert, not append.
    s.value = { a: 2 };
    saveSnapshots([s]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].data).toEqual({ a: 2 });
  });

  it('skips a store with nothing to say and survives one that throws', () => {
    const empty = memoryStore('empty');
    const broken: SnapshotStore = { key: 'broken', version: 1, serialize() { throw new Error('boom'); }, restore() {} };
    const fine = memoryStore('fine');
    fine.value = [1];
    expect(saveSnapshots([empty, broken, fine])).toBe(1);
    expect(rows().map((r) => r.key)).toEqual(['fine']);
  });

  it('ignores (and drops) rows written by another world', () => {
    db.insert(simSnapshots).values({
      key: 't1', world_id: worldId + 1000, version: 1, game_minute: 0, data: { stranger: true }, saved_at: 0,
    }).run();
    const s = memoryStore('t1');
    expect(loadSnapshots([s])).toBe(0);
    expect(s.value).toBeUndefined();
    expect(rows()).toHaveLength(0);
  });

  it('ignores a row written in another format version', () => {
    const v1 = memoryStore('t1', 1);
    v1.value = { old: true };
    saveSnapshots([v1]);
    const v2 = memoryStore('t1', 2);
    expect(loadSnapshots([v2])).toBe(0);
    expect(v2.value).toBeUndefined();
  });
});

describe('restart simulation', () => {
  beforeAll(() => initFavorTracking());

  beforeEach(() => {
    ensureWorld();
    db.delete(simSnapshots).run();
    clearPerWorldCaches();
    resetCascade();
  });

  it('every persisted store comes back after a checkpoint, a wipe of memory and a reload', () => {
    // A process runs for a while...
    for (let i = 0; i < 40; i++) practiceHobby(A, 'garden', i * 30);
    simEvents.emit('gift:given', { giverId: A, receiverId: B });
    for (let i = 0; i < 4; i++) sampleMood(B, 10);
    processDayEnd(B); // bad day → negative momentum
    updateHungerTracking(B, 0, 1500);
    statesTrackersSnapshotStore.restore(throughJson(STATE_TRACKERS_FIXTURE));
    personalityBaselineSnapshotStore.restore({ [A]: profile(55) });
    // No tracker in this process (initCascade not run): the store holds it.
    const tension = { [A]: { value: 80, sources: [], lastSnapMinute: 400, snapCount: 2 } };
    tensionSnapshotStore.restore(tension);

    const before = Object.fromEntries(
      [hobbySnapshotStore, favorSnapshotStore, moodMomentumSnapshotStore, hungerSnapshotStore,
        statesTrackersSnapshotStore, personalityBaselineSnapshotStore, tensionSnapshotStore]
        .map((s) => [s.key, s.serialize()]),
    );
    const gardenLevel = getHobbyLevel(A, 'garden');
    const momentum = getMoodMomentum(B);
    expect(gardenLevel).toBeGreaterThan(0);
    expect(momentum).toBeLessThan(0);

    // ...checkpoints (the hourly tick save or shutdown)...
    expect(saveWorldCaches()).toBe(persistedStoreKeys().length);

    // ...and dies. A fresh process starts with every module Map empty.
    clearPerWorldCaches();
    resetCascade();
    expect(getHobbyLevel(A, 'garden')).toBe(0);
    expect(getNetFavorBalance(A, B)).toBe(0);
    expect(getMoodMomentum(B)).toBe(0);
    expect(hungerZeroMinutes.size).toBe(0);
    expect(tensionSnapshotStore.serialize()).toBeUndefined();

    // Boot: load the checkpoint back.
    expect(restoreWorldCaches()).toBe(persistedStoreKeys().length);
    expect(getHobbyLevel(A, 'garden')).toBe(gardenLevel);
    expect(getNetFavorBalance(A, B)).toBe(1);
    expect(getMoodMomentum(B)).toBe(momentum);
    expect(hungerZeroMinutes.get(B)).toBe(1500);
    for (const [key, value] of Object.entries(before)) {
      const store = [hobbySnapshotStore, favorSnapshotStore, moodMomentumSnapshotStore, hungerSnapshotStore,
        statesTrackersSnapshotStore, personalityBaselineSnapshotStore, tensionSnapshotStore]
        .find((s) => s.key === key)!;
      expect(store.serialize(), key).toEqual(value);
    }
  });

  it('a world replace does not inherit the previous world\'s checkpoint', () => {
    for (let i = 0; i < 40; i++) practiceHobby(A, 'garden', i * 30);
    saveWorldCaches();
    // Simulate a leftover from an older world: same key, different world id.
    const worldId = ensureWorld();
    db.update(simSnapshots).set({ world_id: worldId + 1 }).where(eq(simSnapshots.key, 'hobbies')).run();

    clearPerWorldCaches();
    restoreWorldCaches();
    expect(getHobbyLevel(A, 'garden')).toBe(0);
  });
});
