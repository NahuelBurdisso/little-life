import { describe, it, expect } from 'vitest';
import {
  adultIdSet,
  isRomanticSecret,
  mayKeepSeedSecret,
  sanitizeSeedRomance,
  type SeedRelationshipRow,
} from '../seedRomance';

const row = (over: Partial<SeedRelationshipRow> = {}): SeedRelationshipRow => ({
  agent_a: 1, agent_b: 2,
  friendship_ab: 60, friendship_ba: 50,
  romance_ab: 80, romance_ba: 70,
  tags: ['crush', 'partner', 'romantic', 'engaged', 'married', 'kissed', 'lovers', 'coworker'],
  status: 'partners',
  ...over,
});

const adult = { id: 1, age: 30 };
const minor = { id: 2, age: 16 };

describe('sanitizeSeedRomance', () => {
  it('strips romance, romantic tags and a romantic status when one side is a minor', () => {
    const [out] = sanitizeSeedRomance([adult, minor], [row()]);
    expect(out.romance_ab).toBe(0);
    expect(out.romance_ba).toBe(0);
    expect(out.tags).toEqual(['coworker']);
    expect(out.status).toBe('friends');
  });

  it('treats the minor as either side of the pair', () => {
    const [out] = sanitizeSeedRomance([{ id: 1, age: 15 }, { id: 2, age: 40 }], [row()]);
    expect(out.romance_ab).toBe(0);
    expect(out.tags).not.toContain('crush');
  });

  it('keeps a seeded dislike (negative romance) and non-romantic statuses', () => {
    const [out] = sanitizeSeedRomance([adult, minor], [
      row({ romance_ab: -20, romance_ba: 90, status: 'rivals', tags: ['rival'] }),
    ]);
    expect(out.romance_ab).toBe(-20);
    expect(out.romance_ba).toBe(0);
    expect(out.status).toBe('rivals');
    expect(out.tags).toEqual(['rival']);
  });

  it('downgrades to acquaintances when the friendship is lukewarm', () => {
    const [out] = sanitizeSeedRomance([adult, minor], [
      row({ friendship_ab: 10, friendship_ba: 20, status: 'romantic_interest' }),
    ]);
    expect(out.status).toBe('acquaintances');
  });

  it.each(['romantic_interest', 'partners', 'complicated'])('downgrades %s', (status) => {
    const [out] = sanitizeSeedRomance([adult, minor], [row({ status })]);
    expect(['friends', 'acquaintances']).toContain(out.status);
  });

  it('leaves an adult pair untouched (same object)', () => {
    const r = row();
    const [out] = sanitizeSeedRomance([adult, { id: 2, age: 18 }], [r]);
    expect(out).toBe(r);
  });

  it('fails closed on a missing, non-numeric or unknown agent', () => {
    expect(sanitizeSeedRomance([adult, { id: 2, age: undefined as unknown as number }], [row()])[0].romance_ab).toBe(0);
    expect(sanitizeSeedRomance([adult, { id: 2, age: '30' as unknown as number }], [row()])[0].romance_ba).toBe(0);
    expect(sanitizeSeedRomance([adult], [row()])[0].romance_ab).toBe(0);
  });

  it('does not mutate its input', () => {
    const r = row();
    sanitizeSeedRomance([adult, minor], [r]);
    expect(r.romance_ab).toBe(80);
    expect(r.tags).toContain('crush');
  });
});

describe('seed secrets', () => {
  const adults = adultIdSet([adult, minor, { id: 3, age: 18 }]);

  it('adultIdSet uses the fail-closed age check', () => {
    expect([...adults].sort()).toEqual([1, 3]);
  });

  it('recognises romantic secrets by type or template', () => {
    for (const type of ['affair', 'secret_fling', 'forbidden', 'crush', 'romantic']) {
      expect(isRomanticSecret({ type })).toBe(true);
    }
    expect(isRomanticSecret({ type: 'witness', template_id: 'witness_affair' })).toBe(true);
    expect(isRomanticSecret({ type: 'financial', template_id: 'financial_theft' })).toBe(false);
    expect(isRomanticSecret({ type: 'secret_told' })).toBe(false);
  });

  it('drops a romantic secret naming a minor as subject or target', () => {
    expect(mayKeepSeedSecret(adults, { type: 'crush', subjectId: 2, targetId: 1 })).toBe(false);
    expect(mayKeepSeedSecret(adults, { type: 'affair', subjectId: 1, targetId: 2 })).toBe(false);
    expect(mayKeepSeedSecret(adults, { type: 'romantic', subjectId: 2, targetId: null })).toBe(false);
  });

  it('keeps adult romantic secrets and any non-romantic secret', () => {
    expect(mayKeepSeedSecret(adults, { type: 'affair', subjectId: 1, targetId: 3 })).toBe(true);
    expect(mayKeepSeedSecret(adults, { type: 'financial', subjectId: 2, targetId: null })).toBe(true);
  });
});
