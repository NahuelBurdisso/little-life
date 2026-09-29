import { describe, it, expect } from 'vitest';
import { buildBrewing, type BrewingInput } from '../brewing';
import { snapThreshold } from '../cascade/TensionTracker';
import type { PersonalityProfile } from '../personality';

// Neutral profile: threshold = 100 - 50/4 - 50/5 + 50/6.67 + 50/10 = 90.0 (ish),
// computed below rather than hard-coded so a retune of the formula doesn't break the tests.
const NEUTRAL: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};
const THRESHOLD = snapThreshold(NEUTRAL);

const AGENTS: BrewingInput['agents'] = [
  { id: 1, name: 'Mara', personality: NEUTRAL },
  { id: 2, name: 'Jonas', personality: NEUTRAL },
  { id: 3, name: 'Edda', personality: NEUTRAL },
  { id: 4, name: 'Piet', personality: NEUTRAL },
  { id: 5, name: 'Lena', personality: NEUTRAL },
];

function input(over: Partial<BrewingInput> = {}): BrewingInput {
  return { agents: AGENTS, tension: [], secrets: [], queue: [], goals: [], relationships: [], ...over };
}

function tension(agentId: number, ratio: number, events: string[] = []) {
  return {
    agentId,
    value: THRESHOLD * ratio,
    sources: events.map((event, i) => ({ event, description: `${event} triggered`, tick: i })),
  };
}

function secret(id: number, subject: number, knownBy: number[], over: Partial<BrewingInput['secrets'][number]> = {}) {
  return { id, subject_id: subject, sensitivity: 2, known_by: knownBy, is_public: false, is_active: true, ...over };
}

describe('buildBrewing: snap tension', () => {
  it('shows residents at >= 70% of their threshold and hides the rest', () => {
    const items = buildBrewing(input({
      tension: [tension(1, 0.69), tension(2, 0.7), tension(3, 0.95)],
    }));
    expect(items.map((i) => i.agentIds[0]).sort()).toEqual([2, 3]);
  });

  it('measures against each resident own threshold', () => {
    // A jumpy resident (low threshold) is far closer to snapping at the same raw tension.
    const jumpy: PersonalityProfile = { ...NEUTRAL, neuroticism: 100, impulsiveness: 100, morality: 0, warmth: 0 };
    const calm: PersonalityProfile = { ...NEUTRAL, neuroticism: 0, impulsiveness: 0, morality: 100, warmth: 100 };
    const value = snapThreshold(jumpy) * 0.9;
    expect(value / snapThreshold(calm)).toBeLessThan(0.7);
    const items = buildBrewing(input({
      agents: [
        { id: 1, name: 'Mara', personality: jumpy },
        { id: 2, name: 'Jonas', personality: calm },
      ],
      tension: [{ agentId: 1, value, sources: [] }, { agentId: 2, value, sources: [] }],
    }));
    expect(items.map((i) => i.agentIds[0])).toEqual([1]);
  });

  it('caps heat at 1 for a resident already past the threshold (snap cooldown)', () => {
    const [item] = buildBrewing(input({ tension: [tension(1, 1.4)] }));
    expect(item.heat).toBe(1);
    expect(item.text).toContain('breaking point');
  });

  it('lists the newest distinct grievances in human wording, at most three', () => {
    const [item] = buildBrewing(input({
      tension: [tension(1, 0.8, [
        'economy:distress', 'state:triggered', 'state:triggered', 'economy:theft_caught', 'jealousy:triggered',
      ])],
    }));
    expect(item.sources).toEqual(['jealousy', 'a theft that came to light', 'stress piling up']);
    expect(item.text).toContain('jealousy');
    expect(item.text).not.toContain('economy:');
  });

  it('skips departed residents and residents without a personality', () => {
    const items = buildBrewing(input({
      agents: [{ id: 1, name: 'Mara', personality: null }],
      tension: [tension(1, 0.9), tension(99, 0.9)],
    }));
    expect(items).toEqual([]);
  });
});

describe('buildBrewing: secrets', () => {
  it('reports how many people know, without the content', () => {
    const [item] = buildBrewing(input({
      // The row deliberately carries content-like fields the builder must not copy.
      secrets: [{ ...secret(7, 1, [1, 2]), content: 'Mara is stealing from the church', type: 'affair' } as never],
    }));
    expect(item.kind).toBe('secret');
    expect(item.agentIds).toEqual([1]);
    expect(item.text).toBe('A secret about Mara is out there: 2 of 5 people know');
    expect(JSON.stringify(item)).not.toMatch(/stealing|church|affair/);
  });

  it('ignores mild facts, public secrets, inactive rows and secrets that became common knowledge', () => {
    const items = buildBrewing(input({
      secrets: [
        secret(1, 1, [1], { sensitivity: 1 }),
        secret(2, 2, [2], { is_public: true }),
        secret(3, 3, [3], { is_active: false }),
        secret(4, 4, [1, 2, 3]), // 3 of 5 is more than half: common knowledge
        secret(5, 5, [5, 1]),
      ],
    }));
    expect(items.map((i) => i.id)).toEqual(['secret-5']);
  });

  it('heats up as the secret spreads and with sensitivity', () => {
    const items = buildBrewing(input({
      secrets: [
        secret(1, 1, [1]),
        secret(2, 2, [2, 1]),
        secret(3, 3, [3], { sensitivity: 3 }),
      ],
    }));
    const heat = Object.fromEntries(items.map((i) => [i.id, i.heat]));
    expect(heat['secret-2']).toBeGreaterThan(heat['secret-1']);
    expect(heat['secret-3']).toBeGreaterThan(heat['secret-1']);
  });

  it('does not count the departed among the people who know', () => {
    const [item] = buildBrewing(input({ secrets: [secret(1, 1, [1, 42])] }));
    expect(item.text).toContain('1 of 5 people know');
  });
});

describe('buildBrewing: queue', () => {
  it('surfaces confrontations and player nudges, and ignores routine chatter', () => {
    const items = buildBrewing(input({
      queue: [
        { id: 1, participants: [1, 2], trigger_reason: 'player_confront', topic: 'confrontation' },
        { id: 2, participants: [3, 4], trigger_reason: 'autoplay:confrontation', topic: 'confrontation' },
        { id: 3, participants: [1, 5], trigger_reason: 'player_nudge', topic: null },
        { id: 4, participants: [2, 3], trigger_reason: 'needs_social', topic: null },
        { id: 5, participants: [2, 4], trigger_reason: 'location_encounter:tavern', topic: null },
      ],
    }));
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ['queue-1', 'confrontation'],
      ['queue-2', 'confrontation'],
      ['queue-3', 'nudge'],
    ]);
    expect(items[0].agentIds).toEqual([1, 2]);
  });

  it('never leaks the topic of a queued secret reveal', () => {
    const [item] = buildBrewing(input({
      queue: [{
        id: 1, participants: [1, 2], trigger_reason: 'player_tell_secret',
        topic: 'revealing: Piet cheats at cards',
      }],
    }));
    expect(item.kind).toBe('nudge');
    expect(item.text).toContain('Mara');
    expect(JSON.stringify(item)).not.toMatch(/Piet|cards|revealing/);
  });

  it('drops entries whose participants have left', () => {
    expect(buildBrewing(input({
      queue: [{ id: 1, participants: [1, 99], trigger_reason: 'player_confront', topic: 'confrontation' }],
    }))).toEqual([]);
  });
});

describe('buildBrewing: goals', () => {
  const goal = (id: number, progress: number, over: Partial<BrewingInput['goals'][number]> = {}) => ({
    id, agent_id: 1, type: 'befriend', target_id: 2, description: null, progress, status: 'active', ...over,
  });

  it('shows active goals from 70% progress and scales heat with progress', () => {
    const items = buildBrewing(input({
      goals: [goal(1, 0.69), goal(2, 0.7), goal(3, 0.95), goal(4, 1), goal(5, 0.9, { status: 'completed' })],
    }));
    expect(items.map((i) => i.id)).toEqual(['goal-3', 'goal-2']);
    expect(items[0].text).toBe('Mara is close to achieving befriending Jonas');
    expect(items[0].heat).toBeGreaterThan(items[1].heat);
  });

  it('phrases a free-form goal by its description, truncated', () => {
    const [item] = buildBrewing(input({
      goals: [goal(1, 0.8, { type: 'custom', target_id: null, description: 'x'.repeat(200) })],
    }));
    expect(item.text.length).toBeLessThan(140);
    expect(item.text).toContain('...');
  });
});

describe('buildBrewing: relationships near a flip', () => {
  const rel = (over: Partial<BrewingInput['relationships'][number]> = {}) => ({
    agent_a: 1, agent_b: 2, friendship_ab: 50, friendship_ba: 50, romance_ab: 0, romance_ba: 0, status: 'friends', ...over,
  });

  it('flags sparks just under the romantic-interest line', () => {
    const [item] = buildBrewing(input({ relationships: [rel({ romance_ab: 27 })] }));
    expect(item.kind).toBe('relationship');
    expect(item.text).toContain('spark');
  });

  it('flags a pair one push from becoming a couple', () => {
    const [item] = buildBrewing(input({
      relationships: [rel({ romance_ab: 68, romance_ba: 66, status: 'romantic_interest' })],
    }));
    expect(item.text).toContain('couple');
  });

  it('ignores pairs far from any threshold and estranged pairs', () => {
    expect(buildBrewing(input({
      relationships: [rel(), rel({ agent_a: 3, agent_b: 4, romance_ab: 28, status: 'estranged' })],
    }))).toEqual([]);
  });

  it('runs hotter the closer the pair is to the line', () => {
    const items = buildBrewing(input({
      relationships: [rel({ romance_ab: 25 }), rel({ agent_a: 3, agent_b: 4, romance_ab: 29.5 })],
    }));
    expect(items[0].agentIds).toEqual([3, 4]);
  });
});

describe('buildBrewing: ordering', () => {
  it('sorts hottest first across kinds and caps at 12', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i, agent_id: 1, type: 'befriend', target_id: 2, description: null,
      progress: 0.7 + (i % 3) * 0.05, status: 'active',
    }));
    const items = buildBrewing(input({
      tension: [tension(3, 0.99)],
      queue: [{ id: 1, participants: [1, 2], trigger_reason: 'player_confront', topic: 'confrontation' }],
      goals: many,
    }));
    expect(items).toHaveLength(12);
    expect(items[0].kind).toBe('snap');
    expect(items[1].kind).toBe('confrontation');
    for (let i = 1; i < items.length; i++) expect(items[i - 1].heat).toBeGreaterThanOrEqual(items[i].heat);
  });

  it('keeps heat inside 0..1 and ids unique', () => {
    const items = buildBrewing(input({
      tension: [tension(1, 3)],
      secrets: [secret(1, 2, [2], { sensitivity: 9 })],
    }));
    for (const i of items) {
      expect(i.heat).toBeGreaterThanOrEqual(0);
      expect(i.heat).toBeLessThanOrEqual(1);
    }
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('is empty for a quiet town', () => {
    expect(buildBrewing(input())).toEqual([]);
  });
});
