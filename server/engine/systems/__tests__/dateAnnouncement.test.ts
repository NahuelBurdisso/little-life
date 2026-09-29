import { describe, it, expect, beforeEach } from 'vitest';
import { shouldAnnounceDate, clearDateAnnouncements, DATE_ANNOUNCE_REPEAT_MINUTES } from '../decisions';

/**
 * G9: "X and Y are on a date" was logged each time the pair decided to
 * socialize on a romantic evening, before the conversation was queued. The
 * queue drops entries (the pair drifted apart, the wait ran out), the pair
 * decides again next tick, and the feed repeated the date every tick.
 */
describe('date announcements', () => {
  beforeEach(() => clearDateAnnouncements());

  it('announce a couple once per evening, whoever asks', () => {
    expect(shouldAnnounceDate(3, 7, 1200)).toBe(true);
    expect(shouldAnnounceDate(3, 7, 1201)).toBe(false);
    expect(shouldAnnounceDate(7, 3, 1260)).toBe(false);
    expect(shouldAnnounceDate(3, 9, 1260)).toBe(true);
    expect(shouldAnnounceDate(3, 7, 1200 + DATE_ANNOUNCE_REPEAT_MINUTES)).toBe(true);
  });

  it('does not get stuck when the clock goes backwards (world replaced)', () => {
    expect(shouldAnnounceDate(3, 7, 9000)).toBe(true);
    expect(shouldAnnounceDate(3, 7, 100)).toBe(true);
  });
});
