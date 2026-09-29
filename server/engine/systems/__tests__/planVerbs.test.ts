import { describe, it, expect } from 'vitest';
import { buildAction, zoneVerbOf } from '../decisions';
import { findAvailableZone } from '../../../lib/interiorGrid';

const plan = (action: string) => ({ action, score: 6000, source: 'plan:decomposed' });

describe('plan-driven activity verbs', () => {
  it('keeps the verb of a plan step as zoneActivity instead of a bare idle', () => {
    for (const verb of ['fish', 'cook', 'speech', 'protest', 'announce', 'watch', 'scheme', 'secret_meeting', 'confide', 'perform', 'jog', 'browse']) {
      expect(buildAction(plan(verb))).toEqual({ type: 'idle', zoneActivity: verb });
    }
  });

  it('still routes free-time activities (idle + source) the same way', () => {
    expect(buildAction({ action: 'idle', score: 1, source: 'fish' })).toEqual({ type: 'idle', zoneActivity: 'fish' });
    expect(zoneVerbOf({ action: 'idle' })).toBeUndefined();
  });

  it("does not turn the engine's own actions or idle plan blocks into activities", () => {
    expect(zoneVerbOf(plan('working'))).toBeUndefined();
    expect(zoneVerbOf(plan('socializing'))).toBeUndefined();
    expect(zoneVerbOf({ action: 'idle', source: 'plan:block-3' })).toBeUndefined();
    expect(buildAction({ action: 'idle', score: 1, source: 'plan:block-3' })).toEqual({ type: 'idle' });
    expect(buildAction(plan('working'))).toMatchObject({ type: 'working' });
  });

  it('finds the zone that allows the plan verb', () => {
    expect(findAvailableZone('park', zoneVerbOf(plan('fish'))!)?.id).toBe('riverside');
    expect(findAvailableZone('town_square', zoneVerbOf(plan('speech'))!)?.id).toBe('podium');
    expect(findAvailableZone('park', zoneVerbOf(plan('garden'))!)?.id).toBe('garden');
    // The old lookup key never matched anything.
    expect(findAvailableZone('park', 'plan:decomposed')).toBeNull();
  });
});
