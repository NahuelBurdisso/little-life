import { describe, it, expect } from 'vitest';
import {
  classifyActivity, createDetectorState, detectBeats,
  type ActivityRow, type BeatSnapshot,
} from '../beatDetect';

/**
 * Every description below is copied from what the server really logs (file noted per
 * fixture). If a server template is reworded, the classifier has to follow — these
 * fixtures are the contract.
 */
let nextId = 1;
const NOW = 1_000_000;
function row(over: Partial<ActivityRow> & { description?: string }): ActivityRow {
  const { description, ...rest } = over;
  return {
    id: nextId++,
    type: 'drama',
    initiator_id: 1,
    target_id: 2,
    agent_ids: [1, 2],
    real_timestamp: NOW,
    template_data: description !== undefined ? { description } : {},
    ...rest,
  };
}

function snap(over: Partial<BeatSnapshot> = {}): BeatSnapshot {
  return { activity: [], agents: [], relationships: [], events: [], removed: [], ...over };
}

describe('classifyActivity — drama descriptions', () => {
  const cases: Array<[string, string, string]> = [
    // confrontationEngine.ts
    ['fight', 'Ana and Bo got into a physical fight in public!', 'confrontationEngine escalation'],
    ['fight', 'Ana and Bo had a public shouting match!', 'confrontationEngine escalation'],
    ['romance', 'Ana and Bo had a heated argument but managed to clear the air', 'confrontationEngine resolution'],
    // conversations.ts
    ['fight', 'Ana insulted Bo during a heated argument', 'conversations insult'],
    ['fight', 'Ana started a fight with Bo', 'conversations drunk fight'],
    ['romance', 'Ana flirted with Bo after their conversation', 'conversations flirt'],
    ['secret', 'Ana confessed a secret to Bo.', 'conversations confession'],
    ['romance', 'Ana and Bo have reconciled.', 'conversations reconciliation'],
    ['heartbreak', "Ana discovered Bo's affair and broke up!", 'conversations affair'],
    // decisions.ts
    ['romance', 'Ana and Bo are on a date', 'decisions date'],
    ['arrest', 'Ana arrested Bo! Sentence: 8 hours.', 'decisions arrest'],
    // SnapResolver.ts
    ['fight', 'Ana snapped and confronted someone!', 'SnapResolver'],
    ['fight', 'Ana snapped and lashed out at those nearby!', 'SnapResolver'],
    // relationships.ts
    ['heartbreak', 'Ana and Bo are estranged for good — neither will ever forgive the other.', 'relationships'],
    // secretSharing.ts
    ['secret', 'Ana confided a personal secret to Bo', 'secretSharing'],
    // gossipEngine.ts / gossip.ts (thatSentence)
    ['secret', 'Ana overheard that Bo is deep in debt.', 'gossipEngine eavesdrop'],
    ['secret', 'Ana told Bo that Cy stole from the bakery.', 'gossipEngine share'],
    ['secret', 'Ana discovered that Cy has been sneaking out at night.', 'gossipEngine discovery'],
    ['secret', 'Ana learned that Cy is in love with Di.', 'gossip.ts learned'],
    ['secret', 'Ana told Bo: "Is Cy really leaving town?"', 'thatSentence question form'],
    // lifeEventsEngine.ts
    ['death', 'Ana has died. Died of natural causes. The town mourns.', 'lifeEventsEngine logDeath'],
    // agingEngine.ts
    ['birthday', 'Happy birthday to Ana! They turned 31 today!', 'agingEngine'],
  ];
  it.each(cases)('%s <- "%s" (%s)', (kind, description) => {
    expect(classifyActivity(row({ description }))?.kind).toBe(kind);
  });

  const ignored = [
    'The whole town now knows that Cy is in debt.',            // gossipEngine: no pair to draw between
    'Ana saw Bo giving a gift to Cy and feels jealous',        // giftEngine: the gift row is the beat
    'Ana was caught pickpocketing $12 from Bo!',               // decisions: crime, not an arrest
    'Ana was released from prison after 8 hours.',             // states
    'Ana reported blackmail to the constable.',                // conversations
    'Ana is getting tipsy at the tavern',                      // tavernEngine
    'Ana had a public emotional breakdown!',                   // SnapResolver: no pair, no clear beat
    "Ana's possessions were inherited by Bo.",                 // lifeEventsEngine: not the death itself
  ];
  it.each(ignored)('ignores "%s"', (description) => {
    expect(classifyActivity(row({ description }))).toBeNull();
  });

  it('does not let gossip content that mentions a fight or an arrest fool the classifier', () => {
    const a = classifyActivity(row({ description: 'Ana told Bo that Cy got into a physical fight in public.' }));
    const b = classifyActivity(row({ description: 'Ana overheard that Cy arrested Di! Sentence: 2 hours.' }));
    const c = classifyActivity(row({ description: 'Ana learned that Cy has died. Died of natural causes.' }));
    expect(a?.kind).toBe('secret');
    expect(b?.kind).toBe('secret');
    expect(c?.kind).toBe('secret');
  });

  it('takes the pair from initiator/target and falls back to agent_ids', () => {
    expect(classifyActivity(row({ description: 'Ana started a fight with Bo', initiator_id: 7, target_id: 9 }))?.agentIds).toEqual([7, 9]);
    expect(classifyActivity(row({ description: 'Ana and Bo are estranged for good — neither will ever forgive the other.', initiator_id: null, target_id: null, agent_ids: [3, 4] }))?.agentIds).toEqual([3, 4]);
  });

  it('arrest lists the arrested agent first, the constable second', () => {
    const r = row({ description: 'Bo arrested Ana! Sentence: 8 hours.', initiator_id: 2, target_id: 1 });
    expect(classifyActivity(r)).toEqual({ kind: 'arrest', agentIds: [1, 2] });
  });
});

describe('classifyActivity — typed rows', () => {
  it('gift: initiator gives, target receives', () => {
    const r = row({ type: 'gift', initiator_id: 5, target_id: 6, agent_ids: [5, 6], description: 'Ana gave a rose to Bo as a gift' });
    expect(classifyActivity(r)).toEqual({ kind: 'gift', agentIds: [5, 6] });
  });
  it('relationship_status_change maps the new status', () => {
    const mk = (status: string) => row({ type: 'relationship_status_change', initiator_id: null, target_id: null, agent_ids: [1, 2], template_data: { agent1: 'A', agent2: 'B', status } });
    expect(classifyActivity(mk('partners'))?.kind).toBe('romance');
    expect(classifyActivity(mk('romantic_interest'))?.kind).toBe('romance');
    expect(classifyActivity(mk('estranged'))?.kind).toBe('heartbreak');
    expect(classifyActivity(mk('friends'))).toBeNull();
    expect(classifyActivity(mk('enemies'))).toBeNull();
  });
  it('ignores rows of other types', () => {
    expect(classifyActivity(row({ type: 'purchase', description: 'Ana started a fight with Bo' }))).toBeNull();
    expect(classifyActivity(row({ type: 'player_nudge', description: 'x' }))).toBeNull();
  });
});

describe('detectBeats — watermark', () => {
  it('never replays the history that was already there on the first call', () => {
    nextId = 100;
    const s = createDetectorState();
    const old = [row({ description: 'Ana started a fight with Bo' })];
    expect(detectBeats(s, snap({ activity: old }), NOW)).toEqual([]);
    // Same rows again: still nothing.
    expect(detectBeats(s, snap({ activity: old }), NOW + 1000)).toEqual([]);
  });

  it('reports only rows newer than the watermark, oldest first', () => {
    nextId = 200;
    const s = createDetectorState();
    const seen = row({ description: 'Ana started a fight with Bo' });
    detectBeats(s, snap({ activity: [seen] }), NOW);
    const gift = row({ type: 'gift', initiator_id: 3, target_id: 4, agent_ids: [3, 4], description: 'x' });
    const date = row({ initiator_id: 5, target_id: 6, agent_ids: [5, 6], description: 'Eva and Fin are on a date' });
    const beats = detectBeats(s, snap({ activity: [date, gift, seen] }), NOW + 1000); // newest first
    expect(beats.map(b => b.kind)).toEqual(['gift', 'romance']);
    expect(detectBeats(s, snap({ activity: [date, gift, seen] }), NOW + 2000)).toEqual([]);
  });

  it('skips rows that are already stale in wall-clock time (tab was in the background)', () => {
    nextId = 300;
    const s = createDetectorState();
    detectBeats(s, snap({ activity: [row({ description: 'x' })] }), NOW);
    const stale = row({ description: 'Ana started a fight with Bo', real_timestamp: NOW - 120_000 });
    expect(detectBeats(s, snap({ activity: [stale] }), NOW)).toEqual([]);
  });

  it('an empty first poll defers the history cut-off to the first non-empty one', () => {
    nextId = 400;
    const s = createDetectorState();
    expect(detectBeats(s, snap({ activity: [] }), NOW)).toEqual([]);
    // The query resolved: what it holds is history.
    const history = row({ description: 'Ana started a fight with Bo' });
    expect(detectBeats(s, snap({ activity: [history] }), NOW + 1000)).toEqual([]);
    const fresh = row({ description: 'Cy and Di are on a date', initiator_id: 3, target_id: 4, agent_ids: [3, 4] });
    expect(detectBeats(s, snap({ activity: [fresh, history] }), NOW + 2000).map(b => b.kind)).toEqual(['romance']);
  });
});

describe('detectBeats — dedupe', () => {
  it('one beat per (kind, sorted agents) per 20 s', () => {
    nextId = 500;
    const s = createDetectorState();
    detectBeats(s, snap({ activity: [row({ description: 'boot' })] }), NOW);
    const f1 = row({ initiator_id: 1, target_id: 2, description: 'Ana started a fight with Bo' });
    const f2 = row({ initiator_id: 2, target_id: 1, agent_ids: [2, 1], description: 'Bo and Ana got into a physical fight in public!' });
    expect(detectBeats(s, snap({ activity: [f2, f1] }), NOW + 1000).map(b => b.kind)).toEqual(['fight']);
    const f3 = row({ initiator_id: 1, target_id: 2, description: 'Ana started a fight with Bo' });
    expect(detectBeats(s, snap({ activity: [f3, f2, f1] }), NOW + 5000)).toEqual([]);
    const f4 = row({ initiator_id: 1, target_id: 2, description: 'Ana started a fight with Bo' });
    expect(detectBeats(s, snap({ activity: [f4, f3, f2, f1] }), NOW + 25_000).map(b => b.kind)).toEqual(['fight']);
  });

  it('different pairs are independent', () => {
    nextId = 600;
    const s = createDetectorState();
    detectBeats(s, snap({ activity: [row({ description: 'boot' })] }), NOW);
    const a = row({ initiator_id: 1, target_id: 2, description: 'Ana started a fight with Bo' });
    const b = row({ initiator_id: 3, target_id: 4, agent_ids: [3, 4], description: 'Cy started a fight with Di' });
    expect(detectBeats(s, snap({ activity: [b, a] }), NOW + 1000)).toHaveLength(2);
  });
});

const agent = (id: number, over: any = {}) => ({
  id, position: { x: id * 10, y: id * 10 }, age: 30, hobbies: [], activeStates: [], ...over,
});

describe('detectBeats — agent diffs', () => {
  it('levelup: a hobby level goes up; decreases and new agents do not count', () => {
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1, { hobbies: [{ hobby: 'fishing', level: 2 }] }), agent(2, { hobbies: [{ hobby: 'chess', level: 3 }] })] }), NOW);
    const beats = detectBeats(s, snap({
      agents: [
        agent(1, { hobbies: [{ hobby: 'fishing', level: 3 }] }),
        agent(2, { hobbies: [{ hobby: 'chess', level: 1 }] }),      // server restart reset: not a level-up
        agent(3, { hobbies: [{ hobby: 'music', level: 5 }] }),      // newly seen agent: not a level-up
      ],
    }), NOW + 1000);
    expect(beats).toEqual([{ kind: 'levelup', agentIds: [1] }]);
  });

  it('levelup: first level of a new hobby counts for a known agent', () => {
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1)] }), NOW);
    const beats = detectBeats(s, snap({ agents: [agent(1, { hobbies: [{ hobby: 'chess', level: 1 }] })] }), NOW + 1000);
    expect(beats.map(b => b.kind)).toEqual(['levelup']);
  });

  it('birthday: age increased', () => {
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1, { age: 30 })] }), NOW);
    expect(detectBeats(s, snap({ agents: [agent(1, { age: 31 })] }), NOW + 1000)).toEqual([{ kind: 'birthday', agentIds: [1] }]);
  });

  it('birthday: the diff and the "Happy birthday" row are one beat', () => {
    nextId = 700;
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1, { age: 30 })], activity: [row({ description: 'boot' })] }), NOW);
    const hb = row({ initiator_id: 1, target_id: null, agent_ids: [1], description: 'Happy birthday to Ana! They turned 31 today!' });
    const beats = detectBeats(s, snap({ agents: [agent(1, { age: 31 })], activity: [hb] }), NOW + 1000);
    expect(beats.filter(b => b.kind === 'birthday')).toHaveLength(1);
  });

  it('arrest: gaining the arrested state (target = constable) and the arrest row are one beat', () => {
    nextId = 800;
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1), agent(2)], activity: [row({ description: 'boot' })] }), NOW);
    const arrestedState = { type: 'arrested', severity: 0.5, target_agent_id: 2 };
    const beats1 = detectBeats(s, snap({ agents: [agent(1, { activeStates: [arrestedState] }), agent(2)] }), NOW + 1000);
    expect(beats1).toEqual([{ kind: 'arrest', agentIds: [1, 2] }]);
    const rowArrest = row({ initiator_id: 2, target_id: 1, agent_ids: [2, 1], description: 'Bo arrested Ana! Sentence: 8 hours.' });
    expect(detectBeats(s, snap({ agents: [agent(1, { activeStates: [arrestedState] }), agent(2)], activity: [rowArrest] }), NOW + 2000)).toEqual([]);
  });

  it('arrest: a state that was already there does not fire again', () => {
    const s = createDetectorState();
    const st = { type: 'arrested', target_agent_id: 2 };
    detectBeats(s, snap({ agents: [agent(1, { activeStates: [st] })] }), NOW);
    expect(detectBeats(s, snap({ agents: [agent(1, { activeStates: [st] })] }), NOW + 30_000)).toEqual([]);
  });

  it('heartbreak: a partnership that stops being one', () => {
    const s = createDetectorState();
    const rel = (status: string) => [{ id: 9, agent_a: 1, agent_b: 2, status }];
    detectBeats(s, snap({ relationships: rel('partners') }), NOW);
    expect(detectBeats(s, snap({ relationships: rel('friends') }), NOW + 1000)).toEqual([{ kind: 'heartbreak', agentIds: [1, 2] }]);
  });

  it('heartbreak: a relationship row seen for the first time is not a breakup', () => {
    const s = createDetectorState();
    detectBeats(s, snap({ relationships: [] }), NOW);
    expect(detectBeats(s, snap({ relationships: [{ id: 9, agent_a: 1, agent_b: 2, status: 'friends' }] }), NOW + 1000)).toEqual([]);
  });
});

describe('detectBeats — death', () => {
  const diedRow = (id: number) => row({ initiator_id: id, target_id: null, agent_ids: [id], description: 'Ana has died. Died of natural causes. The town mourns.' });

  it('needs both the "has died" row and the agent leaving the pool; carries the last position', () => {
    nextId = 900;
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1)], activity: [row({ description: 'boot' })] }), NOW);
    // Row arrives first while the sprite is still around: wait.
    expect(detectBeats(s, snap({ agents: [agent(1)], activity: [diedRow(1)] }), NOW + 1000)).toEqual([]);
    const beats = detectBeats(s, snap({ agents: [], removed: [{ id: '1', x: 123, y: 45 }] }), NOW + 2000);
    expect(beats).toEqual([{ kind: 'death', agentIds: [1], at: { x: 123, y: 45 } }]);
    // Only once.
    expect(detectBeats(s, snap({ agents: [], removed: [] }), NOW + 3000)).toEqual([]);
  });

  it('works when the removal is seen before the row', () => {
    nextId = 1000;
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1)], activity: [row({ description: 'boot' })] }), NOW);
    expect(detectBeats(s, snap({ agents: [], removed: [{ id: '1', x: 7, y: 8 }] }), NOW + 1000)).toEqual([]);
    const beats = detectBeats(s, snap({ agents: [], activity: [diedRow(1)] }), NOW + 2000);
    expect(beats).toEqual([{ kind: 'death', agentIds: [1], at: { x: 7, y: 8 } }]);
  });

  it('falls back to the last known position when the agent vanished without a removal record', () => {
    nextId = 1050;
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(3)], activity: [row({ description: 'boot' })] }), NOW);
    const beats = detectBeats(s, snap({ agents: [], activity: [diedRow(3)] }), NOW + 1000);
    expect(beats).toEqual([{ kind: 'death', agentIds: [3], at: { x: 30, y: 30 } }]);
  });

  it('a funeral event for the agent counts as the death signal', () => {
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1)], events: [] }), NOW);
    const funeral = { id: 5, type: 'funeral', triggered_by: 'death:1' };
    detectBeats(s, snap({ agents: [agent(1)], events: [funeral] }), NOW + 1000);
    const beats = detectBeats(s, snap({ agents: [], removed: [{ id: '1', x: 1, y: 2 }], events: [funeral] }), NOW + 2000);
    expect(beats.map(b => b.kind)).toEqual(['death']);
  });

  it('a funeral that was already running at page load does not replay', () => {
    const s = createDetectorState();
    const funeral = { id: 5, type: 'funeral', triggered_by: 'death:1' };
    detectBeats(s, snap({ agents: [], events: [funeral] }), NOW);
    expect(detectBeats(s, snap({ agents: [], removed: [{ id: '1', x: 1, y: 2 }], events: [funeral] }), NOW + 1000)).toEqual([]);
  });

  it('a player removal (no death signal) is not a death', () => {
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1)] }), NOW);
    expect(detectBeats(s, snap({ agents: [], removed: [{ id: '1', x: 1, y: 2 }] }), NOW + 1000)).toEqual([]);
    expect(detectBeats(s, snap({ agents: [] }), NOW + 90_000)).toEqual([]);
  });

  it('gives up on a death row whose agent never leaves', () => {
    nextId = 1100;
    const s = createDetectorState();
    detectBeats(s, snap({ agents: [agent(1)], activity: [row({ description: 'boot' })] }), NOW);
    detectBeats(s, snap({ agents: [agent(1)], activity: [diedRow(1)] }), NOW + 1000);
    expect(detectBeats(s, snap({ agents: [agent(1)] }), NOW + 120_000)).toEqual([]);
    expect(detectBeats(s, snap({ agents: [], removed: [{ id: '1', x: 1, y: 2 }] }), NOW + 121_000)).toEqual([]);
  });
});
