import { describe, it, expect, beforeEach } from 'vitest';
import {
  scheduleComfortVisit,
  getComfortVisit,
  completeComfortVisit,
  clearLonelinessTracking,
  COMFORT_VISIT_WINDOW_TICKS,
} from '../lonelinessEngine';

describe('comfort visits', () => {
  beforeEach(() => clearLonelinessTracking());

  it('hands the visitor their pending visit until it expires', () => {
    scheduleComfortVisit(3, 7, 1000);

    expect(getComfortVisit(3, 1000)).toEqual({ lonelyAgentId: 7, expiresTick: 1000 + COMFORT_VISIT_WINDOW_TICKS });
    expect(getComfortVisit(3, 1000 + COMFORT_VISIT_WINDOW_TICKS)).not.toBeNull();
    expect(getComfortVisit(3, 1001 + COMFORT_VISIT_WINDOW_TICKS)).toBeNull();
  });

  it('forgets an expired visit so it cannot come back', () => {
    scheduleComfortVisit(3, 7, 0);
    getComfortVisit(3, COMFORT_VISIT_WINDOW_TICKS + 1);
    expect(getComfortVisit(3, 0)).toBeNull();
  });

  it('is only for the scheduled visitor', () => {
    scheduleComfortVisit(3, 7, 0);
    expect(getComfortVisit(7, 0)).toBeNull();
    expect(getComfortVisit(4, 0)).toBeNull();
  });

  it('ends once the conversation is queued', () => {
    scheduleComfortVisit(3, 7, 0);
    completeComfortVisit(3);
    expect(getComfortVisit(3, 0)).toBeNull();
  });

  it('is cleared on world replace', () => {
    scheduleComfortVisit(3, 7, 0);
    clearLonelinessTracking();
    expect(getComfortVisit(3, 0)).toBeNull();
  });
});
