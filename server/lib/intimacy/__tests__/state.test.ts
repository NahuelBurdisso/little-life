import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearIntimacy, ensureAgentIntimacy, ensurePairIntimacy, getAgentIntimacy, getPairIntimacy,
  intimacySnapshotStore, updatePairIntimacy,
} from '../state';
import { clearPerWorldCaches, persistedStoreKeys } from '../../../engine/worldCaches';
import { pairKey } from '../../utils';

beforeEach(() => clearIntimacy());

describe('pairKey', () => {
  it('is order independent', () => {
    expect(pairKey(7, 3)).toBe('3-7');
    expect(pairKey(3, 7)).toBe(pairKey(7, 3));
  });
});

describe('accessors', () => {
  it('reads nothing until something is ensured, and keys pairs order-independently', () => {
    expect(getPairIntimacy(1, 2)).toBeUndefined();
    expect(getAgentIntimacy(1)).toBeUndefined();
    const p = ensurePairIntimacy(2, 1);
    expect(p).toEqual({ kisses: 0, trysts: 0, secret: false });
    expect(getPairIntimacy(1, 2)).toBe(p);
    const a = ensureAgentIntimacy(1);
    expect(a).toEqual({ longing: 0, suspicion: {} });
  });

  it('updatePairIntimacy patches in place', () => {
    updatePairIntimacy(1, 2, (p) => { p.kisses += 1; p.firstKissAt = 500; });
    updatePairIntimacy(2, 1, (p) => { p.kisses += 1; });
    expect(getPairIntimacy(1, 2)).toMatchObject({ kisses: 2, firstKissAt: 500 });
  });
});

describe('snapshot store', () => {
  it('has the contract key and version and always serialises an object', () => {
    expect(intimacySnapshotStore.key).toBe('intimacy');
    expect(intimacySnapshotStore.version).toBe(1);
    const empty = intimacySnapshotStore.serialize();
    expect(empty).toBeTypeOf('object');
    expect(empty).not.toBeNull();
  });

  it('round-trips pairs and agents', () => {
    updatePairIntimacy(4, 9, (p) => {
      p.kisses = 3; p.firstKissAt = 100; p.lastKissAt = 900; p.trysts = 2; p.firstTrystAt = 400; p.lastTrystAt = 800;
      p.pendingRendezvous = { initiatorId: 9, since: 950, venueId: 12 };
      p.rendezvousRetryAfter = 1200; p.secret = true;
    });
    const a = ensureAgentIntimacy(4);
    a.longing = 42; a.lastTouchedAt = 777; a.suspicion[9] = 30;
    const blob = JSON.parse(JSON.stringify(intimacySnapshotStore.serialize()));

    clearIntimacy();
    expect(getPairIntimacy(4, 9)).toBeUndefined();
    intimacySnapshotStore.restore(blob);
    expect(getPairIntimacy(9, 4)).toEqual({
      kisses: 3, firstKissAt: 100, lastKissAt: 900, trysts: 2, firstTrystAt: 400, lastTrystAt: 800,
      pendingRendezvous: { initiatorId: 9, since: 950, venueId: 12 }, rendezvousRetryAfter: 1200, secret: true,
    });
    expect(getAgentIntimacy(4)).toEqual({ longing: 42, lastTouchedAt: 777, suspicion: { 9: 30 } });
  });

  it('round-trips an agreed rendezvous (agreed flag and agreedAt) and drops a bogus agreed value', () => {
    updatePairIntimacy(4, 9, (p) => {
      p.pendingRendezvous = { initiatorId: 4, since: 900, venueId: 12, agreed: true, agreedAt: 950 };
    });
    updatePairIntimacy(1, 2, (p) => { p.pendingRendezvous = { initiatorId: 1, since: 10 }; });
    const blob = JSON.parse(JSON.stringify(intimacySnapshotStore.serialize()));
    clearIntimacy();
    intimacySnapshotStore.restore(blob);
    expect(getPairIntimacy(4, 9)?.pendingRendezvous).toEqual({ initiatorId: 4, since: 900, venueId: 12, agreed: true, agreedAt: 950 });
    expect(getPairIntimacy(1, 2)?.pendingRendezvous).toEqual({ initiatorId: 1, since: 10 });

    intimacySnapshotStore.restore({ pairs: { '1-2': { pendingRendezvous: { initiatorId: 1, since: 10, agreed: 'yes', agreedAt: 'x' } } } });
    expect(getPairIntimacy(1, 2)?.pendingRendezvous).toEqual({ initiatorId: 1, since: 10 });
  });

  it('restores tolerantly from junk and replaces prior content', () => {
    ensurePairIntimacy(1, 2);
    for (const junk of [null, undefined, 5, 'x', [], { pairs: 3, agents: 'no' }]) {
      intimacySnapshotStore.restore(junk);
      expect(getPairIntimacy(1, 2)).toBeUndefined();
    }
    intimacySnapshotStore.restore({
      pairs: {
        'bad-key': { kisses: 1 },
        '1-2': { kisses: 'many', trysts: -3, secret: 'yes', pendingRendezvous: { initiatorId: 'x', since: 1 } },
        '3-4': 'nope',
      },
      agents: {
        abc: { longing: 10 },
        5: { longing: 900, suspicion: { 6: 'high', x: 3, 7: 250 } },
        8: null,
      },
    });
    expect(getPairIntimacy(1, 2)).toEqual({ kisses: 0, trysts: 0, secret: false });
    expect(getPairIntimacy(3, 4)).toBeUndefined();
    expect(getAgentIntimacy(5)).toEqual({ longing: 100, suspicion: { 7: 100 } });
    expect(getAgentIntimacy(8)).toBeUndefined();
  });
});

describe('world caches', () => {
  it('is a persisted store with a unique key and clearPerWorldCaches empties it', () => {
    const keys = persistedStoreKeys();
    expect(keys).toContain('intimacy');
    expect(new Set(keys).size).toBe(keys.length);
    ensurePairIntimacy(1, 2);
    ensureAgentIntimacy(1).longing = 50;
    clearPerWorldCaches();
    expect(getPairIntimacy(1, 2)).toBeUndefined();
    expect(getAgentIntimacy(1)).toBeUndefined();
  });
});
