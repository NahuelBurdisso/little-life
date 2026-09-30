import { describe, it, expect } from 'vitest';
import { generateFromSliders } from '../setupGenerator';

// ─── Inline mock agents (no cross-boundary imports from src/) ─────────────────

const mockAgents = [
  {
    name: 'Alice Mercer',
    age: 28,
    personality: { warmth: 70, curiosity: 60, neuroticism: 30, sensuality: 40, aggression: 20 },
    salary: 30,
    job: 'teacher',
  },
  {
    name: 'Bob Harding',
    age: 35,
    personality: { warmth: 40, curiosity: 50, neuroticism: 60, sensuality: 55, aggression: 45 },
    salary: 45,
    job: 'shopkeeper',
  },
  {
    name: 'Dr. Clara Voss',
    age: 42,
    personality: { warmth: 55, curiosity: 80, neuroticism: 20, sensuality: 30, aggression: 10 },
    salary: 80,
    job: 'doctor',
  },
  {
    name: 'Diego Santos',
    age: 26,
    personality: { warmth: 30, curiosity: 35, neuroticism: 70, sensuality: 65, aggression: 60 },
    salary: 20,
    job: 'laborer',
  },
  {
    name: 'Elena Park',
    age: 31,
    personality: { warmth: 60, curiosity: 45, neuroticism: 50, sensuality: 70, aggression: 25 },
    salary: 35,
    job: 'artist',
  },
  {
    name: 'Finn O\'Brien',
    age: 55,
    personality: { warmth: 50, curiosity: 55, neuroticism: 40, sensuality: 20, aggression: 30 },
    salary: 60,
    job: 'farmer',
  },
];

describe('generateFromSliders', () => {
  it('returns valid config with all required fields', () => {
    const result = generateFromSliders(
      { drama: 5, romance: 5, crime: 5, trust: 5 },
      mockAgents,
    );
    expect(result.secrets).toBeDefined();
    expect(Array.isArray(result.secrets)).toBe(true);
    expect(result.relationships).toBeDefined();
    expect(result.economyAdjustments).toBeDefined();
    expect(result.moodAdjustments).toBeDefined();
    expect(result.romanceThreads).toBeDefined();
    expect(result.trustDelta).toBeDefined();
    expect(result.rivalPairs).toBeDefined();
  });

  it('produces more secrets at higher drama', () => {
    const low = generateFromSliders({ drama: 2, romance: 5, crime: 5, trust: 5 }, mockAgents);
    const high = generateFromSliders({ drama: 9, romance: 5, crime: 5, trust: 5 }, mockAgents);
    expect(high.secrets.length).toBeGreaterThan(low.secrets.length);
  });

  it('produces more romance threads at higher romance', () => {
    const low = generateFromSliders({ drama: 5, romance: 1, crime: 5, trust: 5 }, mockAgents);
    const high = generateFromSliders({ drama: 5, romance: 9, crime: 5, trust: 5 }, mockAgents);
    expect(high.romanceThreads.length).toBeGreaterThan(low.romanceThreads.length);
  });

  it('increases wealth gaps at higher crime', () => {
    const low = generateFromSliders({ drama: 5, romance: 5, crime: 1, trust: 5 }, mockAgents);
    const high = generateFromSliders({ drama: 5, romance: 5, crime: 9, trust: 5 }, mockAgents);
    const lowValues = Object.values(low.economyAdjustments);
    const highValues = Object.values(high.economyAdjustments);
    const lowRange = Math.max(...lowValues) - Math.min(...lowValues);
    const highRange = Math.max(...highValues) - Math.min(...highValues);
    expect(highRange).toBeGreaterThan(lowRange);
  });

  it('produces rival pairs at low trust slider', () => {
    const low = generateFromSliders({ drama: 5, romance: 5, crime: 5, trust: 1 }, mockAgents);
    expect(low.rivalPairs.length).toBeGreaterThan(0);
  });

  it('never assigns more secrets than target', () => {
    for (let drama = 0; drama <= 10; drama++) {
      const result = generateFromSliders({ drama, romance: 5, crime: 5, trust: 5 }, mockAgents);
      const target = Math.round(drama * 1.2);
      expect(result.secrets.length).toBeLessThanOrEqual(target + 1); // +1 for rounding tolerance
    }
  });

  it('drama=0 produces zero secrets', () => {
    const result = generateFromSliders({ drama: 0, romance: 0, crime: 0, trust: 10 }, mockAgents);
    expect(result.secrets.length).toBe(0);
  });

  it('economy adjustments cover all agents', () => {
    const result = generateFromSliders({ drama: 5, romance: 5, crime: 5, trust: 5 }, mockAgents);
    expect(Object.keys(result.economyAdjustments).length).toBe(mockAgents.length);
  });

  it('mood adjustments cover all agents', () => {
    const result = generateFromSliders({ drama: 5, romance: 5, crime: 5, trust: 5 }, mockAgents);
    expect(Object.keys(result.moodAdjustments).length).toBe(mockAgents.length);
    for (const adj of Object.values(result.moodAdjustments)) {
      expect(adj.mood).toBeGreaterThanOrEqual(0);
      expect(adj.stress).toBeGreaterThanOrEqual(0);
    }
  });

  it('romance=0 produces no romance threads', () => {
    const result = generateFromSliders({ drama: 5, romance: 0, crime: 5, trust: 5 }, mockAgents);
    expect(result.romanceThreads.length).toBe(0);
  });

  it('trust=10 produces no rival pairs', () => {
    const result = generateFromSliders({ drama: 5, romance: 5, crime: 5, trust: 10 }, mockAgents);
    expect(result.rivalPairs.length).toBe(0);
  });

  it('trustDelta is positive at high trust and negative at low trust', () => {
    const high = generateFromSliders({ drama: 5, romance: 5, crime: 5, trust: 9 }, mockAgents);
    const low = generateFromSliders({ drama: 5, romance: 5, crime: 5, trust: 1 }, mockAgents);
    expect(high.trustDelta).toBeGreaterThan(0);
    expect(low.trustDelta).toBeLessThan(0);
  });
});

describe('witness secrets', () => {
  // A tiny deterministic LCG so each seed gives a different, repeatable town.
  const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it('are about the person seen, known only to the onlooker', () => {
    const sightings = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) =>
      generateFromSliders({ drama: 9, romance: 5, crime: 5, trust: 5 }, mockAgents, seeded(seed)).secrets
        .filter((s) => s.template_id.startsWith('witness_') && s.target_index !== null));
    expect(sightings.length).toBeGreaterThan(0);

    for (const s of sightings) {
      const onlooker = s.target_index!;
      // "{subject} saw {target}…" renders the onlooker first.
      expect(s.content.startsWith(mockAgents[onlooker].name)).toBe(true);
      expect(s.subject_index).not.toBe(onlooker);
      expect(s.content).toContain(mockAgents[s.subject_index].name);
      expect(s.known_by_indices).toEqual([onlooker]);
    }
  });

  const towns = (sliders: { drama: number; romance: number }) =>
    Array.from({ length: 40 }, (_, i) =>
      generateFromSliders({ ...sliders, crime: 5, trust: 5 }, mockAgents, seeded(i + 1)));

  it('never tell the target a secret the text says they do not know', () => {
    const oneSided = towns({ drama: 9, romance: 5 }).flatMap((t) => t.secrets)
      .filter((s) => ['romantic_unrequited', 'romantic_jealousy'].includes(s.template_id));
    expect(oneSided.length).toBeGreaterThan(0);
    for (const s of oneSided) {
      expect(s.target_index).not.toBeNull();
      expect(s.known_by_indices).not.toContain(s.target_index);
    }
  });

  it('romance secrets are about the agents their text names, known by the right people', () => {
    const threadSecrets = towns({ drama: 5, romance: 10 })
      .flatMap((t) => t.romanceThreads.flatMap((th) => (th.secret ? [th.secret] : [])));
    // The seeds are fixed; make sure the templates this pins actually occur.
    for (const id of ['love_triangle', 'jealousy_seed', 'secret_fling']) {
      expect(threadSecrets.some((s) => s.template_id === id), id).toBe(true);
    }

    for (const s of threadSecrets) {
      // Subject and target both appear in the text they are the subject of.
      expect(s.content).toContain(mockAgents[s.subject_index].name);
      if (s.target_index !== null) expect(s.content).toContain(mockAgents[s.target_index].name);

      if (s.template_id === 'love_triangle') {
        // "{agent_2} also has feelings for {agent_1}" — agent 2's secret.
        expect(s.content.startsWith(mockAgents[s.subject_index].name)).toBe(true);
        expect(s.known_by_indices).toEqual([s.subject_index]);
      }
      if (s.template_id === 'jealousy_seed') {
        // "{agent_0} saw {agent_1} flirting…": about the flirt, known to the onlooker.
        expect(s.content.startsWith(mockAgents[s.subject_index].name)).toBe(false);
        expect(s.known_by_indices).not.toContain(s.subject_index);
      }
      if (s.template_id === 'secret_fling') {
        expect(s.known_by_indices).toEqual(expect.arrayContaining([s.subject_index, s.target_index]));
      }
    }
  });
});

describe('generateFromSliders and the adults-only rule', () => {
  it('never casts a minor in a romance thread or names one in a romantic secret', () => {
    const cast = [
      ...mockAgents,
      { name: 'Kid One', age: 16, personality: mockAgents[0].personality, salary: 0, job: 'student' },
      { name: 'Kid Two', age: 17, personality: mockAgents[1].personality, salary: 0, job: 'student' },
    ];
    const minors = new Set([cast.length - 2, cast.length - 1]);
    for (let seed = 1; seed <= 40; seed++) {
      let s = seed;
      const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      const r = generateFromSliders({ drama: 10, romance: 10, crime: 0, trust: 5 }, cast, rand);
      for (const t of r.romanceThreads) {
        for (const i of t.agent_indices) expect(minors.has(i)).toBe(false);
        if (t.secret) {
          expect(minors.has(t.secret.subject_index)).toBe(false);
          expect(t.secret.target_index == null || !minors.has(t.secret.target_index)).toBe(true);
        }
      }
      for (const sec of r.secrets) {
        const romantic = sec.type === 'romantic' || sec.template_id === 'witness_affair'
          || sec.template_id === 'witness_secret_meeting';
        if (!romantic) continue;
        expect(minors.has(sec.subject_index)).toBe(false);
        expect(sec.target_index == null || !minors.has(sec.target_index)).toBe(true);
      }
    }
  });
});
