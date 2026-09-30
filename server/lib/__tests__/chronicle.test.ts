import { describe, it, expect } from 'vitest';
import { buildArcs, type ChronicleInput } from '../chronicle';

/** Current GAME minute (day 40, midnight): what heat and beat ages are measured on. */
const NOW = 40 * 1440;
/** Wall clock at "now". Fixtures stamp `timestamp` from it only to prove nothing reads it. */
const NOW_MS = 1_700_000_000_000;

const AGENTS = [
  { id: 1, name: 'Mara' },
  { id: 2, name: 'Jonas' },
  { id: 3, name: 'Edda' },
  { id: 4, name: 'Piet' },
];

function rel(
  agent_a: number,
  agent_b: number,
  over: Partial<ChronicleInput['relationships'][number]> = {},
): ChronicleInput['relationships'][number] {
  return {
    id: agent_a * 100 + agent_b,
    agent_a,
    agent_b,
    friendship_ab: 50,
    friendship_ba: 50,
    romance_ab: 0,
    romance_ba: 0,
    trust_ab: 50,
    trust_ba: 50,
    familiarity: 50,
    interaction_count: 5,
    last_interaction: NOW,
    last_interaction_minute: 0,
    status_since_minute: 0,
    average_interaction_sentiment: 0,
    tags: [],
    status: 'friends',
    created_at: 0,
    last_updated: NOW,
    ...over,
  };
}

let eventId = 0;
function evt(
  agent_a: number,
  agent_b: number,
  event_type: string,
  sentiment: number,
  minutesAgo: number,
  over: Partial<ChronicleInput['events'][number]> = {},
): ChronicleInput['events'][number] {
  return {
    id: ++eventId,
    agent_a,
    agent_b,
    event_type,
    description: `${event_type} between ${agent_a} and ${agent_b}`,
    friendship_delta_ab: 0,
    friendship_delta_ba: 0,
    romance_delta_ab: 0,
    romance_delta_ba: 0,
    trust_delta_ab: 0,
    trust_delta_ba: 0,
    sentiment,
    processed: true,
    timestamp: NOW_MS - minutesAgo * 60_000,
    game_minute: NOW - minutesAgo,
    ...over,
  };
}

/** Newest-first, which is the ordering `buildArcs` expects from its caller. */
function input(over: Partial<ChronicleInput> = {}): ChronicleInput {
  return {
    agents: AGENTS,
    relationships: [],
    events: [],
    secrets: [],
    adultContent: true,
    ...over,
  };
}

describe('buildArcs', () => {
  it('returns nothing when the town is empty', () => {
    expect(buildArcs(input({ agents: [] }), NOW)).toEqual([]);
  });

  it('needs events, not just a status, to open a pair arc', () => {
    const arcs = buildArcs(input({ relationships: [rel(1, 2, { status: 'enemies' })] }), NOW);
    expect(arcs).toEqual([]);
  });

  it('detects a rivalry from hostile events', () => {
    const arcs = buildArcs(
      input({
        relationships: [rel(1, 2, { status: 'rivals' })],
        events: [evt(1, 2, 'fight', -0.8, 5), evt(2, 1, 'confrontation', -0.6, 30)],
      }),
      NOW,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0].kind).toBe('rivalry');
    expect(arcs[0].title).toBe('Mara vs Jonas');
    expect(arcs[0].participantNames).toEqual(['Mara', 'Jonas']);
  });

  it('orders beats oldest-first even though events arrive newest-first', () => {
    const arcs = buildArcs(
      input({
        relationships: [rel(1, 2, { status: 'rivals' })],
        events: [evt(1, 2, 'fight', -0.8, 5), evt(2, 1, 'confrontation', -0.6, 30)],
      }),
      NOW,
    );
    const [first, second] = arcs[0].beats;
    expect(first.gameMinute!).toBeLessThan(second.gameMinute!);
    expect(arcs[0].lastActivity).toBe(second.gameMinute);
  });

  it('detects a romance from partner status', () => {
    const arcs = buildArcs(
      input({
        relationships: [rel(1, 2, { status: 'partners', romance_ab: 80, romance_ba: 80 })],
        events: [evt(1, 2, 'confession', 0.9, 10, { romance_delta_ab: 10 })],
      }),
      NOW,
    );
    expect(arcs[0].kind).toBe('romance');
    expect(arcs[0].title).toBe('Mara & Jonas');
  });

  it('prefers reconciliation over rivalry once the mend outdates the last clash', () => {
    const arcs = buildArcs(
      input({
        relationships: [rel(1, 2, { status: 'rivals' })],
        events: [
          evt(1, 2, 'reconciliation', 0.7, 5),
          evt(1, 2, 'fight', -0.8, 60),
          evt(2, 1, 'confrontation', -0.6, 90),
        ],
      }),
      NOW,
    );
    expect(arcs.map((a) => a.kind)).toContain('reconciliation');
    expect(arcs.map((a) => a.kind)).not.toContain('rivalry');
  });

  it('stays a rivalry when the clash came after the mend', () => {
    const arcs = buildArcs(
      input({
        relationships: [rel(1, 2, { status: 'rivals' })],
        events: [evt(1, 2, 'fight', -0.8, 5), evt(1, 2, 'reconciliation', 0.7, 60)],
      }),
      NOW,
    );
    expect(arcs[0].kind).toBe('rivalry');
  });

  it('detects a love triangle around an outsider still carrying a torch', () => {
    const arcs = buildArcs(
      input({
        relationships: [
          rel(1, 2, { status: 'partners', romance_ab: 80, romance_ba: 80 }),
          rel(3, 1, { status: 'friends', romance_ab: 70 }),
        ],
        events: [evt(1, 2, 'confession', 0.9, 10)],
      }),
      NOW,
    );
    const triangle = arcs.find((a) => a.kind === 'love_triangle');
    expect(triangle).toBeDefined();
    expect(triangle!.participants.sort()).toEqual([1, 2, 3]);
    expect(triangle!.title).toBe('Edda, Mara and Jonas');
  });

  it('calls it a downfall only when several different people turn on one agent', () => {
    const oneAggressor = buildArcs(
      input({
        events: [
          evt(1, 3, 'confrontation', -0.7, 5),
          evt(1, 3, 'fight', -0.8, 20),
          evt(1, 3, 'theft_caught', -0.9, 40),
        ],
      }),
      NOW,
    );
    expect(oneAggressor.some((a) => a.kind === 'downfall')).toBe(false);

    const manyAggressors = buildArcs(
      input({
        events: [
          evt(1, 3, 'confrontation', -0.7, 5),
          evt(2, 3, 'fight', -0.8, 20),
          evt(4, 3, 'theft_caught', -0.9, 40),
        ],
      }),
      NOW,
    );
    const downfall = manyAggressors.find((a) => a.kind === 'downfall');
    expect(downfall).toBeDefined();
    expect(downfall!.title).toBe('The fall of Edda');
  });

  it('surfaces a widely-held sensitive secret as a scandal', () => {
    const secret = {
      id: 1,
      type: 'secret_told',
      subject_id: 3,
      target_id: 4,
      content: 'Edda has been skimming the town funds',
      sensitivity: 3,
      known_by: [1, 2, 3, 4],
      created_at: 0,
      is_active: true,
      reliability: 'confirmed',
      source: 'backstory',
      is_public: false,
      revealed_at: null, paid_at: null,
    };
    const arcs = buildArcs(input({ secrets: [secret] }), NOW);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].kind).toBe('scandal');
    expect(arcs[0].beats[0].description).toBe(secret.content);
    // Heat is spread-based, so a `created_at` of 0 must not decay it to nothing.
    expect(arcs[0].heat).toBeGreaterThan(0.5);
  });

  it('ignores secrets that are mild or barely known', () => {
    const base = {
      id: 1,
      type: 'crush',
      subject_id: 3,
      target_id: null,
      content: 'mild',
      sensitivity: 1,
      known_by: [1, 2, 3, 4],
      created_at: 0,
      is_active: true,
      reliability: 'confirmed',
      source: 'backstory',
      is_public: false,
      revealed_at: null, paid_at: null,
    };
    expect(buildArcs(input({ secrets: [base] }), NOW)).toEqual([]);
    expect(
      buildArcs(input({ secrets: [{ ...base, sensitivity: 4, known_by: [3, 4] }] }), NOW),
    ).toEqual([]);
  });

  it('drops arcs whose participants are no longer in town', () => {
    const arcs = buildArcs(
      input({
        agents: [{ id: 1, name: 'Mara' }],
        relationships: [rel(1, 2, { status: 'rivals' })],
        events: [evt(1, 2, 'fight', -0.8, 5), evt(2, 1, 'confrontation', -0.6, 30)],
      }),
      NOW,
    );
    expect(arcs).toEqual([]);
  });

  it('ranks the hotter arc first', () => {
    const arcs = buildArcs(
      input({
        relationships: [
          rel(1, 2, { status: 'rivals' }),
          rel(3, 4, { status: 'rivals' }),
        ],
        events: [
          evt(1, 2, 'fight', -0.9, 1),
          evt(2, 1, 'fight', -0.9, 2),
          // Same shape, but three game days old — recency decay should sink it.
          evt(3, 4, 'fight', -0.9, 3 * 1440),
          evt(4, 3, 'fight', -0.9, 3 * 1440 + 20),
        ],
      }),
      NOW,
    );
    expect(arcs[0].participants).toEqual([1, 2]);
    expect(arcs[0].heat).toBeGreaterThan(arcs[1].heat);
  });

  it('gives an arc a stable id regardless of participant order', () => {
    const build = (a: number, b: number) =>
      buildArcs(
        input({
          relationships: [rel(a, b, { status: 'rivals' })],
          events: [evt(a, b, 'fight', -0.8, 5), evt(b, a, 'fight', -0.6, 30)],
        }),
        NOW,
      )[0].id;
    expect(build(1, 2)).toBe(build(2, 1));
  });
});

describe('buildArcs on the game clock', () => {
  const DAY = 1440;

  it('keeps an arc whose turning points are days old', () => {
    const arcs = buildArcs(
      input({
        relationships: [rel(1, 2, { status: 'rivals' })],
        events: [evt(1, 2, 'fight', -0.8, 10 * DAY), evt(2, 1, 'confrontation', -0.6, 10 * DAY + 30)],
      }),
      NOW,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0].kind).toBe('rivalry');
    expect(arcs[0].lastActivity).toBe(NOW - 10 * DAY);
    // Faded, not gone.
    expect(arcs[0].heat).toBeGreaterThan(0);
  });

  it('shows the turning points, not just the newest small talk', () => {
    const smallTalk = Array.from({ length: 20 }, (_, i) =>
      evt(1, 2, 'conversation', 0.2, 60 + i * 60),
    );
    const arcs = buildArcs(
      input({
        relationships: [rel(1, 2, { status: 'partners', romance_ab: 80, romance_ba: 80 })],
        events: [
          ...smallTalk,
          evt(1, 2, 'confession', 0.9, 5 * DAY, { romance_delta_ab: 10 }),
        ],
      }),
      NOW,
    );
    const beats = arcs[0].beats;
    expect(beats.length).toBeLessThanOrEqual(8);
    // The confession opens the story...
    expect(beats[0].eventType).toBe('confession');
    // ...and the latest exchange still closes it.
    expect(beats[beats.length - 1].gameMinute).toBe(NOW - 60);
    // Chronological throughout.
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i].gameMinute!).toBeGreaterThanOrEqual(beats[i - 1].gameMinute!);
    }
  });

  it('accepts events in any order', () => {
    const ordered = [evt(1, 2, 'fight', -0.8, 5), evt(2, 1, 'confrontation', -0.6, 30)];
    const build = (events: ChronicleInput['events']) =>
      buildArcs(input({ relationships: [rel(1, 2, { status: 'rivals' })], events }), NOW)[0];
    expect(build([...ordered].reverse())).toEqual(build(ordered));
  });

  it('decays heat by game time: a game day halves it', () => {
    const build = (now: number) =>
      buildArcs(
        input({
          relationships: [rel(1, 2, { status: 'rivals' })],
          // Light enough that the 0..1 cap doesn't hide the decay.
          events: [evt(1, 2, 'argument', -0.2, 0), evt(2, 1, 'argument', -0.2, 0)],
        }),
        now,
      )[0].heat;
    expect(build(NOW + DAY)).toBeCloseTo(build(NOW) / 2, 5);
  });

  it('leaves undated scandal beats undated', () => {
    const arcs = buildArcs(
      input({
        secrets: [{
          id: 1, type: 'secret_told', subject_id: 3, target_id: null, content: 'x', sensitivity: 5,
          known_by: [1, 2, 3], created_at: 0, is_active: true, reliability: 'confirmed',
          source: 'backstory', is_public: false, revealed_at: null, paid_at: null,
        }],
      }),
      NOW,
    );
    expect(arcs[0].beats[0].gameMinute).toBeNull();
    expect(arcs[0].lastActivity).toBe(0);
  });
});

/**
 * Intimacy in the Stories tab (lib/intimacy/). The player is a spectator and sees every
 * thread, secret or not; the arcs that would give a hidden couple away carry `secret`, which
 * the Town Crier drops (gazette.test.ts). Wording stays discreet: nothing here narrates a night.
 */
describe('buildArcs and intimacy', () => {
  const secretFact = (over: Partial<ChronicleInput['secrets'][number]>): ChronicleInput['secrets'][number] => ({
    id: 1, type: 'affair', subject_id: 2, target_id: 3, content: 'Jonas and Edda are getting suspiciously close',
    sensitivity: 3, known_by: [2, 3], created_at: 0, is_active: true, reliability: 'confirmed',
    source: 'committed', is_public: false, revealed_at: null, paid_at: null, ...over,
  });
  /** Mara (1) and Jonas (2) are together; Edda (3) is Jonas' lover. */
  const affairTown = (extra: Partial<ChronicleInput> = {}) => input({
    relationships: [
      rel(1, 2, { status: 'partners', romance_ab: 80, romance_ba: 80, tags: ['partner'] }),
      // Low romance on purpose: the torch-carrying triangle needs > 40, the act does not.
      rel(2, 3, { status: 'acquaintances', romance_ab: 20, romance_ba: 20, tags: ['kissed', 'lovers'] }),
    ],
    events: [evt(2, 3, 'first_tryst', 0.8, 30, { romance_delta_ab: 5, romance_delta_ba: 5 })],
    ...extra,
  });

  it('a lover and a spouse make a love triangle, without any torch on the graph', () => {
    const triangle = buildArcs(affairTown(), NOW).find((a) => a.kind === 'love_triangle');
    expect(triangle).toBeDefined();
    expect([...triangle!.participants].sort()).toEqual([1, 2, 3]);
    // The committed one is the anchor, the lover the outsider.
    expect(triangle!.title).toBe('Edda, Jonas and Mara');
    expect(triangle!.summary).toBe('Edda and Jonas are involved, though Jonas is with Mara.');
    // The beats are the lovers' history: the first night is on the arc.
    expect(triangle!.beats.map((b) => b.eventType)).toContain('first_tryst');
  });

  it('is secret while nobody outside the pair knows, and stops being once it is loose', () => {
    const find = (secrets: ChronicleInput['secrets']) =>
      buildArcs(affairTown({ secrets }), NOW).find((a) => a.kind === 'love_triangle')!;
    expect(find([]).secret).toBe(true);
    // The two of them alone: still a secret.
    expect(find([secretFact({ known_by: [2, 3] })]).secret).toBe(true);
    // One witness is a rumour waiting to happen, not the town's business yet.
    expect(find([secretFact({ known_by: [2, 3, 4] })]).secret).toBe(true);
    // Two outsiders, or the whole town: out.
    expect(find([secretFact({ known_by: [2, 3, 1, 4] })]).secret).toBeUndefined();
    expect(find([secretFact({ known_by: [2, 3], is_public: true })]).secret).toBeUndefined();
    // A sighting is the same secret from the other side (its knowers are the witnesses only).
    expect(find([secretFact({ type: 'tryst_seen', known_by: [1, 4] })]).secret).toBeUndefined();
  });

  it('an old fling of somebody who is now with a third person is not a live triangle when they fell out', () => {
    const arcs = buildArcs(affairTown({
      relationships: [
        rel(1, 2, { status: 'partners', romance_ab: 80, romance_ba: 80, tags: ['partner'] }),
        rel(2, 3, { status: 'enemies', tags: ['lovers'] }),
      ],
    }), NOW);
    expect(arcs.find((a) => a.kind === 'love_triangle')).toBeUndefined();
  });

  it('an engaged or married partner counts, and so does a partner found only by tag', () => {
    const married = buildArcs(affairTown({
      relationships: [
        rel(1, 2, { status: 'partners', tags: ['partner', 'married'] }),
        rel(2, 3, { status: 'acquaintances', tags: ['lovers'] }),
      ],
    }), NOW);
    expect(married.find((a) => a.kind === 'love_triangle')).toBeDefined();
    // Lovers with nobody else in the picture are a couple, not a triangle.
    const single = buildArcs(input({
      relationships: [rel(2, 3, { status: 'partners', romance_ab: 70, romance_ba: 70, tags: ['lovers'] })],
      events: [evt(2, 3, 'first_tryst', 0.8, 30, { romance_delta_ab: 5, romance_delta_ba: 5 })],
    }), NOW);
    expect(single.some((a) => a.kind === 'love_triangle')).toBe(false);
    expect(single.find((a) => a.kind === 'romance')?.secret).toBeUndefined();
  });

  it('the hidden couple\'s own romance arc is secret; an open pair of singles is not', () => {
    const hidden = buildArcs(affairTown({
      relationships: [
        rel(1, 2, { status: 'partners', romance_ab: 80, romance_ba: 80, tags: ['partner'] }),
        rel(2, 3, { status: 'partners', romance_ab: 70, romance_ba: 70, tags: ['partner', 'lovers'] }),
      ],
    }), NOW);
    const arc = hidden.find((a) => a.kind === 'romance' && a.participants.includes(3));
    expect(arc?.secret).toBe(true);
    // Mara and Jonas themselves (a public couple with no night on the record) are not secret.
    expect(hidden.find((a) => a.kind === 'romance' && !a.participants.includes(3))?.secret).toBeUndefined();
  });

  it('a same-sex couple who spent a night is a secret in 1900 too', () => {
    const arcs = buildArcs(input({
      agents: [{ id: 1, name: 'Mara', gender: 'female' }, { id: 3, name: 'Edda', gender: 'female' }],
      relationships: [rel(1, 3, { status: 'partners', romance_ab: 70, romance_ba: 70, tags: ['partner', 'lovers'] })],
      events: [evt(1, 3, 'first_tryst', 0.8, 30, { romance_delta_ab: 5, romance_delta_ba: 5 })],
    }), NOW);
    expect(arcs.find((a) => a.kind === 'romance')?.secret).toBe(true);
  });

  it('an unwed pregnancy the town noticed is a scandal arc even when only a couple of people hold it', () => {
    const arcs = buildArcs(input({
      secrets: [secretFact({
        type: 'illegitimate_pregnancy', subject_id: 1, target_id: 2, sensitivity: 3, known_by: [1, 2],
        content: 'Mara is expecting a child out of wedlock, and Jonas is said to be the father', source: 'observed',
      })],
    }), NOW);
    expect(arcs).toHaveLength(1);
    expect(arcs[0]).toMatchObject({ kind: 'scandal', title: 'Whispers follow Mara' });
    expect(arcs[0].secret).toBeUndefined();
    // Another sensitive secret held by two people is still not a scandal.
    expect(buildArcs(input({ secrets: [secretFact({ known_by: [2, 3] })] }), NOW).some((a) => a.kind === 'scandal')).toBe(false);
  });

  describe('with the adult content rule off', () => {
    it('the lovers tag makes no triangle and no secret couple, and the night is not a beat', () => {
      const arcs = buildArcs(affairTown({ adultContent: false }), NOW);
      expect(arcs.find((a) => a.kind === 'love_triangle')).toBeUndefined();
      for (const arc of arcs) {
        expect(arc.beats.map((b) => b.eventType)).not.toContain('first_tryst');
        expect(arc.secret).toBeUndefined();
      }
      // Nothing else links Jonas and Edda but the night, so they are no story at all.
      expect(arcs.some((a) => a.participants.includes(3))).toBe(false);
    });

    it('a hidden couple who turned the rule off is no longer a secret romance arc', () => {
      const town = affairTown({
        relationships: [
          rel(1, 2, { status: 'partners', romance_ab: 80, romance_ba: 80, tags: ['partner'] }),
          rel(2, 3, { status: 'partners', romance_ab: 70, romance_ba: 70, tags: ['partner', 'lovers'] }),
        ],
      });
      expect(buildArcs(town, NOW).find((a) => a.participants.includes(3))?.secret).toBe(true);
      const off = buildArcs({ ...town, adultContent: false }, NOW).find((a) => a.kind === 'romance' && a.participants.includes(3));
      expect(off?.secret).toBeUndefined();
      expect(off?.beats.map((b) => b.eventType) ?? []).not.toContain('first_tryst');
    });

    it('tryst, caught and suspicion events drop out of a romance arc, kisses stay', () => {
      const arcs = buildArcs(input({
        adultContent: false,
        relationships: [rel(2, 3, { status: 'partners', romance_ab: 70, romance_ba: 70, tags: ['kissed'] })],
        events: [
          evt(2, 3, 'first_kiss', 0.7, 90, { romance_delta_ab: 5, romance_delta_ba: 5 }),
          evt(2, 3, 'first_tryst', 0.8, 60, { romance_delta_ab: 5, romance_delta_ba: 5 }),
          evt(2, 3, 'tryst', 0.5, 40),
          evt(2, 3, 'caught', -0.6, 20),
          evt(2, 3, 'suspicion', -0.3, 10),
        ],
      }), NOW);
      const types = arcs.find((a) => a.kind === 'romance')!.beats.map((b) => b.eventType);
      expect(types).toEqual(['first_kiss']);
    });

    it('a sighting or an unwed pregnancy is no scandal arc, while an ordinary secret still is', () => {
      const off = (secret: ChronicleInput['secrets'][number]) =>
        buildArcs(input({ adultContent: false, secrets: [secret], agents: [...AGENTS, { id: 5, name: 'Ilse' }] }), NOW);
      expect(off(secretFact({ type: 'tryst_seen', subject_id: 3, target_id: 2, known_by: [1, 4, 5] }))).toEqual([]);
      expect(off(secretFact({
        type: 'illegitimate_pregnancy', subject_id: 1, target_id: 2, known_by: [1, 2], source: 'observed',
      }))).toEqual([]);
      expect(off(secretFact({ type: 'financial', subject_id: 3, target_id: null, known_by: [1, 4, 5] }))
        .some((a) => a.kind === 'scandal')).toBe(true);
    });
  });

  it('a tryst seen by three, or an affair the spouse learned of, is a scandal arc', () => {
    const arcs = buildArcs(input({
      secrets: [secretFact({ type: 'tryst_seen', subject_id: 3, target_id: 2, known_by: [1, 4, 5] })],
      agents: [...AGENTS, { id: 5, name: 'Ilse' }],
    }), NOW);
    expect(arcs.find((a) => a.kind === 'scandal')?.title).toBe("Edda's secret");
  });
});
