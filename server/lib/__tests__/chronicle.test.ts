import { describe, it, expect } from 'vitest';
import { buildArcs, type ChronicleInput } from '../chronicle';

const NOW = 1_700_000_000_000;

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
    timestamp: NOW - minutesAgo * 60_000,
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
    expect(first.timestamp).toBeLessThan(second.timestamp);
    expect(arcs[0].lastActivity).toBe(second.timestamp);
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
      revealed_at: null,
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
      revealed_at: null,
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
          // Same shape, but hours old — recency decay should sink it.
          evt(3, 4, 'fight', -0.9, 600),
          evt(4, 3, 'fight', -0.9, 620),
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
