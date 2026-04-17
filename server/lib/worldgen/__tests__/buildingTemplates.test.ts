import { describe, it, expect } from 'vitest';
import {
  BUILDING_TEMPLATES,
  CORE_TEMPLATES,
  getTemplatesForAgentCount,
} from '../buildingTemplates';

describe('building template registry', () => {
  it('has 7 core templates', () => {
    expect(CORE_TEMPLATES).toHaveLength(7);
  });

  it('has 12 total templates', () => {
    expect(BUILDING_TEMPLATES).toHaveLength(12);
  });

  it('no duplicate IDs', () => {
    const ids = BUILDING_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no duplicate names', () => {
    const names = BUILDING_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all templates have valid size (w > 0, h > 0)', () => {
    for (const t of BUILDING_TEMPLATES) {
      expect(t.size.w).toBeGreaterThan(0);
      expect(t.size.h).toBeGreaterThan(0);
    }
  });

  it('all templates have at least one zone weight > 0', () => {
    for (const t of BUILDING_TEMPLATES) {
      const maxWeight = Math.max(...Object.values(t.zoneWeights));
      expect(maxWeight).toBeGreaterThan(0);
    }
  });

  it('core templates have minAgents = 0', () => {
    for (const t of CORE_TEMPLATES) {
      expect(t.minAgents).toBe(0);
    }
  });

  it('optional templates have minAgents > 0', () => {
    const optional = BUILDING_TEMPLATES.filter((t) => t.category === 'optional');
    for (const t of optional) {
      expect(t.minAgents).toBeGreaterThan(0);
    }
  });

  it('getTemplatesForAgentCount returns only core for 0 agents', () => {
    const result = getTemplatesForAgentCount(0);
    expect(result).toHaveLength(7);
    expect(result.every((t) => t.category === 'core')).toBe(true);
  });

  it('getTemplatesForAgentCount includes bakery at 6 agents', () => {
    const result = getTemplatesForAgentCount(6);
    expect(result.find((t) => t.id === 'bakery')).toBeDefined();
  });

  it('getTemplatesForAgentCount includes all at 12 agents', () => {
    const result = getTemplatesForAgentCount(12);
    expect(result).toHaveLength(12);
  });

  it('canonical names match maps.ts building names', () => {
    const expected: Record<string, string> = {
      shop: "Rosa's General Store",
      tavern: 'The Rusty Lantern',
      clinic: "Dr. Petrov's Clinic",
      town_hall: 'Town Hall',
      town_square: 'Town Square',
      farm: 'Green Acres Farm',
      park: 'Riverside Park',
      bakery: "Priya's Bakery",
      workshop: "Carlos' Workshop",
      prison: 'Town Jail',
    };
    for (const [id, name] of Object.entries(expected)) {
      const t = BUILDING_TEMPLATES.find((t) => t.id === id);
      expect(t?.name).toBe(name);
    }
  });
});
