import { describe, it, expect } from 'vitest';
import { renderFact } from '../gossip';
import { SECRETS_POOL } from '../../data/secretsPool';

describe('secret_shared facts', () => {
  it('say what was confided', () => {
    const detail = SECRETS_POOL.find((s) => s.id === 'medical_chronic_illness')!.template.replace(/\{subject\}/g, 'Rosa Chen');
    expect(renderFact('secret_shared', 'Rosa Chen', 'Yuki Tanaka', { detail }))
      .toBe('Rosa Chen has been hiding a chronic illness from everyone in town — told in confidence to Yuki Tanaka');
  });

  it('fall back to the old wording without a detail', () => {
    expect(renderFact('secret_shared', 'Rosa Chen', 'Yuki Tanaka')).toBe('Rosa Chen confided something personal to Yuki Tanaka');
  });
});
