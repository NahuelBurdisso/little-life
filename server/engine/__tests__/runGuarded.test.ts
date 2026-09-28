import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import { runGuarded } from '../runGuarded';
import { logActivity } from '../../lib/activityLogger';

describe('runGuarded', () => {
  beforeEach(() => vi.mocked(logActivity).mockClear());

  it('runs the work and reports success', () => {
    const fn = vi.fn();
    expect(runGuarded('perception', fn)).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('swallows a throw and logs it as an error activity', () => {
    const ok = runGuarded('tavern', () => { throw new Error('no such table: tavern'); });

    expect(ok).toBe(false);
    expect(logActivity).toHaveBeenCalledWith({
      type: 'error',
      templateData: { system: 'tavern', message: 'tavern error: no such table: tavern' },
    });
  });

  it('lets later steps run after an earlier one throws', () => {
    const later = vi.fn();
    runGuarded('loneliness', () => { throw new Error('boom'); });
    runGuarded('confrontation', later);
    expect(later).toHaveBeenCalledOnce();
  });

  it('does not throw when the activity log itself fails', () => {
    vi.mocked(logActivity).mockImplementationOnce(() => { throw new Error('db locked'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => runGuarded('aging', () => { throw new Error('boom'); })).not.toThrow();
    spy.mockRestore();
  });
});
