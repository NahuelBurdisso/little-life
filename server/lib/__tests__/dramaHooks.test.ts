import { describe, it, expect } from 'vitest';
import { generateDramaHooks, HOOKS_MIN_DRAMA, NO_HOOKS } from '../dramaHooks';
import { generateFromSliders, type GeneratorAgent } from '../setupGenerator';
import { forkRng } from '../worldgen/rng';
import { getDefaultAgents } from '../../../src/components/setup/defaults';
import { DEFAULT_PRESET } from '../../../src/components/setup/types';

/** The wizard's default cast, in the shape `setup.buildScenario` hands the generator. */
const cast: GeneratorAgent[] = getDefaultAgents().map((a) => ({
  name: a.name, age: a.age, personality: a.personality as unknown as Record<string, number>,
  salary: a.salary, job: a.job, homeName: a.homeName, gender: a.gender,
}));

const defaultTown = (seed: string, agents: GeneratorAgent[] = cast) => {
  const s = DEFAULT_PRESET.values;
  return generateFromSliders(
    { drama: s.drama / 10, romance: s.romance / 10, crime: s.crime / 10, trust: s.trust / 10 },
    agents, forkRng(seed, 'scenario').next,
  );
};

const SEEDS = Array.from({ length: 30 }, (_, i) => `hooks-${i}`);

describe('opening drama hooks on the default start', () => {
  it('the Balanced default is above the hooks threshold, and a calm town gets none', () => {
    expect(DEFAULT_PRESET.values.drama / 10).toBeGreaterThanOrEqual(HOOKS_MIN_DRAMA);
    const calm = generateFromSliders({ drama: 1.5, romance: 3, crime: 0.5, trust: 8 }, cast, forkRng('x', 'scenario').next);
    expect(calm.hooks).toEqual(NO_HOOKS);
  });

  it('always seeds a triangle, a feud, a debt and a challenger for the mayor', () => {
    for (const seed of SEEDS) {
      const { hooks } = defaultTown(seed);
      const t = hooks.triangle!;
      expect(t, seed).not.toBeNull();
      // The default cast has one opposite-sex pair of housemates close in age (the clinic's).
      expect(t.bond).toBe('married');
      const [a, b] = t.spouses;
      expect(cast[a].homeName).toBe(cast[b].homeName);
      expect(cast[a].gender).not.toBe(cast[b].gender);
      expect(t.spouses).toContain(t.straying);
      expect(t.spouses).not.toContain(t.admirer);

      const [r1, r2] = hooks.rivalry!.pair;
      expect(cast[r1].homeName).not.toBe(cast[r2].homeName);
      expect(new Set([cast[r1].job, cast[r2].job])).toEqual(new Set(['baker', 'shopkeeper']));

      expect(hooks.debt).not.toBeNull();
      expect(hooks.debt!.debtor).not.toBe(hooks.debt!.creditor);

      const c = hooks.campaign!;
      expect(cast[c.mayor].job).toBe('mayor');
      expect(c.challenger).not.toBe(c.mayor);
      expect(c.ambition).toMatch(/mayor/i);

      // Two residents open lonely or bored.
      expect(Object.keys(hooks.needs).length).toBe(2);
    }
  });

  it('gives every juicy secret a subject and one confidant who is free to pass it on', () => {
    for (const seed of SEEDS) {
      const { hooks } = defaultTown(seed);
      const juicy = hooks.secrets.filter((s) => s.sensitivity >= 3);
      // Triangle, debt, ambition, an old crime, a hidden past.
      expect(juicy.map((s) => s.template_id).sort()).toEqual(
        ['hook_campaign', 'hook_debt', 'hook_past_crime', 'hook_past_lie', 'hook_triangle'],
      );
      for (const s of juicy) {
        expect(s.known_by_indices).toContain(s.subject_index);
        const others = s.known_by_indices.filter((k) => k !== s.subject_index && k !== s.target_index);
        expect(others.length, s.template_id).toBe(1);
        // getShareableFacts' gates for sensitivity 3: honesty and morality at most 60.
        const p = cast[others[0]].personality;
        expect(p.honesty <= 60 && p.morality <= 60, `${seed} ${s.template_id}`).toBe(true);
      }
      // The feud is common knowledge (sensitivity 1).
      expect(hooks.secrets.find((s) => s.template_id === 'hook_rivalry')?.sensitivity).toBe(1);
    }
  });

  it('is deterministic per seed and varies across seeds', () => {
    expect(defaultTown('same').hooks).toEqual(defaultTown('same').hooks);
    const admirers = new Set(SEEDS.map((s) => defaultTown(s).hooks.triangle!.admirer));
    expect(admirers.size).toBeGreaterThan(1);
  });

  it('marries nobody under one roof by default when no couple lives together: they are engaged', () => {
    const apart = cast.map((a, i) => ({ ...a, homeName: `House ${i}` }));
    for (const seed of SEEDS.slice(0, 10)) {
      const t = defaultTown(seed, apart).hooks.triangle!;
      expect(t.bond).toBe('engaged');
    }
  });

  it('never casts a minor in any hook, nor tells one a hook secret', () => {
    const young = cast.map((a, i) => (i % 3 === 0 ? { ...a, age: 16 } : a));
    const minors = new Set(young.flatMap((a, i) => (a.age < 18 ? [i] : [])));
    for (const seed of SEEDS) {
      const hooks = generateDramaHooks(6, young, forkRng(seed, 'x').next, new Set(), [0, 1, 2]);
      const cast_ = [
        ...(hooks.triangle ? [...hooks.triangle.spouses, hooks.triangle.admirer] : []),
        ...(hooks.rivalry?.pair ?? []),
        ...(hooks.debt ? [hooks.debt.debtor, hooks.debt.creditor] : []),
        ...(hooks.campaign ? [hooks.campaign.challenger] : []),
        ...Object.keys(hooks.needs).map(Number),
      ];
      for (const i of cast_) expect(minors.has(i), `${seed}: ${young[i].name}`).toBe(false);
      for (const s of hooks.secrets) {
        for (const k of [s.subject_index, ...s.known_by_indices]) expect(minors.has(k)).toBe(false);
      }
    }
  });
});
