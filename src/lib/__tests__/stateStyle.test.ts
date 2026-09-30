import { describe, it, expect } from 'vitest';
import { STATE_TYPES } from '../../../server/data/stateTypes';
import { EMOTE_NAMES } from '../../components/canvas/emoteFrames';
import { PORTRAIT_MOODS } from '../../components/ui/portraitMood';
import {
  STATE_STYLE,
  STATE_PRIORITY,
  UNSTYLED,
  topState,
  stateLabel,
  stateCss,
} from '../stateStyle';

describe('STATE_STYLE covers every state', () => {
  it('styles a state or lists it in UNSTYLED, never neither and never both', () => {
    for (const t of STATE_TYPES) {
      const ringed = STATE_STYLE[t].ring !== undefined;
      expect(ringed || UNSTYLED.has(t), `${t} has no ring and is not in UNSTYLED`).toBe(true);
      expect(ringed && UNSTYLED.has(t), `${t} has a ring but is listed in UNSTYLED`).toBe(false);
    }
  });

  it('has no entry for a state the server does not know', () => {
    expect(Object.keys(STATE_STYLE).sort()).toEqual([...STATE_TYPES].sort());
    for (const t of UNSTYLED) expect(STATE_TYPES as readonly string[]).toContain(t);
  });

  it('gives every state a label', () => {
    for (const t of STATE_TYPES) expect(STATE_STYLE[t].label.length, t).toBeGreaterThan(0);
  });

  it('uses a distinct ring colour per state', () => {
    const rings = STATE_TYPES.map(t => STATE_STYLE[t].ring).filter((r): r is number => r !== undefined);
    expect(new Set(rings).size).toBe(rings.length);
  });

  it('only names emotes and portrait moods that exist', () => {
    for (const t of STATE_TYPES) {
      const { emote, portrait } = STATE_STYLE[t];
      if (emote) expect(EMOTE_NAMES as readonly string[], `${t} emote`).toContain(emote);
      if (portrait) expect(PORTRAIT_MOODS as readonly string[], `${t} portrait`).toContain(portrait);
    }
  });

  it('keeps the CSS colour in step with the ring colour', () => {
    for (const t of STATE_TYPES) {
      const { ring, css } = STATE_STYLE[t];
      if (ring === undefined) expect(css, t).toBeUndefined();
      else expect(css, t).toBe('#' + ring.toString(16).padStart(6, '0'));
    }
  });
});

describe('envious', () => {
  it('has its own ring, distinct from the sick and drunk ones it sits near', () => {
    const { ring } = STATE_STYLE.envious;
    expect(ring).toBeDefined();
    expect(ring).not.toBe(STATE_STYLE.sick.ring);
    expect(ring).not.toBe(STATE_STYLE.hungover.ring);
    expect(ring).not.toBe(STATE_STYLE.drunk.ring);
    expect(ring).not.toBe(STATE_STYLE.jealous.ring);
  });

  it('reads as angry in the portrait and shows the envy emote', () => {
    expect(STATE_STYLE.envious.portrait).toBe('angry');
    expect(STATE_STYLE.envious.emote).toBe('envy');
  });
});

describe('STATE_PRIORITY', () => {
  it('lists exactly the ringed states, once each', () => {
    const ringed = STATE_TYPES.filter(t => STATE_STYLE[t].ring !== undefined);
    expect([...STATE_PRIORITY].sort()).toEqual([...ringed].sort());
    expect(new Set(STATE_PRIORITY).size).toBe(STATE_PRIORITY.length);
  });

  it('keeps the order the rings always had, with envious right after jealous', () => {
    const legacy = [
      'angry', 'jealous', 'heartbroken', 'infatuated',
      'drunk', 'alcoholic', 'stressed', 'in_debt',
      'depressed', 'lonely', 'sick', 'hungover',
      'euphoric', 'confident', 'grieving',
    ];
    expect(STATE_PRIORITY.filter(s => legacy.includes(s))).toEqual(legacy);
    expect(STATE_PRIORITY.indexOf('envious')).toBe(STATE_PRIORITY.indexOf('jealous') + 1);
  });

  it('puts the adult-layer aftermath under every older state', () => {
    for (const quiet of ['guilty', 'suspicious'] as const) {
      expect(STATE_PRIORITY.indexOf(quiet), quiet).toBeGreaterThan(STATE_PRIORITY.indexOf('grieving'));
    }
  });
});

describe('topState', () => {
  it('returns the highest-priority state whatever order they are listed in', () => {
    expect(topState(['sick', 'angry'])).toBe('angry');
    expect(topState(['angry', 'sick'])).toBe('angry');
    expect(topState(['confident', 'drunk', 'lonely'])).toBe('drunk');
  });

  it('ranks envious below jealous and above heartbroken', () => {
    expect(topState(['envious', 'jealous'])).toBe('jealous');
    expect(topState(['jealous', 'envious'])).toBe('jealous');
    expect(topState(['heartbroken', 'envious'])).toBe('envious');
  });

  it('ignores states without a ring and states it does not know', () => {
    expect(topState([])).toBeUndefined();
    expect(topState(['afterglow'])).toBeUndefined();
    expect(topState(['arrested', 'nonsense'])).toBeUndefined();
    expect(topState(['afterglow', 'guilty'])).toBe('guilty');
  });
});

describe('lookups by raw string', () => {
  it('label and css fall back for unknown states', () => {
    expect(stateLabel('in_debt')).toBe('in debt');
    expect(stateLabel('mystery_state')).toBe('mystery state');
    expect(stateCss('angry', '#000000')).toBe('#ef4444');
    expect(stateCss('afterglow', '#123456')).toBe('#123456');
    expect(stateCss('constructor', '#123456')).toBe('#123456');
  });
});
