import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearTopicMemory, openedTopicCount, recordConversationTopics, repeatedSubjects, subjectWords, TOPIC_WINDOW_MINUTES,
} from '../topicMemory';
import { topicShareAllowed, TOPIC_SHARE_FLOOR } from '../perception/PerceptionSystem';
import { buildSubjectsHint } from '../../ai/prompts';

const YUKI = 1;
const ROSA = 2;
const THOMAS = 3;
const NAMES: Record<number, string> = { 1: 'Yuki Tanaka', 2: 'Rosa Chen', 3: 'Thomas Park', 4: 'Priya Sharma', 5: 'Omar Hassan' };

let nextId = 1;
function talk(a: number, b: number, at: number, lines: Array<[number, string]>, topic = 'catching up') {
  recordConversationTopics({
    conversationId: nextId++,
    participants: [a, b],
    participantNames: [NAMES[a], NAMES[b]],
    topic,
    messages: lines.map(([speakerId, text]) => ({ speakerId, text })),
    gameMinute: at,
  });
}

describe('topicMemory (playtest #3: the old stone foundation, six times)', () => {
  beforeEach(() => clearTopicMemory());

  it('keeps distinctive words only — no pleasantries, no names of the pair', () => {
    expect(subjectWords("Tell me, Rosa, do you think the old foundation stones hold any secrets?", new Set(['rosa'])))
      .toEqual(['foundation', 'stone', 'secret']);
    expect(subjectWords('Good morning! I really hope you are feeling better today.')).toEqual([]);
  });

  it("names what a speaker keeps returning to across today's conversations", () => {
    talk(YUKI, THOMAS, 100, [[YUKI, 'The old stone foundation at the edge of the park is crumbling.'], [THOMAS, 'Is it?']]);
    expect(repeatedSubjects(YUKI, 200)).toEqual([]);
    talk(ROSA, YUKI, 300, [[ROSA, 'I have extra flour.'], [YUKI, 'Do you think the foundation of the town hall is sturdy?']]);
    expect(repeatedSubjects(YUKI, 400)).toEqual(['foundation']);
    // Only her own lines count: Rosa said "flour" once.
    expect(repeatedSubjects(ROSA, 400)).toEqual([]);
    // A day later it has faded.
    expect(repeatedSubjects(YUKI, 300 + TOPIC_WINDOW_MINUTES)).toEqual([]);
  });

  it("leaves the day's shared news alone (the flu everyone mentions)", () => {
    for (const [a, b] of [[1, 2], [3, 4], [5, 1], [2, 3], [4, 5]]) {
      talk(a, b, 100 + a * 10, [[a, 'This fever has the whole street abed.'], [b, 'The fever again, yes.']]);
    }
    expect(repeatedSubjects(1, 500)).toEqual([]);
  });

  it('counts the topics a resident opened, not the ones they were drawn into', () => {
    talk(ROSA, THOMAS, 100, [[ROSA, 'Can I bring you soup?'], [THOMAS, 'Thank you.']], 'offering help');
    talk(ROSA, YUKI, 200, [[ROSA, 'Need anything from the store?'], [YUKI, 'No.']], 'offering help');
    talk(THOMAS, ROSA, 300, [[THOMAS, 'Need a hand?'], [ROSA, 'No.']], 'offering help');
    expect(openedTopicCount(ROSA, 'offering help', 400)).toBe(2);
    expect(openedTopicCount(THOMAS, 'Offering help', 400)).toBe(1);
  });
});

describe('perception topic share per game day', () => {
  it('lets a topic run freely up to the floor, then caps its share', () => {
    expect(topicShareAllowed(TOPIC_SHARE_FLOOR - 1, TOPIC_SHARE_FLOOR - 1)).toBe(true);
    // Four offers of help and nothing else: the fifth waits for other kinds.
    expect(topicShareAllowed(4, 4)).toBe(false);
    expect(topicShareAllowed(4, 12)).toBe(true);
  });
});

describe('buildSubjectsHint', () => {
  it('tells the speaker what they already raised today', () => {
    expect(buildSubjectsHint(['foundation', 'flour'])).toBe("You've already talked about foundation and flour today — bring up something else unless asked.");
    expect(buildSubjectsHint([])).toBe('');
  });
});
