import { describe, it, expect } from 'vitest';
import { GoalMapper } from '../GoalMapper';

const mapper = new GoalMapper();

describe('GoalMapper', () => {
  describe('mapCategory', () => {
    it('maps romantic hint to flirt/date interactions', () => {
      const result = mapper.mapCategory('romantic');
      expect(result.type).toBe('seduce');
      expect(result.interactions).toContain('flirt');
      expect(result.interactions).toContain('date');
    });

    it('maps hostile hint to fight/rumor interactions', () => {
      const result = mapper.mapCategory('hostile');
      expect(result.type).toBe('revenge');
      expect(result.interactions).toContain('fight');
      expect(result.interactions).toContain('spread_rumor');
    });

    it('maps social hint to comfort/befriend interactions', () => {
      const result = mapper.mapCategory('social');
      expect(result.type).toBe('befriend');
      expect(result.interactions).toContain('comfort');
      expect(result.interactions).toContain('buy_drinks');
    });

    it('maps economic hint to work interactions', () => {
      const result = mapper.mapCategory('economic');
      expect(result.type).toBe('custom');
      expect(result.interactions).toContain('work');
    });

    it('maps investigative hint to eavesdrop/interrogate', () => {
      const result = mapper.mapCategory('investigative');
      expect(result.type).toBe('investigate');
      expect(result.interactions).toContain('eavesdrop');
    });

    it('maps protective hint to comfort/nurse', () => {
      const result = mapper.mapCategory('protective');
      expect(result.type).toBe('protect');
      expect(result.interactions).toContain('comfort');
      expect(result.interactions).toContain('nurse');
    });

    it('maps unknown hint to custom with broad interactions', () => {
      const result = mapper.mapCategory('unknown_thing');
      expect(result.type).toBe('custom');
      expect(result.interactions.length).toBeGreaterThan(3);
    });
  });

  describe('resolveAgentName', () => {
    it('returns null for null input', () => {
      expect(mapper.resolveAgentName(null, [])).toBeNull();
    });

    it('matches exact name case-insensitively', () => {
      const agents = [{ id: 1, name: 'Elena Voss' }, { id: 2, name: 'Marco Rivera' }];
      expect(mapper.resolveAgentName('elena voss', agents)).toBe(1);
    });

    it('matches substring', () => {
      const agents = [{ id: 1, name: 'Elena Voss' }, { id: 2, name: 'Marco Rivera' }];
      expect(mapper.resolveAgentName('Elena', agents)).toBe(1);
    });

    it('returns null for no match', () => {
      const agents = [{ id: 1, name: 'Elena Voss' }];
      expect(mapper.resolveAgentName('Nobody', agents)).toBeNull();
    });
  });
});
