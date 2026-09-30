import { describe, it, expect } from 'vitest';
import {
  composeTemplateChat,
  eligibleScripts,
  placeIsSpeakable,
  playScript,
  toneOf,
  type Rng,
  type TemplateChat,
} from '../templateChat';
import {
  EVENT_TALK,
  JOB_NOUNS,
  SMALL_TALK_SCRIPTS,
  type ChatContext,
  type ChatPerson,
  type Voice,
} from '../../data/smallTalkScripts';

/**
 * Playtest #2 (G5): template chats read as non-sequiturs — three lines from
 * three unrelated categories ("Glad to be in out of the rain." / "I've got so
 * much to do today, but at least the company's good." / "It was really nice
 * talking to you, Diego Santos."). These generate thousands of chats over
 * random but realistic town moments and hold every one to the contract in
 * server/lib/templateChat.ts.
 */

function mulberry32(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRSTS = ['Rosa', 'Diego', 'Yuki', 'Marco', 'Lucia', 'Omar'];
const SURNAMES = ['Chen', 'Santos', 'Tanaka', 'Rivera', 'Fernandez', 'Hassan'];
const PLACES: Array<{ name: string; type: string; setting: 'indoor' | 'outdoor' }> = [
  { name: 'Market Square', type: 'market_square', setting: 'outdoor' },
  { name: 'The Rusty Lantern', type: 'tavern', setting: 'indoor' },
  { name: 'The Sunken Anchor', type: 'divebar', setting: 'indoor' },
  { name: 'Golden Crust Bakery', type: 'bakery', setting: 'indoor' },
  { name: 'Hillside Farm', type: 'farm', setting: 'outdoor' },
  { name: 'Town Clinic', type: 'clinic', setting: 'indoor' },
  { name: 'General Store', type: 'shop', setting: 'indoor' },
  { name: 'Home 4', type: 'home', setting: 'indoor' },
  { name: 'Willow Park', type: 'park', setting: 'outdoor' },
  { name: 'Town Hall', type: 'town_hall', setting: 'indoor' },
  { name: 'Main Street', type: 'mainstreet', setting: 'outdoor' },
];
const WEATHERS = ['sunny', 'cloudy', 'rainy', 'stormy', 'foggy', 'snowy', 'windy', 'hot'];
const PHASES = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
const VOICES: Voice[] = ['warm', 'gruff', 'shy', 'bubbly', 'plain'];
const STATUSES = ['strangers', 'acquaintances', 'friends', 'close_friends', 'rivals', 'enemies', 'romantic_interest', 'partners'];
const JOBS = Object.values(JOB_NOUNS);
const INTENTS = ['flirting', 'offering help', 'offering comfort', 'catching up', 'town news'];

function randomContext(rng: Rng): ChatContext {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const range = (lo: number, hi: number) => Math.round(lo + rng() * (hi - lo));
  const place = pick(PLACES);
  const [i, j] = (() => {
    const a = Math.floor(rng() * FIRSTS.length);
    let b = Math.floor(rng() * (FIRSTS.length - 1));
    if (b >= a) b++;
    return [a, b];
  })();
  const person = (k: number): ChatPerson => {
    const friendship = range(-60, 90);
    const mood = range(5, 95);
    const job = rng() < 0.8 ? pick(JOBS) : null;
    const atWork = job != null && rng() < 0.3;
    return {
      name: `${FIRSTS[k]} ${SURNAMES[k]}`,
      first: FIRSTS[k],
      friendship,
      mood,
      hunger: range(5, 95),
      energy: range(5, 95),
      voice: pick(VOICES),
      tone: toneOf(friendship, mood),
      job,
      workplace: atWork ? place.name : job ? pick(PLACES.filter((p) => p.type !== 'home')).name : null,
      atWork,
      livesHere: place.type === 'home' && rng() < 0.5,
    };
  };
  const eventKey = rng() < 0.35 ? pick(Object.keys(EVENT_TALK)) : null;
  const mutualIdx = rng() < 0.5 ? FIRSTS.findIndex((_, k) => k !== i && k !== j) : -1;
  const people: [ChatPerson, ChatPerson] = [person(i), person(j)];
  return {
    people,
    place: { ...place, speakable: placeIsSpeakable(place.name, place.type, people.map((p) => p.first)) },
    weather: pick(WEATHERS),
    dayPhase: pick(PHASES),
    status: pick(STATUSES),
    romance: range(0, 80),
    event: eventKey ? { key: eventKey, ...EVENT_TALK[eventKey] } : null,
    mutual: mutualIdx >= 0 ? { first: FIRSTS[mutualIdx], openerLikes: rng() < 0.6, listenerLikes: rng() < 0.6 } : null,
    roles: {
      tavern: rng() < 0.8 ? 'The Rusty Lantern' : undefined,
      baker: rng() < 0.6 ? 'Ines' : undefined,
      bartender: rng() < 0.6 ? 'Pablo' : undefined,
    },
    intent: rng() < 0.35 ? pick(INTENTS) : null,
  };
}

const lower = (s: string) => s.toLowerCase();

function assertCoherent(chat: TemplateChat, c: ChatContext): void {
  const { turns, anchors } = chat;
  expect(turns.length).toBeGreaterThanOrEqual(3);
  expect(turns[0].speaker).toBe(0);
  expect(turns.at(-1)!.move).toBe('close');
  for (let k = 1; k < turns.length; k++) expect(turns[k].speaker).not.toBe(turns[k - 1].speaker);

  // No line repeats within a chat.
  expect(new Set(turns.map((t) => t.text)).size).toBe(turns.length);

  for (const [k, t] of turns.entries()) {
    const me = c.people[t.speaker];
    // Each line is on the topic, so each reply references the line before it.
    const onTopic = anchors.some((a) => lower(t.text).includes(a));
    if (!onTopic) throw new Error(`${chat.scriptId} line ${k} off topic ${JSON.stringify(anchors)}: "${t.text}"`);
    // Every slot filled.
    expect(t.text).not.toMatch(/[{}]/);
    // Nobody says their own name, and nobody is called by their full name.
    expect(t.text).not.toMatch(new RegExp(`\\b${me.first}\\b`));
    for (const p of c.people) expect(t.text).not.toContain(p.name);
    expect(t.text).toMatch(/^[A-Z*]/);
  }

  // A question gets an answer written for it — an answer, not another question.
  if (turns[0].move === 'ask') {
    expect(turns[0].text, chat.scriptId).toContain('?');
    expect(turns[1].move).toBe('answer');
    expect(turns[1].text.trim().endsWith('?'), `${turns[0].text} / ${turns[1].text}`).toBe(false);
  } else {
    expect(turns[1].move).toBe('react');
  }
}

describe('template chats are coherent mini-exchanges (G5)', () => {
  it('holds over thousands of random town moments', () => {
    const rng = mulberry32(20260929);
    const seen = new Set<string>();
    for (let n = 0; n < 2500; n++) {
      const c = randomContext(rng);
      const chat = composeTemplateChat(c, { rng });
      expect(chat, `no chat for ${JSON.stringify(c)}`).not.toBeNull();
      assertCoherent(chat!, c);
      seen.add(chat!.scriptId);
    }
    // Every topic comes up somewhere in 2500 moments.
    expect([...seen].sort()).toEqual(SMALL_TALK_SCRIPTS.map((s) => s.id).sort());
  });

  it('plays every eligible script coherently, not just the one the weights favour', () => {
    const rng = mulberry32(7);
    for (let n = 0; n < 400; n++) {
      const c = randomContext(rng);
      for (const script of eligibleScripts(c)) {
        const chat = playScript(script, c, rng);
        if (chat) assertCoherent(chat, c);
      }
    }
  });

  it('a listener who comes across cool never gives a cheerful answer', () => {
    const rng = mulberry32(42);
    for (let n = 0; n < 8000; n++) {
      const c = randomContext(rng);
      if (c.people[1].tone !== 'cool') continue;
      const chat = composeTemplateChat(c, { rng })!;
      expect(chat.turns[1].sentiment, `${chat.scriptId}: ${chat.turns[0].text} / ${chat.turns[1].text}`).toBeLessThanOrEqual(0.1);
    }
  });

  it('comfort goes to the one having the rough day, not back to the comforter', () => {
    const rough = SMALL_TALK_SCRIPTS.find((s) => s.id === 'rough_day')!;
    const rng = mulberry32(21);
    for (let n = 0; n < 300; n++) {
      const c = randomContext(rng);
      c.people[0].friendship = 40;
      c.people[1].mood = 15;
      c.people[1].tone = 'cool';
      const chat = playScript(rough, c, rng)!;
      for (const t of chat.turns.filter((x) => x.speaker === 1)) {
        expect(t.text).not.toMatch(/get you down|worry too much/);
      }
      expect(chat.turns.find((t) => t.move === 'follow')?.text ?? '').not.toMatch(/^Exactly/);
    }
  });

  it('keeps hostile pairs to the standoff, the weather or the day', () => {
    const rng = mulberry32(99);
    for (let n = 0; n < 500; n++) {
      const c = randomContext(rng);
      c.people[0].friendship = -40;
      c.people[0].tone = 'cool';
      const chat = composeTemplateChat(c, { rng })!;
      expect(['standoff', 'the_day'].includes(chat.scriptId) || chat.scriptId.startsWith('weather_')).toBe(true);
    }
  });

  it('each side answers from their own feelings: a cool listener turns down the drink', () => {
    const tavern = SMALL_TALK_SCRIPTS.find((s) => s.id === 'tavern_drink')!;
    const base = randomContext(mulberry32(5));
    const c: ChatContext = {
      ...base,
      place: { name: 'The Rusty Lantern', type: 'tavern', setting: 'indoor', speakable: true },
      dayPhase: 'evening',
      status: 'acquaintances',
      people: [
        { ...base.people[0], friendship: 60, mood: 70, tone: 'warm', voice: 'plain' },
        { ...base.people[1], friendship: -5, mood: 15, tone: 'cool', voice: 'plain' },
      ],
    };
    const rng = mulberry32(8);
    for (let n = 0; n < 200; n++) {
      const chat = playScript(tavern, c, rng)!;
      assertCoherent(chat, c);
      // Cool replies stay cool: the listener's own tone picks the variant.
      expect(chat.turns[1].sentiment).toBeLessThanOrEqual(0.1);
    }
  });

  it('skips topics on cooldown, and replays the least recent one when all are', () => {
    const rng = mulberry32(11);
    const c = randomContext(rng);
    c.people[0].friendship = 50;
    c.people[1].friendship = 50;
    const ids = eligibleScripts(c).map((s) => s.id);
    expect(ids.length).toBeGreaterThan(1);

    const now = 10_000;
    const lastUsed = new Map(ids.slice(1).map((id) => [id, now - 5] as const));
    for (let n = 0; n < 50; n++) {
      const chat = composeTemplateChat(c, { rng, lastUsed, nowGameMin: now });
      expect(chat!.scriptId).toBe(ids[0]);
    }

    // All on cooldown: the one used longest ago comes back.
    const allUsed = new Map(ids.map((id) => [id, id === ids[1] ? now - 30 : now - 5] as const));
    expect(composeTemplateChat(c, { rng, lastUsed: allUsed, nowGameMin: now })!.scriptId).toBe(ids[1]);
  });

  it('every written line carries its topic anchor, reachable or not', () => {
    const c = randomContext(mulberry32(1));
    c.place = { name: 'Willow Park', type: 'park', setting: 'outdoor', speakable: true };
    c.mutual = { first: 'Omar', openerLikes: true, listenerLikes: true };
    c.event = { key: 'festival', ...EVENT_TALK.festival };
    c.people[1].job = 'baker';
    c.people[1].workplace = 'Golden Crust Bakery';
    const slots: Record<string, string> = {
      you: 'Yuki', place: 'Willow Park', mutual: 'Omar', event: 'the festival', Event: 'The festival',
      work: 'Golden Crust Bakery', job: 'baker', tavern: 'The Rusty Lantern', baker: 'Ines', bartender: 'Pablo',
      eventAsk: EVENT_TALK.festival.ask![0], eventYes: EVENT_TALK.festival.ask![1], eventNo: EVENT_TALK.festival.ask![2],
    };
    for (const script of SMALL_TALK_SCRIPTS) {
      const anchors = script.anchors(c);
      const lines = [
        ...script.openers.flatMap((o) => [o, ...(o.replies ?? [])]),
        ...(script.react ?? []), ...(script.follow ?? []), ...script.close,
      ];
      for (const line of lines) {
        const text = line.text.replace(/\{(\w+)\}/g, (_m, k: string) => slots[k]).toLowerCase();
        expect(anchors.some((a) => text.includes(a)), `${script.id}: "${line.text}"`).toBe(true);
      }
    }
  });

  describe('why they are talking (playtest #3: partners got the full-moon line)', () => {
    const friendly = (rng: Rng): ChatContext => {
      const c = randomContext(rng);
      c.people[0] = { ...c.people[0], friendship: 60, mood: 70, tone: 'warm' };
      c.people[1] = { ...c.people[1], friendship: 60, mood: 70, tone: 'warm' };
      // A friendly pair can't carry a hostile status (the random context may draw one).
      if (c.status === 'rivals' || c.status === 'enemies') c.status = 'friends';
      return c;
    };

    it('plays the script written for the reason most of the time', () => {
      const rng = mulberry32(314);
      const hits = { flirt: 0, help: 0, couple: 0 };
      for (let n = 0; n < 300; n++) {
        const flirt = { ...friendly(rng), intent: 'flirting', status: 'acquaintances' };
        if (composeTemplateChat(flirt, { rng })!.scriptId === 'shy_flirt') hits.flirt++;
        const help = { ...friendly(rng), intent: 'offering help' };
        if (composeTemplateChat(help, { rng })!.scriptId === 'help') hits.help++;
        const couple = { ...friendly(rng), intent: 'catching up', status: 'partners', event: { key: 'full_moon', ...EVENT_TALK.full_moon }, dayPhase: 'night' };
        const chat = composeTemplateChat(couple, { rng })!;
        assertCoherent(chat, couple);
        if (chat.scriptId === 'sweethearts') hits.couple++;
      }
      expect(hits.flirt).toBeGreaterThan(200);
      expect(hits.help).toBeGreaterThan(200);
      expect(hits.couple).toBeGreaterThan(200);
    });

    it('never flirts with someone unasked, nor plans supper at midnight', () => {
      const rng = mulberry32(2718);
      for (let n = 0; n < 500; n++) {
        const c = randomContext(rng);
        const chat = composeTemplateChat(c, { rng })!;
        if (chat.scriptId === 'shy_flirt') expect(c.intent).toBe('flirting');
        if (c.dayPhase === 'night') expect(chat.turns.map((t) => t.text).join(' ')).not.toMatch(/Supper together|Until tonight/);
      }
    });

    it('asks each event its own question, and only wishes joy of what can be enjoyed', () => {
      const event = SMALL_TALK_SCRIPTS.find((s) => s.id === 'event')!;
      const rng = mulberry32(55);
      const seen = new Set<string>();
      for (let n = 0; n < 300; n++) {
        const c = { ...friendly(rng), event: { key: 'bountiful_catch', ...EVENT_TALK.bountiful_catch } };
        const chat = playScript(event, c, rng)!;
        assertCoherent(chat, c);
        seen.add(chat.turns[0].text);
        expect(chat.turns.at(-1)!.text).not.toMatch(/^Enjoy the big catch/);
      }
      expect(seen).toContain('Did you see the size of the catch the boats brought in?');
      for (const [key, talk] of Object.entries(EVENT_TALK)) {
        for (const line of talk.ask ?? []) expect(line.toLowerCase(), key).toContain(talk.anchor);
      }
    });

    it('does not repeat an opening line another pair used this game hour', () => {
      const rng = mulberry32(99);
      const c = { ...friendly(rng), intent: null, event: { key: 'full_moon', ...EVENT_TALK.full_moon } };
      const first = composeTemplateChat(c, { rng })!;
      for (let n = 0; n < 100; n++) {
        const again = composeTemplateChat(c, {
          rng, townRecent: { scripts: new Set([first.scriptId]), openers: new Set([first.turns[0].text]) },
        })!;
        expect(again.turns[0].text).not.toBe(first.turns[0].text);
      }
    });
  });

  it('speaks place names only when they can be said', () => {
    expect(placeIsSpeakable('Home 4', 'home', ['Rosa'])).toBe(false);
    expect(placeIsSpeakable("Rosa's Bakery", 'bakery', ['Rosa', 'Diego'])).toBe(false);
    expect(placeIsSpeakable('Golden Crust Bakery', 'bakery', ['Rosa', 'Diego'])).toBe(true);
  });
});
