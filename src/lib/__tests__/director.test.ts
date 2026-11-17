import { describe, it, expect } from 'vitest';
import {
  DIRECTOR,
  INITIAL_DIRECTOR_STATE,
  buildCandidates,
  inferTier,
  pickRoamStop,
  scoreAlert,
  scoreConversation,
  GATHERING_SHOT_BONUS,
  scoreEvent,
  stepDirector,
  type Candidate,
  type DirectorConversation,
  type DirectorInput,
  type DirectorState,
  type WorldSnapshot,
} from '../director';

const T0 = 1_000_000;
const NONE = new Set<string>();

function convo(over: Partial<DirectorConversation> & { id: number }): DirectorConversation {
  return {
    participants: [1, 2],
    messages: [{ text: 'hi' }, { text: 'hello' }],
    topic: 'weather',
    trigger_reason: 'needs_social',
    sentiment: 0,
    max_turns: 4,
    location: 10,
    ...over,
  };
}

function input(over: Partial<DirectorInput> = {}): DirectorInput {
  return {
    now: T0,
    conversations: [],
    brewing: [],
    alerts: [],
    events: [],
    interventions: [],
    favorites: NONE,
    ...over,
  };
}

function cand(key: string, score: number, over: Partial<Candidate> = {}): Candidate {
  return { key, kind: 'conversation', score, agentIds: [Number(key.replace(/\D/g, '')) || 1], locationId: null, label: key, ...over };
}

const WORLD: WorldSnapshot = {
  locations: [
    { id: 10, name: 'Tavern' },
    { id: 11, name: 'Bakery' },
    { id: 12, name: 'Farm' },
    { id: 13, name: 'Chapel' },
  ],
  agents: [
    { id: 1, current_location: 10 },
    { id: 2, current_location: 10 },
    { id: 3, current_location: 10 },
    { id: 4, current_location: 11 },
    { id: 5, current_location: 11 },
    { id: 6, current_location: 12 },
    { id: 7, current_location: 13, current_action: { type: 'sleeping' } },
  ],
};

/** Runs steps one after another and returns the last result plus every cut. */
function run(state: DirectorState, steps: Array<{ at: number; candidates: Candidate[] }>) {
  const cuts: Array<string | undefined> = [];
  let s = state;
  for (const step of steps) {
    const r = stepDirector(s, step.candidates, step.at, WORLD);
    s = r.state;
    cuts.push(r.cut?.key);
  }
  return { state: s, cuts };
}

describe('tier inference', () => {
  it('reads player-made and dramatic conversations as deep', () => {
    expect(inferTier({ trigger_reason: 'player_nudge', topic: null, max_turns: 4 })).toBe('llm_deep');
    expect(inferTier({ trigger_reason: 'needs_social', topic: 'confrontation', max_turns: 4 })).toBe('llm_deep');
    expect(inferTier({ trigger_reason: 'needs_social', topic: 'weather', max_turns: 6 })).toBe('llm_deep');
    expect(inferTier({ trigger_reason: 'needs_social', topic: 'weather', max_turns: 4 })).toBe('llm_standard');
    expect(inferTier({ trigger_reason: 'needs_social (template)', topic: 'weather', max_turns: 3 })).toBe('template');
  });
});

describe('scoring', () => {
  const ctx = { brewing: [], favorites: NONE };

  it('ranks tiers deep > standard > template', () => {
    const deep = scoreConversation(convo({ id: 1, trigger_reason: 'player_nudge' }), ctx);
    const standard = scoreConversation(convo({ id: 2 }), ctx);
    const template = scoreConversation(convo({ id: 3, trigger_reason: 'needs_social (template)' }), ctx);
    expect(deep).toBeGreaterThan(standard);
    expect(standard).toBeGreaterThan(template);
  });

  it('a chat at a gathering is a better shot than the same chat alone', () => {
    const alone = scoreConversation(convo({ id: 1, trigger_reason: 'location_encounter:town_square' }), ctx);
    const atFuneral = scoreConversation(convo({ id: 1, trigger_reason: 'gathering:funeral' }), ctx);
    expect(atFuneral - alone).toBe(GATHERING_SHOT_BONUS);
  });

  it('prefers confrontation, secret and romance topics over small talk', () => {
    const base = scoreConversation(convo({ id: 1, topic: 'weather' }), ctx);
    for (const topic of ['confrontation', 'sharing secrets', 'flirting', 'gossip about Mara']) {
      expect(scoreConversation(convo({ id: 1, topic }), ctx)).toBeGreaterThan(base);
    }
    expect(scoreConversation(convo({ id: 1, topic: 'confrontation' }), ctx))
      .toBeGreaterThan(scoreConversation(convo({ id: 1, topic: 'gossip about Mara' }), ctx));
  });

  it('adds participants\' brewing heat and favourites', () => {
    const plain = scoreConversation(convo({ id: 1 }), ctx);
    const tense = scoreConversation(convo({ id: 1 }), {
      ...ctx,
      brewing: [{ id: 'snap:1', kind: 'snap', agentIds: [2], heat: 0.9 }],
    });
    const starred = scoreConversation(convo({ id: 1 }), { ...ctx, favorites: new Set(['1']) });
    const bothStarred = scoreConversation(convo({ id: 1 }), { ...ctx, favorites: new Set(['1', '2']) });
    expect(tense).toBeGreaterThan(plain + 20);
    expect(starred).toBeGreaterThan(plain);
    expect(bothStarred).toBeGreaterThan(starred);
  });

  it('waits for a first line before a new conversation is worth a cut', () => {
    expect(scoreConversation(convo({ id: 1, messages: [] }), ctx)).toBeLessThan(scoreConversation(convo({ id: 1 }), ctx));
  });

  it('orders alert tiers and fades them with age', () => {
    const a = (tier: 'player' | 'major' | 'minor', shownAt = T0) => ({ id: 1, tier, agentIds: [1], shownAt, label: '' });
    expect(scoreAlert(a('player'), T0, NONE)).toBeGreaterThan(scoreAlert(a('major'), T0, NONE));
    expect(scoreAlert(a('major'), T0, NONE)).toBeGreaterThan(scoreAlert(a('minor'), T0, NONE));
    expect(scoreAlert(a('major'), T0 + 15_000, NONE)).toBeLessThan(scoreAlert(a('major'), T0, NONE));
    expect(scoreAlert(a('major'), T0 + DIRECTOR.ALERT_FRESH_MS, NONE)).toBe(0);
  });

  it('lets a world event fade into a backdrop under the idle bar', () => {
    const e = { id: 1, name: 'Festival', locationId: 10, firstSeenAt: T0 };
    expect(scoreEvent(e, T0 + 1000)).toBeGreaterThan(DIRECTOR.IDLE_SCORE);
    expect(scoreEvent(e, T0 + 10 * 60_000)).toBeLessThan(DIRECTOR.IDLE_SCORE);
  });
});

describe('candidates', () => {
  it('sorts best first and skips alerts nobody is in, and events with no place', () => {
    const list = buildCandidates(input({
      conversations: [convo({ id: 1 }), convo({ id: 2, participants: [3, 4], trigger_reason: 'player_confront', topic: 'confrontation' })],
      alerts: [{ id: 9, tier: 'major', agentIds: [], shownAt: T0, label: 'x' }],
      events: [{ id: 5, name: 'Storm', locationId: null, firstSeenAt: T0 }],
    }));
    expect(list.map((c) => c.key)).toEqual(['convo:2', 'convo:1']);
  });

  it('folds an alert about people already talking into their conversation', () => {
    const plain = buildCandidates(input({ conversations: [convo({ id: 1 })] }))[0].score;
    const list = buildCandidates(input({
      conversations: [convo({ id: 1 })],
      alerts: [{ id: 9, tier: 'major', agentIds: [2], shownAt: T0, label: 'x' }],
    }));
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('convo:1');
    expect(list[0].score).toBeGreaterThan(plain);
  });

  it('keeps an alert about someone not in a conversation as its own shot', () => {
    const list = buildCandidates(input({
      conversations: [convo({ id: 1 })],
      alerts: [{ id: 9, tier: 'major', agentIds: [5], shownAt: T0, label: 'Big news' }],
    }));
    expect(list.map((c) => c.key)).toContain('alert:9');
  });

  it('offers only near-boiling snaps and confrontations from the brewing list', () => {
    const list = buildCandidates(input({
      brewing: [
        { id: 'snap:5', kind: 'snap', agentIds: [5], heat: 0.95 },
        { id: 'snap:6', kind: 'snap', agentIds: [6], heat: 0.3 },
        { id: 'goal:7', kind: 'goal', agentIds: [7], heat: 0.99 },
      ],
    }));
    expect(list.map((c) => c.key)).toEqual(['brew:snap:5']);
  });

  it('turns the player\'s own nudge into a shot that fades', () => {
    const now = buildCandidates(input({ interventions: [{ id: 1, agentIds: [4], at: T0, label: 'nudge' }] }));
    const late = buildCandidates(input({
      now: T0 + DIRECTOR.INTERVENTION_FRESH_MS + 1,
      interventions: [{ id: 1, agentIds: [4], at: T0, label: 'nudge' }],
    }));
    expect(now[0].kind).toBe('intervention');
    expect(late).toHaveLength(0);
  });
});

describe('roam', () => {
  it('goes to the busiest place with awake residents, ignoring the sleeping', () => {
    expect(pickRoamStop(WORLD.locations, WORLD.agents, [])?.id).toBe(10);
  });

  it('skips recent stops, then repeats rather than going dark', () => {
    expect(pickRoamStop(WORLD.locations, WORLD.agents, [10])?.id).toBe(11);
    expect(pickRoamStop(WORLD.locations, WORLD.agents, [10, 11, 12])?.id).toBe(10);
  });

  it('never roams into a private home', () => {
    const locations = [{ id: 20, name: 'Home 2', type: 'home' }, { id: 21, name: 'Well', type: 'plaza' }];
    const agents = [
      { id: 1, current_location: 20 },
      { id: 2, current_location: 20 },
      { id: 3, current_location: 21 },
    ];
    expect(pickRoamStop(locations, agents, [])?.id).toBe(21);
    expect(pickRoamStop(locations.slice(0, 1), agents, [])).toBeNull();
  });

  it('has nowhere to go in an empty town', () => {
    expect(pickRoamStop(WORLD.locations, [], [])).toBeNull();
  });
});

describe('stepDirector', () => {
  it('opens on the best candidate', () => {
    const r = stepDirector(INITIAL_DIRECTOR_STATE, [cand('convo:2', 40), cand('convo:1', 70)], T0, WORLD);
    expect(r.cut?.key).toBe('convo:1');
    expect(r.state.current?.since).toBe(T0);
  });

  it('roams when nothing clears the idle bar', () => {
    const r = stepDirector(INITIAL_DIRECTOR_STATE, [cand('convo:1', DIRECTOR.IDLE_SCORE - 1)], T0, WORLD);
    expect(r.cut?.kind).toBe('roam');
    expect(r.cut?.locationId).toBe(10);
  });

  it('holds a shot for its minimum time whatever appears', () => {
    const { state, cuts } = run(INITIAL_DIRECTOR_STATE, [
      { at: T0, candidates: [cand('convo:1', 50)] },
      { at: T0 + 3000, candidates: [cand('convo:1', 50), cand('convo:2', 200)] },
      { at: T0 + DIRECTOR.MIN_HOLD_MS.conversation - 1, candidates: [cand('convo:2', 200)] },
    ]);
    expect(cuts).toEqual(['convo:1', undefined, undefined]);
    expect(state.current?.key).toBe('convo:1');
  });

  it('cuts to a clearly better shot once the hold is over', () => {
    const { cuts } = run(INITIAL_DIRECTOR_STATE, [
      { at: T0, candidates: [cand('convo:1', 50)] },
      { at: T0 + DIRECTOR.MIN_HOLD_MS.conversation, candidates: [cand('convo:1', 50), cand('convo:2', 50 + DIRECTOR.SWITCH_MARGIN + 5)] },
    ]);
    expect(cuts).toEqual(['convo:1', 'convo:2']);
  });

  it('does not cut for a marginally better shot (hysteresis)', () => {
    const { cuts } = run(INITIAL_DIRECTOR_STATE, [
      { at: T0, candidates: [cand('convo:1', 50)] },
      { at: T0 + DIRECTOR.MIN_HOLD_MS.conversation, candidates: [cand('convo:1', 50), cand('convo:2', 50 + DIRECTOR.SWITCH_MARGIN - 1)] },
      { at: T0 + 2 * DIRECTOR.MIN_HOLD_MS.conversation, candidates: [cand('convo:1', 50), cand('convo:2', 50 + DIRECTOR.SWITCH_MARGIN - 1)] },
    ]);
    expect(cuts).toEqual(['convo:1', undefined, undefined]);
  });

  it('does not ping-pong between two similar scenes', () => {
    // Scores wobble around each other; the lead flips every tick but the margin is never beaten.
    const steps: Array<{ at: number; candidates: Candidate[] }> = [];
    for (let i = 0; i < 40; i++) {
      const wobble = i % 2 === 0 ? 4 : -4;
      steps.push({ at: T0 + i * DIRECTOR.TICK_MS, candidates: [cand('convo:1', 60 + wobble), cand('convo:2', 60 - wobble)] });
    }
    const { cuts } = run(INITIAL_DIRECTOR_STATE, steps);
    expect(cuts.filter(Boolean)).toHaveLength(1);
  });

  it('after a cut away, the shot it left is docked so it cannot bounce straight back', () => {
    const first = stepDirector(INITIAL_DIRECTOR_STATE, [cand('convo:1', 60)], T0, WORLD);
    const t1 = T0 + DIRECTOR.MIN_HOLD_MS.conversation;
    const second = stepDirector(first.state, [cand('convo:1', 60), cand('convo:2', 90)], t1, WORLD);
    expect(second.cut?.key).toBe('convo:2');
    // 60 beats 40 + the margin (55), so without the fatigue dock this would bounce straight back.
    const t2 = t1 + DIRECTOR.MIN_HOLD_MS.conversation;
    const third = stepDirector(second.state, [cand('convo:1', 60), cand('convo:2', 40)], t2, WORLD);
    expect(third.cut).toBeNull();
    // Long after the dock has faded it is fair game again.
    const later = stepDirector(second.state, [cand('convo:1', 60), cand('convo:2', 40)], t1 + DIRECTOR.FATIGUE_MS, WORLD);
    expect(later.cut?.key).toBe('convo:1');
  });

  it('moves on to the next best when the current scene ends', () => {
    const { cuts } = run(INITIAL_DIRECTOR_STATE, [
      { at: T0, candidates: [cand('convo:1', 60)] },
      { at: T0 + DIRECTOR.MIN_HOLD_MS.conversation, candidates: [cand('convo:2', 35)] },
    ]);
    expect(cuts).toEqual(['convo:1', 'convo:2']);
  });

  it('returns to roaming when the scene ends and nothing else is interesting', () => {
    const { cuts, state } = run(INITIAL_DIRECTOR_STATE, [
      { at: T0, candidates: [cand('convo:1', 60)] },
      { at: T0 + DIRECTOR.MIN_HOLD_MS.conversation, candidates: [] },
    ]);
    expect(cuts).toEqual(['convo:1', 'roam:10']);
    expect(state.current?.kind).toBe('roam');
  });

  it('visits a new busy place after a roam dwell, not the same one twice', () => {
    const { cuts } = run(INITIAL_DIRECTOR_STATE, [
      { at: T0, candidates: [] },
      { at: T0 + DIRECTOR.ROAM_DWELL_MS - 1, candidates: [] },
      { at: T0 + DIRECTOR.ROAM_DWELL_MS, candidates: [] },
      { at: T0 + 2 * DIRECTOR.ROAM_DWELL_MS, candidates: [] },
    ]);
    expect(cuts).toEqual(['roam:10', undefined, 'roam:11', 'roam:12']);
  });

  it('yields a roam stop to drama after the preempt delay, not before', () => {
    const start = stepDirector(INITIAL_DIRECTOR_STATE, [], T0, WORLD);
    const early = stepDirector(start.state, [cand('convo:1', 60)], T0 + DIRECTOR.ROAM_PREEMPT_MS - 1, WORLD);
    const ready = stepDirector(start.state, [cand('convo:1', 60)], T0 + DIRECTOR.ROAM_PREEMPT_MS, WORLD);
    expect(early.cut).toBeNull();
    expect(ready.cut?.key).toBe('convo:1');
  });

  it('treats a candidate about the same lead resident as the same shot (no cut, clock kept)', () => {
    const first = stepDirector(INITIAL_DIRECTOR_STATE, [cand('alert:9', 60, { kind: 'alert', agentIds: [1] })], T0, WORLD);
    const t1 = T0 + DIRECTOR.MIN_HOLD_MS.alert;
    // The alert aged out and the person is now talking; that is the same scene.
    const second = stepDirector(first.state, [cand('convo:5', 70, { agentIds: [1, 2] })], t1, WORLD);
    expect(second.cut).toBeNull();
    expect(second.state.current?.key).toBe('convo:5');
    expect(second.state.current?.since).toBe(T0);
  });

  it('stays put when there is nowhere busy to roam', () => {
    const empty: WorldSnapshot = { locations: WORLD.locations, agents: [] };
    const r = stepDirector(INITIAL_DIRECTOR_STATE, [], T0, empty);
    expect(r.cut?.kind).toBe('roam');
    expect(r.cut?.locationId).toBeNull();
    const again = stepDirector(r.state, [], T0 + DIRECTOR.ROAM_DWELL_MS, empty);
    expect(again.cut).toBeNull();
  });

  it('is deterministic for equal scores (key order breaks the tie)', () => {
    const a = stepDirector(INITIAL_DIRECTOR_STATE, [cand('convo:2', 50), cand('convo:1', 50)], T0, WORLD);
    const b = stepDirector(INITIAL_DIRECTOR_STATE, [cand('convo:1', 50), cand('convo:2', 50)], T0, WORLD);
    expect(a.cut?.key).toBe(b.cut?.key);
  });
});
