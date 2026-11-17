import { describe, it, expect } from 'vitest';
import { composeTemplateChat, callScriptsFor, toneOf, type Rng } from '../templateChat';
import { GATHERING_SCRIPTS } from '../../data/gatheringScripts';
import type { ChatContext, ChatPerson, Voice } from '../../data/smallTalkScripts';
import { GATHERING_TOPIC, gatheringIntent, gatheringKindOfTrigger, gatheringTrigger } from '../gatherings/topics';
import { topicIntent } from '../../ai/prompts';

function mulberry32(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const VOICES: Voice[] = ['warm', 'gruff', 'shy', 'bubbly', 'plain'];

function person(first: string, rng: Rng, states: string[] = []): ChatPerson {
  const friendship = Math.round(-5 + rng() * 90);
  const mood = Math.round(10 + rng() * 85);
  return {
    name: `${first} Doe`, first, friendship, mood, hunger: 60, energy: 60,
    voice: VOICES[Math.floor(rng() * VOICES.length)], tone: toneOf(friendship, mood, states),
    job: null, workplace: null, atWork: false, livesHere: false, states,
  };
}

const CASES: Array<{ kind: string; intent: string; states?: string[] }> = [
  { kind: 'funeral', intent: GATHERING_TOPIC.funeral('Tom'), states: ['grieving'] },
  { kind: 'wake', intent: GATHERING_TOPIC.wake('Tom') },
  { kind: 'send_off', intent: GATHERING_TOPIC.send_off('Lena') },
  { kind: 'market', intent: GATHERING_TOPIC.market },
  { kind: 'fire', intent: GATHERING_TOPIC.fire("Olga's house") },
  { kind: 'wedding', intent: GATHERING_TOPIC.wedding('Eva and Leo') },
  { kind: 'christening', intent: GATHERING_TOPIC.christening('Pip') },
];

function context(rng: Rng, kind: string, intent: string, states: string[] = []): ChatContext {
  return {
    people: [person('Rosa', rng), person('Diego', rng, states)],
    place: { name: 'Town Square', type: 'town_square', setting: 'outdoor', speakable: true },
    weather: 'sunny', dayPhase: 'afternoon', status: 'friends', romance: 0, event: null, mutual: null, roles: {},
    intent, trigger: gatheringTrigger(kind),
  };
}

describe('gathering chats', () => {
  it('each kind plays its own script — never the weather — as a coherent exchange', () => {
    const rng = mulberry32(20261117);
    for (let n = 0; n < 700; n++) {
      const { kind, intent, states } = CASES[n % CASES.length];
      const c = context(rng, kind, intent, states);
      expect(callScriptsFor(c).length, kind).toBeGreaterThan(0);
      const chat = composeTemplateChat(c, { rng })!;
      expect(chat.scriptId).toBe(`gather_${kind}`);
      expect(chat.turns.length).toBeGreaterThanOrEqual(3);
      expect(chat.turns.at(-1)!.move).toBe('close');
      for (const [k, t] of chat.turns.entries()) {
        if (!chat.anchors.some((a) => t.text.toLowerCase().includes(a))) throw new Error(`${chat.scriptId} line ${k} off topic: "${t.text}"`);
        expect(t.text).not.toMatch(/[{}]/);
        expect(t.text).not.toMatch(new RegExp(`\\b${c.people[t.speaker].first}\\b`));
      }
      if (chat.turns[0].move === 'ask') expect(chat.turns[1].text.trim().endsWith('?')).toBe(false);
    }
  });

  it('every written line carries an anchor of its script', () => {
    const c = context(mulberry32(1), 'funeral', GATHERING_TOPIC.funeral('Tom'));
    for (const script of GATHERING_SCRIPTS) {
      const anchors = script.anchors(c);
      const lines = [
        ...script.openers.flatMap((o) => [o, ...(o.replies ?? [])]),
        ...(script.react ?? []), ...(script.follow ?? []), ...script.close,
      ];
      for (const line of lines) {
        const text = line.text.replace(/\{you\}/g, 'Yuki').toLowerCase();
        expect(anchors.some((a) => text.includes(a)), `${script.id}: "${line.text}"`).toBe(true);
      }
    }
  });

  it('the LLM opener is told the occasion, by name', () => {
    expect(gatheringKindOfTrigger('gathering:send_off')).toBe('send_off');
    expect(gatheringKindOfTrigger('social_call:vigil')).toBeNull();
    for (const { intent } of CASES) {
      expect(gatheringIntent(intent, 'Diego'), intent).not.toBeNull();
      expect(topicIntent(intent, 'Diego')).toBe(gatheringIntent(intent, 'Diego'));
    }
    expect(gatheringIntent(GATHERING_TOPIC.funeral('Tom'), 'Diego')).toMatch(/at Tom's funeral/);
    expect(gatheringIntent('catching up', 'Diego')).toBeNull();
  });
});
