import { describe, it, expect } from 'vitest';
import { computeCliques, type CliqueInput } from '../cliques';

const NAMES = ['Mara', 'Jonas', 'Edda', 'Piet', 'Nils', 'Sofie', 'Tomas'];
const AGENTS = NAMES.map((name, i) => ({ id: i + 1, name }));

function rel(
  a: number,
  b: number,
  friendship: number,
): CliqueInput['relationships'][number] {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return {
    id: lo * 100 + hi,
    agent_a: lo,
    agent_b: hi,
    friendship_ab: friendship,
    friendship_ba: friendship,
    romance_ab: 0,
    romance_ba: 0,
    trust_ab: 50,
    trust_ba: 50,
    familiarity: 50,
    interaction_count: 5,
    last_interaction: 0,
    last_interaction_minute: 0,
    average_interaction_sentiment: 0,
    tags: [],
    status: 'friends',
    created_at: 0,
    last_updated: 0,
  };
}

/** Every pair inside `ids` linked at `friendship`. */
function fullyConnect(ids: number[], friendship: number) {
  const out: CliqueInput['relationships'] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push(rel(ids[i], ids[j], friendship));
  }
  return out;
}

describe('computeCliques', () => {
  it('finds nothing in a town with no warm relationships', () => {
    expect(computeCliques({ agents: AGENTS, relationships: [] })).toEqual([]);
  });

  it('ignores a town too small to hold a group', () => {
    expect(
      computeCliques({ agents: AGENTS.slice(0, 2), relationships: [rel(1, 2, 90)] }),
    ).toEqual([]);
  });

  it('will not call a pair a circle', () => {
    const cliques = computeCliques({ agents: AGENTS, relationships: [rel(1, 2, 90)] });
    expect(cliques).toEqual([]);
  });

  it('separates two disconnected friend groups', () => {
    const cliques = computeCliques({
      agents: AGENTS.slice(0, 6),
      relationships: [...fullyConnect([1, 2, 3], 80), ...fullyConnect([4, 5, 6], 80)],
    });
    expect(cliques).toHaveLength(2);
    expect(cliques.map((c) => c.members).sort((a, b) => a[0] - b[0])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('ignores links below the friendship floor', () => {
    const cliques = computeCliques({
      agents: AGENTS.slice(0, 3),
      relationships: fullyConnect([1, 2, 3], 20),
    });
    expect(cliques).toEqual([]);
  });

  it('treats one-sided warmth as too weak to join a circle', () => {
    // Mara adores Jonas; Jonas is indifferent. The weaker direction rules.
    const oneSided = rel(1, 2, 0);
    oneSided.friendship_ab = 90;
    oneSided.friendship_ba = 0;
    const cliques = computeCliques({
      agents: AGENTS.slice(0, 4),
      relationships: [...fullyConnect([2, 3, 4], 80), oneSided],
    });
    expect(cliques).toHaveLength(1);
    expect(cliques[0].members).toEqual([2, 3, 4]);
  });

  it('names a circle after its most connected member', () => {
    // Piet is the hub: strong ties to everyone, while the others are loose.
    const cliques = computeCliques({
      agents: AGENTS.slice(0, 4),
      relationships: [rel(4, 1, 90), rel(4, 2, 90), rel(4, 3, 90), rel(1, 2, 30)],
    });
    expect(cliques).toHaveLength(1);
    expect(cliques[0].name).toBe("Piet's circle");
  });

  it('scores a tight group above a loose one', () => {
    const tight = computeCliques({
      agents: AGENTS.slice(0, 3),
      relationships: fullyConnect([1, 2, 3], 95),
    })[0];
    const loose = computeCliques({
      agents: AGENTS.slice(0, 3),
      relationships: fullyConnect([1, 2, 3], 30),
    })[0];
    expect(tight.cohesion).toBeGreaterThan(loose.cohesion);
    expect(loose.cohesion).toBeGreaterThan(0);
    expect(tight.cohesion).toBeLessThanOrEqual(1);
  });

  it('is deterministic regardless of relationship row order', () => {
    const rels = [...fullyConnect([1, 2, 3], 80), ...fullyConnect([4, 5, 6], 80)];
    const forward = computeCliques({ agents: AGENTS.slice(0, 6), relationships: rels });
    const reversed = computeCliques({
      agents: AGENTS.slice(0, 6),
      relationships: [...rels].reverse(),
    });
    expect(forward.map((c) => c.id)).toEqual(reversed.map((c) => c.id));
    expect(forward.map((c) => c.name)).toEqual(reversed.map((c) => c.name));
  });

  it('drops relationships pointing at agents who are no longer active', () => {
    const cliques = computeCliques({
      agents: AGENTS.slice(0, 3),
      relationships: [...fullyConnect([1, 2, 3], 80), rel(3, 99, 95)],
    });
    expect(cliques).toHaveLength(1);
    expect(cliques[0].members).toEqual([1, 2, 3]);
  });

  it('lists the biggest circle first', () => {
    const cliques = computeCliques({
      agents: AGENTS,
      relationships: [...fullyConnect([1, 2, 3], 80), ...fullyConnect([4, 5, 6, 7], 80)],
    });
    expect(cliques[0].members).toHaveLength(4);
    expect(cliques[1].members).toHaveLength(3);
  });
});
