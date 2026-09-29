import { describe, it, expect } from 'vitest';
import {
  bioHook,
  buildResidentCards,
  relationLabel,
  secretsLine,
  type TourAgent,
  type TourRelationship,
} from '../townTour';

const agent = (id: number, name: string, extra: Partial<TourAgent> = {}): TourAgent => ({
  id,
  name,
  age: 30 + id,
  bio: `${name} is a resident.`,
  ...extra,
});

const rel = (
  a: number,
  b: number,
  friendship: number,
  status: string,
  romance = 0,
): TourRelationship => ({
  agent_a: a,
  agent_b: b,
  friendship_ab: friendship,
  friendship_ba: friendship,
  romance_ab: romance,
  romance_ba: romance,
  status,
});

const base = { secrets: [], arcs: [], places: [] };

describe('bioHook', () => {
  it('keeps only the first sentence', () => {
    expect(bioHook('Baker of the village. Loves cats. Hates rain.')).toBe('Baker of the village.');
  });

  it('cuts a long sentence at a word boundary with an ellipsis', () => {
    const hook = bioHook(
      'She has spent forty years telling everyone in the valley exactly what she thinks of their bread and their gardens and their children',
      60,
    );
    expect(hook.endsWith('…')).toBe(true);
    expect(hook.length).toBeLessThanOrEqual(61);
    expect(hook).not.toMatch(/\s…$/);
  });

  it('tolerates empty and unpunctuated bios', () => {
    expect(bioHook('')).toBe('');
    expect(bioHook('  A quiet   soul ')).toBe('A quiet soul');
  });
});

describe('labels', () => {
  it('humanises known and unknown statuses', () => {
    expect(relationLabel('best_friends')).toBe('best friends');
    expect(relationLabel('some_new_status')).toBe('some new status');
  });

  it('pluralises the secrets line and stays silent at zero', () => {
    expect(secretsLine(0)).toBeNull();
    expect(secretsLine(1)).toBe('hides 1 secret');
    expect(secretsLine(3)).toBe('hides 3 secrets');
  });
});

describe('buildResidentCards', () => {
  const agents = [agent(1, 'Ana'), agent(2, 'Ben'), agent(3, 'Cy'), agent(4, 'Dot')];

  it('picks the warmest tie and the coldest rival', () => {
    const [ana] = buildResidentCards({
      ...base,
      agents,
      relationships: [rel(1, 2, 50, 'friends'), rel(3, 1, 85, 'close_friends'), rel(1, 4, -60, 'rivals')],
    });
    expect(ana.tie).toEqual({ id: 3, name: 'Cy', label: 'close friends' });
    expect(ana.rival).toEqual({ id: 4, name: 'Dot', label: 'rivals' });
  });

  it('lets a partner outrank a warmer friend', () => {
    const [ana] = buildResidentCards({
      ...base,
      agents,
      relationships: [rel(1, 2, 75, 'close_friends'), rel(1, 3, 60, 'partners', 90)],
    });
    expect(ana.tie?.name).toBe('Cy');
  });

  it('reports nothing for lukewarm acquaintances', () => {
    const [ana] = buildResidentCards({
      ...base,
      agents,
      relationships: [rel(1, 2, 5, 'acquaintances'), rel(1, 3, -5, 'acquaintances')],
    });
    expect(ana.tie).toBeNull();
    expect(ana.rival).toBeNull();
  });

  it('ignores relationships with residents who left the town', () => {
    const [ana] = buildResidentCards({ ...base, agents, relationships: [rel(1, 99, 95, 'best_friends')] });
    expect(ana.tie).toBeNull();
  });

  it('lists a person once when they qualify as both tie and rival', () => {
    const [ana] = buildResidentCards({
      ...base,
      agents: agents.slice(0, 2),
      relationships: [rel(1, 2, -30, 'complicated', 60)],
    });
    expect(ana.tie).toBeNull();
    expect(ana.rival?.name).toBe('Ben');
  });

  it('counts only hidden secrets about the resident, never their content', () => {
    const cards = buildResidentCards({
      ...base,
      agents,
      relationships: [],
      secrets: [
        { subjectName: 'Ana', isPublic: false },
        { subjectName: 'Ana', isPublic: false },
        { subjectName: 'Ana', isPublic: true },
        { subjectName: 'Ben', isPublic: false },
        { subjectName: null, isPublic: false },
      ],
    });
    expect(cards.map((c) => c.secretCount)).toEqual([2, 1, 0, 0]);
  });

  it('attaches the arcs a resident takes part in and their workplace', () => {
    const cards = buildResidentCards({
      ...base,
      agents: [agent(1, 'Ana', { workplace: 7 }), agent(2, 'Ben', { workplace: 8 })],
      relationships: [],
      places: [{ id: 7, name: 'Bakery' }],
      arcs: [
        { id: 'a1', kind: 'romance', title: 'Ana and Ben', participants: [1, 2] },
        { id: 'a2', kind: 'scandal', title: 'The missing ledger', participants: [2] },
      ],
    });
    expect(cards[0].workplace).toBe('Bakery');
    expect(cards[1].workplace).toBeNull();
    expect(cards[0].arcs.map((a) => a.id)).toEqual(['a1']);
    expect(cards[1].arcs.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});
