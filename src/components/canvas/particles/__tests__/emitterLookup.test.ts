import { describe, it, expect } from 'vitest';
import { EmitterKeyCache, ProfileIndex, triggerValue } from '../emitterLookup';
import { PARTICLE_PROFILES } from '../profileRegistry';
import type { ParticleProfile } from '../types';

function profile(id: string, trigger: ParticleProfile['trigger']): ParticleProfile {
  return { id, trigger } as ParticleProfile;
}

describe('triggerValue', () => {
  it('reads the field each trigger type matches on', () => {
    expect(triggerValue({ type: 'agent_state', state: 'drunk' })).toBe('drunk');
    expect(triggerValue({ type: 'agent_action', action: 'sleep' })).toBe('sleep');
    expect(triggerValue({ type: 'weather', weather: 'foggy' })).toBe('foggy');
    expect(triggerValue({ type: 'time', phase: 'night' })).toBe('night');
    expect(triggerValue({ type: 'season', season: 'autumn' })).toBe('autumn');
    expect(triggerValue({ type: 'location_type', locType: 'bakery' })).toBe('bakery');
    expect(triggerValue({ type: 'social', event: 'kiss' })).toBe('kiss');
  });
});

describe('ProfileIndex', () => {
  it('buckets by trigger type and value, keeping insertion order', () => {
    const a = profile('a', { type: 'agent_state', state: 'drunk' });
    const b = profile('b', { type: 'agent_state', state: 'drunk' });
    const c = profile('c', { type: 'agent_state', state: 'angry' });
    const d = profile('d', { type: 'agent_action', action: 'drunk' });
    const index = new ProfileIndex();
    for (const p of [a, b, c, d]) index.add(p);

    expect(index.get('agent_state', 'drunk')).toEqual([a, b]);
    expect(index.get('agent_state', 'angry')).toEqual([c]);
    // Same value under another trigger type is a different bucket.
    expect(index.get('agent_action', 'drunk')).toEqual([d]);
  });

  it('returns undefined for a miss instead of allocating an empty list', () => {
    const index = new ProfileIndex();
    index.add(profile('a', { type: 'weather', weather: 'foggy' }));
    expect(index.get('weather', 'sunny')).toBeUndefined();
    expect(index.get('season', 'foggy')).toBeUndefined();
  });

  it('indexes every shipped profile under its own trigger', () => {
    const index = new ProfileIndex();
    for (const p of PARTICLE_PROFILES) index.add(p);
    for (const p of PARTICLE_PROFILES) {
      expect(index.get(p.trigger.type, triggerValue(p.trigger)), p.id).toContain(p);
    }
  });
});

describe('EmitterKeyCache', () => {
  it('builds the anchor-id-profile key', () => {
    expect(new EmitterKeyCache('agent').get('12', 'drunk_bubbles')).toBe('agent-12-drunk_bubbles');
    expect(new EmitterKeyCache('world').get('weather', 'fog')).toBe('world-weather-fog');
  });

  it('gives a numeric location id the same key as its string form', () => {
    const cache = new EmitterKeyCache('location');
    expect(cache.get(7, 'chimney_smoke')).toBe('location-7-chimney_smoke');
    expect(cache.get(7, 'chimney_smoke')).toBe('location-7-chimney_smoke');
  });

  it('hands back the identical string on repeat lookups', () => {
    const cache = new EmitterKeyCache('agent');
    const first = cache.get('3', 'x');
    expect(cache.get('3', 'x')).toBe(first);
    expect(cache.get('3', 'y')).not.toBe(first);
    expect(cache.get('4', 'x')).toBe('agent-4-x');
  });

  it('forgets everything on clear', () => {
    const cache = new EmitterKeyCache('agent');
    cache.get('3', 'x');
    cache.clear();
    expect(cache.get('3', 'x')).toBe('agent-3-x');
  });
});
