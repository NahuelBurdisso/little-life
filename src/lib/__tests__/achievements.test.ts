import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENTS, ACHIEVEMENTS_KEY, applyRows, counterProgress, emptyAchievements, loadAchievements,
  saveAchievements, takeNewRows, type AchievementRow,
} from '../achievements';

const row = (id: number, type: string, o: Partial<AchievementRow> = {}): AchievementRow => ({ id, type, ...o });

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
  };
}

describe('achievement unlocks', () => {
  it('a wedding unlocks the first-wedding trophy once', () => {
    const a = applyRows(emptyAchievements(), [row(1, 'wedding')], 1000);
    expect(a.unlocked.map((d) => d.id)).toEqual(['first_wedding']);
    expect(a.state.unlocked.first_wedding).toBe(1000);
    const b = applyRows(a.state, [row(2, 'wedding')], 2000);
    expect(b.unlocked).toEqual([]);
    expect(b.state.unlocked.first_wedding).toBe(1000);
  });

  it('only a planted rumor reaching everyone counts, not any secret', () => {
    expect(applyRows(emptyAchievements(), [row(1, 'drama', { template_data: { description: 'The whole town now knows' } })], 1).unlocked).toEqual([]);
    expect(applyRows(emptyAchievements(), [row(1, 'drama', { template_data: { planted: 1 } })], 1).unlocked.map((d) => d.id))
      .toEqual(['rumor_whole_town']);
  });

  it('only a winter survived counts', () => {
    expect(applyRows(emptyAchievements(), [row(1, 'season_survived', { template_data: { season: 'summer' } })], 1).unlocked).toEqual([]);
    expect(applyRows(emptyAchievements(), [row(1, 'season_survived', { template_data: { season: 'winter' } })], 1).unlocked.map((d) => d.id))
      .toEqual(['winter_no_deaths']);
  });

  it("counts confrontations toward the Director's cut across batches", () => {
    let s = emptyAchievements();
    for (let i = 1; i <= 9; i++) {
      const r = applyRows(s, [row(i, 'drama', { metadata: { beat: i % 2 ? 'fight' : 'snap' } })], i);
      expect(r.unlocked).toEqual([]);
      s = r.state;
    }
    // A gossip beat is not a confrontation.
    s = applyRows(s, [row(10, 'drama', { metadata: { beat: 'gossip' } })], 10).state;
    expect(counterProgress(ACHIEVEMENTS.find((a) => a.id === 'directors_cut')!, s)).toEqual({ value: 9, goal: 10 });
    const r = applyRows(s, [row(11, 'confrontation')], 11);
    expect(r.unlocked.map((d) => d.id)).toEqual(['directors_cut']);
  });

  it('challenge completions unlock the challenge trophies', () => {
    let r = applyRows(emptyAchievements(), [row(1, 'challenge_completed', { template_data: { challenge: 'matchmaker' } })], 1);
    expect(r.unlocked.map((d) => d.id)).toEqual(['first_challenge', 'cupid']);
    for (let i = 2; i <= 5; i++) r = applyRows(r.state, [row(i, 'challenge_completed', { template_data: { challenge: 'feud' } })], i);
    expect(r.unlocked.map((d) => d.id)).toEqual(['challenge_veteran']);
    // A failure is not a completion.
    expect(applyRows(emptyAchievements(), [row(1, 'challenge_failed')], 1).unlocked).toEqual([]);
  });

  it('does not mutate the state it is given', () => {
    const s = emptyAchievements();
    applyRows(s, [row(1, 'wedding'), row(2, 'confrontation')], 1);
    expect(s).toEqual(emptyAchievements());
  });
});

describe('new rows', () => {
  it('skips the backlog on the first poll, then yields only newer rows', () => {
    const w = { watermark: null as number | null };
    expect(takeNewRows(w, [{ id: 5 }, { id: 4 }])).toEqual([]);
    expect(takeNewRows(w, [{ id: 7 }, { id: 6 }, { id: 5 }]).map((r) => r.id)).toEqual([6, 7]);
    expect(takeNewRows(w, [{ id: 7 }])).toEqual([]);
  });

  it('re-arms without counting when a new world restarts the ids', () => {
    const w = { watermark: 500 as number | null };
    expect(takeNewRows(w, [{ id: 3 }, { id: 2 }])).toEqual([]);
    expect(takeNewRows(w, [{ id: 4 }, { id: 3 }]).map((r) => r.id)).toEqual([4]);
  });
});

describe('storage', () => {
  it('round-trips and drops unknown or malformed entries', () => {
    const st = memoryStorage();
    const s = applyRows(emptyAchievements(), [row(1, 'wedding'), row(2, 'confrontation')], 42).state;
    saveAchievements(s, st);
    expect(loadAchievements(st)).toEqual(s);

    st.data[ACHIEVEMENTS_KEY] = JSON.stringify({ unlocked: { first_wedding: 1, bogus: 2, cupid: 'x' }, counters: { confrontations: -3, challenges: 2.7 } });
    expect(loadAchievements(st)).toEqual({ unlocked: { first_wedding: 1 }, counters: { challenges: 2 } });
  });

  it('survives unreadable storage', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadAchievements(broken)).toEqual(emptyAchievements());
    expect(() => saveAchievements(emptyAchievements(), broken)).not.toThrow();
    expect(loadAchievements(memoryStorage({ [ACHIEVEMENTS_KEY]: '{not json' }))).toEqual(emptyAchievements());
  });
});
