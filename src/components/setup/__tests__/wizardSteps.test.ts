import { describe, it, expect } from 'vitest';
import { STEPS } from '../wizardSteps';

const order = STEPS.map((s) => s.id as string);
const at = (id: string) => order.indexOf(id);

describe('setup wizard step order', () => {
  it('previews the drama only after the cast and their relationships are settled', () => {
    // SimulationPreview keys on {scenario, agents}: shown before the cast was edited, it
    // described a town that Start then built differently.
    expect(at('preview')).toBeGreaterThan(at('agents'));
    expect(at('preview')).toBeGreaterThan(at('relationships'));
  });

  it('lays out the world after the relationships (households are placed by the graph)', () => {
    expect(at('worldlayout')).toBeGreaterThan(at('relationships'));
  });

  it('starts on the scenario and lists every step exactly once', () => {
    expect(order[0]).toBe('scenario');
    expect(new Set(order).size).toBe(order.length);
    expect([...order].sort()).toEqual(
      ['agents', 'preview', 'relationships', 'rules', 'scenario', 'world', 'worldlayout'],
    );
  });
});
