import type { ParticleProfile, ParticleTrigger } from './types';

/**
 * Allocation-free lookups for the particle engine's per-frame matching pass.
 *
 * `ParticleEngine.update` used to build `agent_state:${state}` index keys and
 * `${type}-${id}-${profile}` emitter keys with template strings for every agent,
 * state and profile, 60 times a second — thousands of short-lived strings a second
 * for values that almost never change. Both are now memoised: the strings are built
 * once per distinct (anchor, profile) pair and handed back by reference afterwards.
 */

/** The value a trigger matches on (the state, action, weather... it names). */
export function triggerValue(trigger: ParticleTrigger): string {
  switch (trigger.type) {
    case 'agent_state': return trigger.state;
    case 'agent_action': return trigger.action;
    case 'weather': return trigger.weather;
    case 'time': return trigger.phase;
    case 'season': return trigger.season;
    case 'location_type': return trigger.locType;
    case 'social': return trigger.event;
  }
}

/** Profiles indexed by trigger type, then by trigger value. Insertion order is kept per bucket. */
export class ProfileIndex {
  private readonly byType = new Map<ParticleTrigger['type'], Map<string, ParticleProfile[]>>();

  add(profile: ParticleProfile): void {
    const { type } = profile.trigger;
    let values = this.byType.get(type);
    if (!values) {
      values = new Map();
      this.byType.set(type, values);
    }
    const value = triggerValue(profile.trigger);
    const list = values.get(value);
    if (list) list.push(profile);
    else values.set(value, [profile]);
  }

  /** Profiles of `type` whose trigger value is `value`; undefined when none. No allocation. */
  get(type: ParticleTrigger['type'], value: string): ParticleProfile[] | undefined {
    return this.byType.get(type)?.get(value);
  }
}

/**
 * `${anchorType}-${anchorId}-${profileId}` emitter keys, built once per pair.
 * The cache is bounded by (anchors ever seen) x (profiles), a few hundred strings at most.
 */
export class EmitterKeyCache {
  private readonly byAnchor = new Map<string | number, Map<string, string>>();

  constructor(private readonly anchorType: 'agent' | 'location' | 'world') {}

  get(anchorId: string | number, profileId: string): string {
    let perProfile = this.byAnchor.get(anchorId);
    if (!perProfile) {
      perProfile = new Map();
      this.byAnchor.set(anchorId, perProfile);
    }
    let key = perProfile.get(profileId);
    if (key === undefined) {
      key = `${this.anchorType}-${anchorId}-${profileId}`;
      perProfile.set(profileId, key);
    }
    return key;
  }

  clear(): void {
    this.byAnchor.clear();
  }
}
