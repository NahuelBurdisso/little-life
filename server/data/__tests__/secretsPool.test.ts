import { describe, it, expect } from 'vitest';
import { SECRETS_POOL, SecretTemplate } from '../secretsPool';

describe('SECRETS_POOL', () => {
  it('has exactly 20 templates', () => {
    expect(SECRETS_POOL).toHaveLength(20);
  });

  it('covers all 6 required categories', () => {
    const categories = new Set(SECRETS_POOL.map((t: SecretTemplate) => t.category));
    expect(categories.has('medical')).toBe(true);
    expect(categories.has('financial')).toBe(true);
    expect(categories.has('witness')).toBe(true);
    expect(categories.has('romantic')).toBe(true);
    expect(categories.has('past')).toBe(true);
    expect(categories.has('suspicion')).toBe(true);
  });

  it('every template has required fields with valid types', () => {
    for (const template of SECRETS_POOL) {
      expect(typeof template.id).toBe('string');
      expect(template.id.length).toBeGreaterThan(0);
      expect(typeof template.category).toBe('string');
      expect(typeof template.template).toBe('string');
      expect(template.template.length).toBeGreaterThan(0);
      expect(typeof template.sensitivity).toBe('number');
      expect(template.sensitivity).toBeGreaterThanOrEqual(1);
      expect(template.sensitivity).toBeLessThanOrEqual(3);
    }
  });

  it('all template ids are unique', () => {
    const ids = SECRETS_POOL.map((t: SecretTemplate) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(SECRETS_POOL.length);
  });

  it('each category has at least 3 templates', () => {
    const countByCategory: Record<string, number> = {};
    for (const template of SECRETS_POOL) {
      countByCategory[template.category] = (countByCategory[template.category] ?? 0) + 1;
    }
    for (const [category, count] of Object.entries(countByCategory)) {
      expect(count).toBeGreaterThanOrEqual(3);
    }
  });
});
