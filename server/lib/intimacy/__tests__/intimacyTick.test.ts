import { describe, it, expect, vi, beforeEach } from 'vitest';
import { like } from 'drizzle-orm';
import { db } from '../../../db';
import { activityLog } from '../../../db/schema';
import { logActivity } from '../../activityLogger';
import { intimacyTick } from '../index';
import { suspicionPass } from '../suspicion';
import { pregnancyPass } from '../pregnancy';

/**
 * The passes keep their state in memory, which a rollback does not undo, so each
 * one is its own guarded transaction: a throw in a later pass must not roll back
 * the writes of an earlier one, nor stop the passes after it.
 */
vi.mock('../longing', () => ({
  longingPass: () => {
    // A real write, so the test can see whether the transaction around it survived.
    logActivity({ type: 'error', templateData: { system: 'test', message: 'longing-marker' } });
  },
}));
vi.mock('../rendezvous', () => ({ registerRendezvousListener: () => {}, rendezvousPass: vi.fn() }));
vi.mock('../tryst', () => ({ trystPass: vi.fn() }));
vi.mock('../suspicion', () => ({ registerSuspicionListeners: () => {}, suspicionPass: vi.fn() }));
vi.mock('../pregnancy', () => ({ pregnancyPass: vi.fn() }));

const TIME = { day: 40, hour: 20, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const markers = () => db.select().from(activityLog).where(like(activityLog.template_data, '%longing-marker%')).all();

describe('intimacyTick', () => {
  beforeEach(() => {
    vi.mocked(suspicionPass).mockReset();
    vi.mocked(pregnancyPass).mockReset();
    db.delete(activityLog).where(like(activityLog.template_data, '%-marker%')).run();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a throwing later pass does not undo an earlier pass\'s committed writes, and the rest still run', () => {
    vi.mocked(suspicionPass).mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => intimacyTick(TIME)).not.toThrow();
    expect(markers()).toHaveLength(1);
    expect(pregnancyPass).toHaveBeenCalledTimes(1);
  });

  it('each pass\'s own writes roll back with it when it throws', () => {
    vi.mocked(pregnancyPass).mockImplementationOnce(() => {
      logActivity({ type: 'error', templateData: { system: 'test', message: 'pregnancy-marker' } });
      throw new Error('boom');
    });
    intimacyTick(TIME);
    expect(db.select().from(activityLog).where(like(activityLog.template_data, '%pregnancy-marker%')).all()).toHaveLength(0);
    expect(markers()).toHaveLength(1);
  });
});
