import { describe, it, expect } from 'vitest';
import { composeTemplateChat, playScript, callScriptsFor, toneOf, type Rng } from '../templateChat';
import { SOCIAL_CALL_SCRIPTS } from '../../data/socialCallScripts';
import type { ChatContext, ChatPerson, Voice } from '../../data/smallTalkScripts';
import { CALL_TOPIC, callTrigger, socialCallIntent } from '../socialCalls/topics';
import { congratsTopic, topicIntent } from '../../ai/prompts';

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

/** The trigger and intent each call kind queues its chat with (lib/socialCalls/kinds.ts). */
const CASES: Array<{ kind: string; intent: string; states?: string[] }> = [
  { kind: 'sick_visit', intent: CALL_TOPIC.sick_visit, states: ['sick'] },
  { kind: 'vigil', intent: CALL_TOPIC.vigil, states: ['sick'] },
  { kind: 'condolence', intent: CALL_TOPIC.condolence, states: ['grieving'] },
  { kind: 'congratulate', intent: CALL_TOPIC.congratulate_engagement },
  { kind: 'congratulate', intent: CALL_TOPIC.congratulate_election },
  { kind: 'congratulate', intent: congratsTopic('Ada') },
  { kind: 'birthday_wish', intent: CALL_TOPIC.birthday_wish },
  { kind: 'welcome', intent: CALL_TOPIC.welcome },
  { kind: 'console', intent: CALL_TOPIC.console_election },
  { kind: 'console', intent: CALL_TOPIC.console_heartbreak, states: ['heartbroken'] },
  { kind: 'console', intent: CALL_TOPIC.console_work },
  { kind: 'plead_to_stay', intent: CALL_TOPIC.plead_to_stay },
  { kind: 'meet_at_gate', intent: CALL_TOPIC.welcome_home },
  { kind: 'meet_at_gate', intent: CALL_TOPIC.reproach },
  { kind: 'lend_money', intent: CALL_TOPIC.lend_money },
];

function context(rng: Rng, kind: string, intent: string, states: string[] = []): ChatContext {
  const people: [ChatPerson, ChatPerson] = [person('Rosa', rng), person('Diego', rng, states)];
  return {
    people,
    place: { name: 'Home 4', type: 'home', setting: 'indoor', speakable: false },
    weather: 'sunny', dayPhase: 'afternoon', status: 'friends', romance: 0, event: null, mutual: null, roles: {},
    intent, trigger: callTrigger(kind),
  };
}

describe('social-call template scripts', () => {
  it('every kind has a script its trigger and topic reach', () => {
    const rng = mulberry32(3);
    for (const { kind, intent, states } of CASES) {
      expect(callScriptsFor(context(rng, kind, intent, states)).length, `${kind} / ${intent}`).toBeGreaterThan(0);
    }
  });

  it('a call plays its own script, never the weather — and is a coherent exchange', () => {
    const rng = mulberry32(20261117);
    for (let n = 0; n < 1500; n++) {
      const { kind, intent, states } = CASES[n % CASES.length];
      const c = context(rng, kind, intent, states);
      const chat = composeTemplateChat(c, { rng })!;
      expect(chat.scriptId.startsWith('call_'), `${kind}: ${chat.scriptId}`).toBe(true);
      expect(chat.turns.length).toBeGreaterThanOrEqual(3);
      expect(chat.turns[0].speaker).toBe(0);
      expect(chat.turns.at(-1)!.move).toBe('close');
      for (const [k, t] of chat.turns.entries()) {
        if (!chat.anchors.some((a) => t.text.toLowerCase().includes(a))) throw new Error(`${chat.scriptId} line ${k} off topic: "${t.text}"`);
        expect(t.text).not.toMatch(/[{}]/);
        expect(t.text).not.toMatch(new RegExp(`\\b${c.people[t.speaker].first}\\b`));
        if (k > 0) expect(t.speaker).not.toBe(chat.turns[k - 1].speaker);
      }
      if (chat.turns[0].move === 'ask') expect(chat.turns[1].text.trim().endsWith('?')).toBe(false);
    }
  });

  it('every written line carries an anchor of its script, reachable or not', () => {
    const c = context(mulberry32(1), 'congratulate', congratsTopic('Ada'));
    for (const script of SOCIAL_CALL_SCRIPTS) {
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

  it('the thanks go to the one who came', () => {
    const rng = mulberry32(9);
    const vigil = SOCIAL_CALL_SCRIPTS.find((s) => s.id === 'call_vigil')!;
    for (let n = 0; n < 200; n++) {
      const chat = playScript(vigil, context(rng, 'vigil', CALL_TOPIC.vigil, ['sick']), rng)!;
      for (const t of chat.turns.filter((x) => x.speaker === 0)) expect(t.text).not.toMatch(/Thank you for sitting/);
    }
  });

  it('a jail-door reproach and a welcome home are different chats', () => {
    const rng = mulberry32(4);
    const welcome = composeTemplateChat(context(rng, 'meet_at_gate', CALL_TOPIC.welcome_home), { rng })!;
    const reproach = composeTemplateChat(context(rng, 'meet_at_gate', CALL_TOPIC.reproach), { rng })!;
    expect(welcome.scriptId).toBe('call_welcome_home');
    expect(reproach.scriptId).toBe('call_reproach');
    expect(reproach.turns.reduce((s, t) => s + t.sentiment, 0)).toBeLessThan(0);
  });

  it('an ordinary chat never plays a call script', () => {
    const rng = mulberry32(5);
    const c = { ...context(rng, 'sick_visit', CALL_TOPIC.sick_visit, ['sick']), trigger: 'needs_social' };
    expect(callScriptsFor(c)).toEqual([]);
    expect(composeTemplateChat(c, { rng })!.scriptId.startsWith('call_')).toBe(false);
  });
});

describe('social-call topics reach the LLM prompt', () => {
  it('turns every call topic into an intent that says why the caller came', () => {
    for (const topic of Object.values(CALL_TOPIC)) {
      expect(socialCallIntent(topic, 'Elena'), topic).toMatch(/Elena/);
      expect(topicIntent(topic, 'Elena')).toBe(socialCallIntent(topic, 'Elena'));
    }
    expect(socialCallIntent('the weather', 'Elena')).toBeNull();
  });
});
