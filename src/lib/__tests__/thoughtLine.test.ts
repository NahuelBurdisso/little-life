import { describe, it, expect } from 'vitest';
import { STATE_TYPES } from '../../../server/data/stateTypes';
import { THOUGHT_MAX_CHARS, conversationOf, thoughtOf, type ThoughtAgent, type ThoughtContext } from '../thoughtLine';

const NAMES: Record<number, string> = { 1: 'Mara', 2: 'Jonas', 3: 'Rosa' };
const ctx = (extra: Partial<ThoughtContext> = {}): ThoughtContext => ({ nameOf: (id) => NAMES[id], ...extra });

const FINE = { hunger: 80, energy: 80, social: 80, mood: 60, stress: 10 };
const agent = (states: ThoughtAgent['activeStates'] = [], needs: ThoughtAgent['needs'] = FINE): ThoughtAgent => ({
  id: 1, name: 'Mara', needs, activeStates: states,
});
const st = (type: string, target?: number | null) => ({ type, target_agent_id: target ?? null });
const chat = { participants: [1, 2], topic: 'flirting', trigger_reason: 'needs_social' };

describe('thoughtOf priority', () => {
  it('arrested beats grieving', () => {
    expect(thoughtOf(agent([st('grieving', 2), st('arrested')]), ctx({ conversation: chat })).text).toMatch(/arrest/i);
  });

  it('grieving beats talking', () => {
    const t = thoughtOf(agent([st('grieving', 2)]), ctx({ conversation: chat }));
    expect(t.text).toMatch(/griev/i);
    expect(t.text).not.toMatch(/flirt/i);
  });

  it('talking beats infatuated and sick', () => {
    const t = thoughtOf(agent([st('sick'), st('infatuated', 3)]), ctx({ conversation: chat }));
    expect(t.text).toBe('Mara flirts with Jonas');
  });

  it('sick beats drunk, drunk beats a starving stomach, a need beats plain mood', () => {
    expect(thoughtOf(agent([st('drunk'), st('sick')]), ctx()).text).toMatch(/unwell|sick|ill/i);
    expect(thoughtOf(agent([st('drunk')], { ...FINE, hunger: 5 }), ctx()).text).toMatch(/drink|tipsy|wine/i);
    expect(thoughtOf(agent([], { ...FINE, hunger: 5, mood: 95 }), ctx()).text).toMatch(/eat/i);
  });

  it('follows the order grieving > heartbroken > jealous > envious > angry', () => {
    const order = ['grieving', 'heartbroken', 'jealous', 'envious', 'angry'];
    for (let i = 0; i < order.length - 1; i++) {
      const both = thoughtOf(agent([st(order[i + 1], 3), st(order[i], 2)]), ctx());
      const alone = thoughtOf(agent([st(order[i], 2)]), ctx());
      expect(both.text, order[i]).toBe(alone.text);
    }
  });

  it('plain mood only speaks when nothing else does', () => {
    expect(thoughtOf(agent([], { ...FINE, mood: 95 }), ctx()).text).toMatch(/great|good/i);
  });
});

describe('thoughtOf names', () => {
  it('names the target of a feeling', () => {
    expect(thoughtOf(agent([st('heartbroken', 2)]), ctx()).text).toContain('Jonas');
    expect(thoughtOf(agent([st('jealous', 3)]), ctx()).text).toContain('Rosa');
    expect(thoughtOf(agent([st('infatuated', 2)]), ctx()).text).toContain('Jonas');
  });

  it('falls back to "someone" when the name is unknown or there is no target', () => {
    expect(thoughtOf(agent([st('angry', 99)]), ctx()).text).toContain('someone');
    expect(thoughtOf(agent([st('angry')]), ctx()).text).toContain('someone');
    expect(thoughtOf(agent([st('infatuated', 99)]), ctx()).text).toContain('someone');
  });

  it('says the conversation in one line, unknown participants as "someone"', () => {
    const convo = { participants: [1, 99], topic: 'confrontation', trigger_reason: 'x' };
    expect(thoughtOf(agent(), ctx({ conversation: convo })).text).toBe('Mara confronts someone');
  });

  it('never prints the fact of a told secret', () => {
    const convo = { participants: [1, 2], topic: 'revealing: Jonas stole the ledger', trigger_reason: 'player_tell_secret' };
    expect(thoughtOf(agent(), ctx({ conversation: convo })).text).not.toMatch(/ledger/);
  });

  it('never guesses a gender', () => {
    for (const type of STATE_TYPES) {
      expect(thoughtOf(agent([st(type, 2)]), ctx()).text, type).not.toMatch(/\b(he|she|his|her|him|hers)\b/i);
    }
  });
});

describe('thoughtOf discretion', () => {
  it('afterglow is exactly the discreet wording', () => {
    expect(thoughtOf(agent([st('afterglow')]), ctx()).text).toBe('In a warm, faraway mood.');
  });

  it('suspicion wonders about the partner, guilt keeps the secret', () => {
    expect(thoughtOf(agent([st('suspicious', 2)]), ctx()).text).toBe('Wondering where Jonas goes at night.');
    expect(thoughtOf(agent([st('suspicious', 99)]), ctx()).text).toBe('Wondering where someone goes at night.');
    expect(thoughtOf(agent([st('guilty', 2)]), ctx()).text).toBe("Carrying something they won't say.");
  });

  it('non-intimacy states use no adult words', () => {
    const adult = /kiss|sex|bed\b|lover|affair|tryst|rendezvous|intimate|naked|passion|night together/i;
    for (const type of STATE_TYPES) {
      if (type === 'afterglow' || type === 'guilty' || type === 'suspicious') continue;
      expect(thoughtOf(agent([st(type, 2)]), ctx()).text, type).not.toMatch(adult);
    }
  });
});

describe('thoughtOf coverage', () => {
  it('every state gives some text and a tone when it is the only state', () => {
    for (const type of STATE_TYPES) {
      const t = thoughtOf(agent([st(type, 2)]), ctx());
      expect(t.text.trim().length, type).toBeGreaterThan(0);
      expect(['dark', 'warm', 'bright', 'neutral']).toContain(t.tone);
    }
  });

  it('every state gives its own line, not the mood fallback, even with no needs row', () => {
    const baseline = thoughtOf(agent([], null), ctx()).text;
    for (const type of STATE_TYPES) {
      expect(thoughtOf(agent([st(type, 2)], null), ctx()).text, type).not.toBe(baseline);
    }
  });

  it('copes with missing needs and states', () => {
    expect(thoughtOf({ name: 'Mara' }, ctx()).text.length).toBeGreaterThan(0);
    expect(thoughtOf(agent([], null), ctx()).text.length).toBeGreaterThan(0);
  });

  it('is tinted by how the resident feels', () => {
    expect(thoughtOf(agent([st('arrested')]), ctx()).tone).toBe('dark');
    expect(thoughtOf(agent([st('infatuated', 2)]), ctx()).tone).toBe('warm');
    expect(thoughtOf(agent([], { ...FINE, mood: 95 }), ctx()).tone).toBe('bright');
  });
});

describe('thoughtOf clamp', () => {
  it('cuts a long line to the limit', () => {
    const long: Record<number, string> = { ...NAMES, 2: 'Bartholomew Fitzgerald-Montgomery the Third of Nowhere-in-Particular and Beyond' };
    const t = thoughtOf(agent([st('heartbroken', 2)]), { nameOf: (id) => long[id] });
    expect(t.text.length).toBeLessThanOrEqual(THOUGHT_MAX_CHARS);
    expect(t.text.endsWith('…')).toBe(true);
    expect(THOUGHT_MAX_CHARS).toBe(90);
  });

  it('cuts a long conversation topic', () => {
    const convo = { participants: [1, 2], topic: 'the price of turnips at the harvest fair and why nobody ever buys enough of them', trigger_reason: 'x' };
    const t = thoughtOf(agent(), ctx({ conversation: convo }));
    expect(t.text.length).toBeLessThanOrEqual(THOUGHT_MAX_CHARS);
  });
});

describe('conversationOf', () => {
  const convos = [
    { participants: [2, 3], topic: null, trigger_reason: 'a' },
    { participants: [3, 1], topic: 'x', trigger_reason: 'b' },
  ];

  it('finds the talk a resident is in', () => {
    expect(conversationOf(1, convos)).toBe(convos[1]);
    expect(conversationOf('1', convos)).toBe(convos[1]);
  });

  it('is null when they are not in one', () => {
    expect(conversationOf(9, convos)).toBeNull();
    expect(conversationOf(1, undefined)).toBeNull();
  });
});
