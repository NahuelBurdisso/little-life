import { describe, it, expect } from 'vitest';
import { arrangeButtonFor, ledgerIsStale } from '../romanceUi';

describe('arrangeButtonFor', () => {
  const arrange = { available: true, reason: null };

  it('is absent while the rule is off, even when the server says something about it', () => {
    expect(arrangeButtonFor({ adultContent: false, arrange: { available: false, reason: 'Adult content is off' } })).toBeNull();
    expect(arrangeButtonFor({ adultContent: false, arrange })).toBeNull();
  });

  it('is absent for a pair with no intimacy block (a minor is involved)', () => {
    expect(arrangeButtonFor(null)).toBeNull();
    expect(arrangeButtonFor(undefined)).toBeNull();
  });

  it('passes the server state through when the rule is on', () => {
    expect(arrangeButtonFor({ adultContent: true, arrange })).toEqual(arrange);
    const no = { available: false, reason: 'They have not kissed yet' };
    expect(arrangeButtonFor({ adultContent: true, arrange: no })).toEqual(no);
  });
});

describe('ledgerIsStale', () => {
  it('is stale when the ledger was built under the other rule', () => {
    expect(ledgerIsStale({ adultContent: true }, { adultContent: false })).toBe(true);
    expect(ledgerIsStale({ adultContent: false }, { adultContent: true })).toBe(true);
  });

  it('is fresh when they agree, and while either is not known yet', () => {
    expect(ledgerIsStale({ adultContent: true }, { adultContent: true })).toBe(false);
    expect(ledgerIsStale({ adultContent: false }, { adultContent: false })).toBe(false);
    expect(ledgerIsStale({ adultContent: true }, undefined)).toBe(false);
    expect(ledgerIsStale({ adultContent: true }, {})).toBe(false);
    expect(ledgerIsStale(undefined, { adultContent: false })).toBe(false);
  });
});
