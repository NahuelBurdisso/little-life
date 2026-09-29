import { describe, it, expect } from 'vitest';
import {
  chooseTier,
  conversationBacklog,
  hasDramaticState,
  isDramaticTopic,
  signalTier,
  TIER_BUDGET,
  watchedPriority,
  type TierContext,
} from '../conversationTier';
import { CONFIG } from '../constants';

/**
 * The two tier blocks decisions.ts carried before chooseTier existed, copied
 * verbatim (modulo naming). They are the oracle for "nothing watched, no
 * pressure": chooseTier must agree with them on every input.
 */
function legacySocial(p: {
  friendship: number; romance: number; mood: number; social: number;
  dramaticState: boolean; topic: string | null; firstMeeting: boolean; hasGossip: boolean;
  comfort: boolean; smallTalk: 'llm_standard' | 'template';
}): string {
  const dramaticTopics = ['gossip', 'flirting', 'confrontation', 'venting', 'seeking comfort'];
  const hasDramaticTopic = p.topic ? dramaticTopics.some(t => p.topic!.includes(t)) : false;
  let tier: string;
  if (p.dramaticState || hasDramaticTopic || p.firstMeeting) tier = 'llm_deep';
  else if (p.romance > 30 || p.mood < 25 || p.mood > 85 || p.hasGossip) tier = 'llm_standard';
  else if (p.friendship > 40 || p.romance > 10 || p.mood < 40 || p.social < 30) tier = 'llm_standard';
  else tier = p.smallTalk;
  if (p.comfort && tier === 'template') tier = 'llm_standard';
  return tier;
}

function legacyEncounter(p: {
  friendship: number; romance: number; mood: number; dramaticState: boolean; smallTalk: 'llm_standard' | 'template';
}): string {
  if (p.dramaticState || p.friendship < -20) return 'llm_deep';
  if (p.romance > 30 || p.mood < 25 || p.mood > 85) return 'llm_standard';
  if (p.friendship > 40 || p.romance > 10 || p.mood < 40) return 'llm_standard';
  return p.smallTalk;
}

const calm = { watched: false, backlog: 0, population: 13, latencyMs: null } as const;

function social(over: Partial<TierContext> = {}): TierContext {
  return {
    ...calm,
    source: 'social',
    friendship: 20,
    romance: 0,
    mood: 60,
    social: 60,
    dramaticState: false,
    topic: null,
    firstMeeting: false,
    hasGossip: false,
    basePriority: 40,
    smallTalkTier: 'llm_standard',
    ...over,
  };
}

function encounter(over: Partial<TierContext> = {}): TierContext {
  return {
    ...calm,
    source: 'encounter',
    friendship: 20,
    romance: 0,
    mood: 60,
    dramaticState: false,
    basePriority: 50,
    smallTalkTier: 'llm_standard',
    ...over,
  };
}

describe('chooseTier — unchanged when nothing is watched and the model is idle', () => {
  const friendships = [-50, -21, -20, 0, 40, 41, 51, 80];
  const romances = [0, 10, 11, 30, 31];
  const moods = [10, 24, 25, 39, 40, 60, 85, 86];
  const socials = [10, 29, 30, 80];
  const topics = [null, 'the weather', 'gossip about Ana', 'seeking comfort', 'flirting and getting to know each other better'];

  for (const smallTalk of ['llm_standard', 'template'] as const) {
    it(`socialize decisions match the old inline block (SMALL_TALK_TIER=${smallTalk})`, () => {
      let checked = 0;
      for (const friendship of friendships) for (const romance of romances) for (const mood of moods)
        for (const soc of socials) for (const topic of topics) for (const flags of [0, 1, 2, 3, 4, 8, 15]) {
          const p = {
            friendship, romance, mood, social: soc, topic, smallTalk,
            dramaticState: (flags & 1) !== 0,
            firstMeeting: (flags & 2) !== 0,
            hasGossip: (flags & 4) !== 0,
            comfort: (flags & 8) !== 0,
          };
          const got = chooseTier(social({
            friendship, romance, mood, social: soc, topic, smallTalkTier: smallTalk,
            dramaticState: p.dramaticState, firstMeeting: p.firstMeeting, hasGossip: p.hasGossip,
            comfortVisit: p.comfort, basePriority: 77,
          }));
          expect(got.tier, JSON.stringify(p)).toBe(legacySocial(p));
          expect(got.priority).toBe(77);
          // decisions.ts' old literal max_wait of 10000 = 10 game minutes.
          expect(got.maxWaitGameMin).toBe(10);
          checked++;
        }
      expect(checked).toBeGreaterThan(1000);
    });

    it(`location encounters match the old inline block (SMALL_TALK_TIER=${smallTalk})`, () => {
      for (const friendship of friendships) for (const romance of romances) for (const mood of moods)
        for (const dramaticState of [false, true]) {
          const got = chooseTier(encounter({ friendship, romance, mood, dramaticState, smallTalkTier: smallTalk }));
          expect(got.tier).toBe(legacyEncounter({ friendship, romance, mood, dramaticState, smallTalk }));
          expect(got.priority).toBe(50);
          expect(got.maxWaitGameMin).toBe(10);
        }
    });
  }

  it('defaults to CONFIG small-talk tier when none is injected', () => {
    const { smallTalkTier: _, ...ctx } = social();
    expect(chooseTier(ctx).tier).toBe(CONFIG.CONVERSATIONS.SMALL_TALK_TIER);
  });
});

describe('chooseTier — budget table', () => {
  const rows: Array<[string, TierContext, string, 'none' | 'watched' | 'offscreen_downgrade']> = [
    // Off-screen small talk under each kind of pressure → template.
    ['off-screen small talk, idle model', social(), 'llm_standard', 'none'],
    ['off-screen small talk, backlog', social({ backlog: 1 }), 'template', 'offscreen_downgrade'],
    ['off-screen small talk, big town', social({ population: 21 }), 'template', 'offscreen_downgrade'],
    ['off-screen small talk, exactly 20 residents', social({ population: 20 }), 'llm_standard', 'none'],
    ['off-screen small talk, slow turns', social({ latencyMs: TIER_BUDGET.SLOW_TURN_MS }), 'template', 'offscreen_downgrade'],
    ['off-screen small talk, fast turns', social({ latencyMs: 1800 }), 'llm_standard', 'none'],
    ['off-screen encounter small talk, big town', encounter({ population: 32 }), 'template', 'offscreen_downgrade'],
    // Warm chats hold until the backlog is heavy.
    ['off-screen friends, light backlog', social({ friendship: 60, backlog: 2 }), 'llm_standard', 'none'],
    ['off-screen friends, big town', social({ friendship: 60, population: 32 }), 'llm_standard', 'none'],
    ['off-screen friends, heavy backlog', social({ friendship: 60, backlog: TIER_BUDGET.HEAVY_BACKLOG }), 'template', 'offscreen_downgrade'],
    // Drama and notable chats are never templated for the budget.
    ['off-screen drama, heavy backlog', social({ dramaticState: true, backlog: 20, population: 32 }), 'llm_deep', 'none'],
    ['off-screen gossip, heavy backlog', social({ hasGossip: true, backlog: 20, population: 32 }), 'llm_standard', 'none'],
    ['off-screen hostile encounter, heavy backlog', encounter({ friendship: -40, backlog: 20 }), 'llm_deep', 'none'],
    // Comfort visits never drop below standard.
    ['off-screen comfort visit, heavy backlog', social({ comfortVisit: true, backlog: 20, population: 32 }), 'llm_standard', 'none'],
    ['comfort visit with template small talk', social({ comfortVisit: true, smallTalkTier: 'template' }), 'llm_standard', 'none'],
    // Watched: never a template, content goes deep.
    ['watched small talk, heavy backlog', social({ watched: true, backlog: 20, population: 32 }), 'llm_standard', 'watched'],
    ['watched small talk, SMALL_TALK_TIER=template', social({ watched: true, smallTalkTier: 'template' }), 'llm_standard', 'watched'],
    ['watched friends', social({ watched: true, friendship: 60 }), 'llm_standard', 'watched'],
    ['watched gossip keeps the standard length', social({ watched: true, hasGossip: true }), 'llm_standard', 'watched'],
    ['watched high romance keeps the standard length', social({ watched: true, romance: 40 }), 'llm_standard', 'watched'],
    ['watched drama', social({ watched: true, dramaticState: true, backlog: 20 }), 'llm_deep', 'watched'],
    ['watched first meeting', social({ watched: true, firstMeeting: true }), 'llm_deep', 'watched'],
    ['watched hostile encounter', encounter({ watched: true, friendship: -40 }), 'llm_deep', 'watched'],
    ['watched encounter, notable', encounter({ watched: true, mood: 90 }), 'llm_standard', 'watched'],
    // Requests are never touched.
    ['player nudge small talk, heavy backlog', social({ request: 'nudge', requestedTier: 'llm_standard', backlog: 20, population: 32 }), 'llm_standard', 'none'],
    ['milestone proposal, heavy backlog', social({ request: 'milestone', requestedTier: 'llm_deep', backlog: 20, population: 32 }), 'llm_deep', 'none'],
  ];

  for (const [name, ctx, tier, budget] of rows) {
    it(name, () => {
      const got = chooseTier(ctx);
      expect(got.tier).toBe(tier);
      expect(got.budget).toBe(budget);
    });
  }

  it('lifts a watched entry over every ordinary priority but stays below the protected band', () => {
    const protectedFloor = CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 10;
    expect(chooseTier(social({ watched: true, basePriority: 40 })).priority).toBe(40 + TIER_BUDGET.WATCHED_PRIORITY_BOOST);
    expect(chooseTier(encounter({ watched: true })).priority).toBe(50 + TIER_BUDGET.WATCHED_PRIORITY_BOOST);
    for (const base of [0, 60, 120, 150, 189]) {
      expect(watchedPriority(base)).toBeLessThan(protectedFloor);
      expect(watchedPriority(base)).toBeGreaterThanOrEqual(Math.min(base, protectedFloor - 1));
    }
    // Highest ordinary socialize priority (social 0, close friends) stays under a watched low one.
    expect(watchedPriority(40)).toBeGreaterThan(40);
    // A request keeps its own priority.
    expect(chooseTier(social({ watched: true, request: 'nudge', requestedTier: 'llm_standard', basePriority: 200 })).priority).toBe(200);
  });
});

describe('chooseTier — queue wait', () => {
  const base = CONFIG.CONVERSATIONS.QUEUE_MAX_WAIT_GAME_MINUTES;

  it('a watched entry waits longer for a slot', () => {
    expect(chooseTier(social({ watched: true })).maxWaitGameMin).toBe(base * TIER_BUDGET.WATCHED_WAIT_FACTOR);
    expect(chooseTier(encounter({ watched: true, backlog: 9 })).maxWaitGameMin).toBe(base * TIER_BUDGET.WATCHED_WAIT_FACTOR);
  });

  it('off-screen drama waits longer only while the model is under pressure', () => {
    expect(chooseTier(social({ dramaticState: true })).maxWaitGameMin).toBe(base);
    expect(chooseTier(social({ dramaticState: true, backlog: 1 })).maxWaitGameMin).toBe(base * TIER_BUDGET.DRAMA_WAIT_FACTOR);
    expect(chooseTier(encounter({ friendship: -40, population: 32 })).maxWaitGameMin).toBe(base * TIER_BUDGET.DRAMA_WAIT_FACTOR);
    expect(chooseTier(social({ friendship: 60, backlog: 1 })).maxWaitGameMin).toBe(base);
  });

  it('requests keep the ordinary wait (their producers set their own)', () => {
    expect(chooseTier(social({ request: 'nudge', requestedTier: 'llm_standard', watched: true })).maxWaitGameMin).toBe(base);
  });
});

describe('conversationTier helpers', () => {
  it('signalTier labels the branch it took', () => {
    expect(signalTier(social({ firstMeeting: true })).signal).toBe('dramatic');
    expect(signalTier(social({ mood: 90 })).signal).toBe('notable');
    expect(signalTier(social({ social: 10 })).signal).toBe('warm');
    expect(signalTier(social()).signal).toBe('small_talk');
    expect(signalTier(encounter({ friendship: -30 })).signal).toBe('dramatic');
  });

  it('dramatic states and topics', () => {
    expect(hasDramaticState(['happy'], ['jealous'])).toBe(true);
    expect(hasDramaticState(['happy'], [])).toBe(false);
    expect(isDramaticTopic('gossip about Ana')).toBe(true);
    expect(isDramaticTopic('the weather')).toBe(false);
    expect(isDramaticTopic(null)).toBe(false);
  });

  it('conversationBacklog counts queued LLM entries only once the slots are full', () => {
    expect(conversationBacklog({ semaphoreWaiting: 0, activeLLMConversations: 2, maxConcurrentLLM: 4, queuedLLMEntries: 3 })).toBe(0);
    expect(conversationBacklog({ semaphoreWaiting: 2, activeLLMConversations: 2, maxConcurrentLLM: 4, queuedLLMEntries: 3 })).toBe(2);
    expect(conversationBacklog({ semaphoreWaiting: 1, activeLLMConversations: 4, maxConcurrentLLM: 4, queuedLLMEntries: 3 })).toBe(4);
  });
});
