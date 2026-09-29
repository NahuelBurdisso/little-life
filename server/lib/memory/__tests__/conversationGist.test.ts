import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickConversationGist } from '../conversationGist';
import { initMemoryObserver } from '../MemoryObserver';
import type { MemoryService } from '../MemoryService';
import { simEvents } from '../../simEvents';

const ROSA = 1;
const YUKI = 2;

// A confession like the playtest one where, afterwards, both memories read only
// "…and I wrapped up our conversation."
const confession = [
  { speakerId: ROSA, text: 'Hey Yuki, how are you doing today?', sentiment: 0.3 },
  { speakerId: YUKI, text: "I'm alright. The shop was quiet.", sentiment: 0.1 },
  { speakerId: ROSA, text: "I have to tell you something. I think I've fallen in love with you.", sentiment: 0.7 },
  { speakerId: YUKI, text: 'Oh. I feel the same way, Rosa. I have for months.', sentiment: 0.8 },
  { speakerId: ROSA, text: 'See you tomorrow then?', sentiment: 0.4 },
];

describe('pickConversationGist', () => {
  it('picks the most loaded line, not the small talk', () => {
    expect(pickConversationGist(confession)).toEqual({
      speakerId: YUKI,
      quote: 'Oh. I feel the same way, Rosa. I have for months.',
    });
  });

  it('does not quote mundane lines that only brush a keyword', () => {
    for (const text of [
      'I feel like it might rain later today.',
      'I think I will lie down for a bit.',
      "Let's get together at the market sometime.",
      'That bakery job is my dream, honestly.',
      'I was alone at the shop all afternoon.',
    ]) {
      expect(pickConversationGist([{ speakerId: ROSA, text, sentiment: 0.1 }])).toBeNull();
    }
  });

  it('still quotes a loaded disclosure with little sentiment', () => {
    expect(pickConversationGist([
      { speakerId: YUKI, text: "I think you lied to me about the money.", sentiment: -0.1 },
    ])?.quote).toBe('I think you lied to me about the money.');
  });

  it('returns null when nothing is worth quoting', () => {
    expect(pickConversationGist([
      { speakerId: ROSA, text: 'Good morning! How are you?', sentiment: 0.4 },
      { speakerId: YUKI, text: 'Fine, thanks. Nice weather today.', sentiment: 0.3 },
      { speakerId: ROSA, text: 'line 2', sentiment: 0.2 },
    ])).toBeNull();
  });

  const nameOf = (id: number) => (id === ROSA ? 'Rosa Delgado' : id === YUKI ? 'Yuki Tanaka' : undefined);

  it('skips canned fallback narration', () => {
    expect(pickConversationGist([
      // Legacy lines (no flag): the exact canned shape with their own speaker's name.
      { speakerId: ROSA, text: 'Rosa Delgado smiled and nodded.', sentiment: 0.9 },
      { speakerId: YUKI, text: '"Hmm, interesting," Yuki Tanaka said.', sentiment: 0.9 },
      { speakerId: YUKI, text: 'I am so sorry about everything that happened.', sentiment: 0.9, fallback: true },
    ], nameOf)).toBeNull();
  });

  it('strips stage directions from older, unsanitised transcripts', () => {
    const gist = pickConversationGist([
      { speakerId: YUKI, text: '(You shift slightly, avoiding eye contact.) "I lied to you about the money, and I am sorry."', sentiment: -0.6 },
    ]);
    expect(gist?.quote).toBe('I lied to you about the money, and I am sorry.');
  });

  it('shortens a long line to its loaded sentence', () => {
    const gist = pickConversationGist([
      {
        speakerId: YUKI,
        text: 'The market was busy all morning and the baker ran out of rye bread before noon again. I never told anyone, but I am afraid of the dark. Anyway, the fish stall had a sale on trout.',
        sentiment: -0.2,
      },
    ]);
    expect(gist?.quote).toBe('I never told anyone, but I am afraid of the dark.');
  });
});

describe('MemoryObserver — conversation:ended', () => {
  const record = vi.fn();
  initMemoryObserver({ record } as unknown as MemoryService);

  beforeEach(() => {
    record.mockClear();
  });

  function endedMemory(payload: Record<string, unknown>): [string, Record<string, unknown>] {
    simEvents.emit('conversation:ended', { turns: 5, sentiment: 0.5, summary: 'flirting', ...payload });
    const call = record.mock.calls.find((c) => c[1] === 'conversation');
    return [call?.[2], call?.[3]];
  }

  it("quotes the other person's line instead of the topic label", () => {
    const [description, metadata] = endedMemory({ agentId: ROSA, otherName: 'Yuki Tanaka', messages: confession });
    expect(description).toMatch(/^(Yuki Tanaka told me|Talking with Yuki Tanaka, they said), "Oh\. I feel the same way, Rosa\. I have for months\."$/);
    expect(description).not.toContain('flirting');
    expect(metadata).toMatchObject({ summary: 'flirting', quote: 'Oh. I feel the same way, Rosa. I have for months.', quote_by: YUKI });
  });

  it('attributes a quote of the agent\'s own line to them', () => {
    const [description] = endedMemory({ agentId: YUKI, otherName: 'Rosa Delgado', messages: confession });
    expect(description).toMatch(/^(I told Rosa Delgado|Talking with Rosa Delgado, I said), "Oh\. I feel the same way/);
  });

  it('keeps the cut-short wording when quoting a truncated conversation', () => {
    const [description] = endedMemory({ agentId: ROSA, otherName: 'Yuki Tanaka', messages: confession, truncated: true });
    expect(description).toMatch(/cut off|before we were done/);
    expect(description).toContain('"Oh. I feel the same way, Rosa. I have for months."');
  });

  it('quotes a loaded template line but not template small talk', () => {
    const [tense] = endedMemory({
      agentId: ROSA,
      otherName: 'Yuki Tanaka',
      messages: [
        { speakerId: YUKI, text: "Stay away from me, Rosa. I don't trust you anymore.", sentiment: -0.6 },
        { speakerId: ROSA, text: 'Fine.', sentiment: -0.3 },
      ],
    });
    expect(tense).toContain(`"Stay away from me, Rosa. I don't trust you anymore."`);

    record.mockClear();
    const [smallTalk] = endedMemory({
      agentId: ROSA,
      otherName: 'Yuki Tanaka',
      messages: [
        { speakerId: ROSA, text: 'Good morning, Yuki! Lovely weather today.', sentiment: 0.4 },
        { speakerId: YUKI, text: 'Morning! Nice day for a walk.', sentiment: 0.3 },
      ],
    });
    expect(smallTalk).not.toContain('"');
  });

  it('falls back to the topic template without a transcript', () => {
    const [description, metadata] = endedMemory({ agentId: ROSA, otherName: 'Yuki Tanaka' });
    expect(description).toMatch(/Yuki Tanaka/);
    expect(description).not.toContain('"');
    expect(metadata).not.toHaveProperty('quote');
  });
});
