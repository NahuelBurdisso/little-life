import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));

import { db } from '../../../db';
import { agents, locations } from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import { CONFIG } from '../../constants';
import { simEvents } from '../../simEvents';
import { clearSpotlight, setSpotlight } from '../../spotlight';
import { initMemoryObserver } from '../MemoryObserver';
import type { MemoryService } from '../MemoryService';
import {
  MIN_SUMMARY_LINES,
  OFFSCREEN_MIN_SUMMARY_LINES,
  summarizeConversation,
  summaryPriority,
} from '../conversationSummary';

describe('summaryPriority', () => {
  it('on screen: summarise from MIN_SUMMARY_LINES at normal priority', () => {
    expect(summaryPriority(MIN_SUMMARY_LINES - 1, true)).toBeNull();
    expect(summaryPriority(MIN_SUMMARY_LINES, true)).toBe('normal');
  });

  it('off screen: short chats keep the gist, longer ones summarise at low priority', () => {
    expect(summaryPriority(MIN_SUMMARY_LINES, false)).toBeNull();
    expect(summaryPriority(OFFSCREEN_MIN_SUMMARY_LINES - 1, false)).toBeNull();
    expect(summaryPriority(OFFSCREEN_MIN_SUMMARY_LINES, false)).toBe('low');
  });

  it('summarizeConversation passes the priority to the chat pool', async () => {
    vi.mocked(callOllamaChat).mockClear();
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: '{}' }) as never);
    const lines = Array.from({ length: 6 }, (_, i) => ({ speaker: i % 2 ? 'Ana Ruiz' : 'Ben Cole', text: `line ${i}` }));
    await summarizeConversation(['Ben Cole', 'Ana Ruiz'], lines, 'low');
    expect(vi.mocked(callOllamaChat).mock.calls[0][0]).toMatchObject({ purpose: 'conversation.summary', priority: 'low' });
  });
});

describe('MemoryObserver — summary skip for short off-screen chats', () => {
  const record = vi.fn();
  let rosa = 0;
  let yuki = 0;
  const summariesWas = CONFIG.AI.CONVERSATION_SUMMARIES;

  beforeAll(() => {
    // Off under vitest (constants.ts) so no other test reaches the model.
    (CONFIG.AI as { CONVERSATION_SUMMARIES: boolean }).CONVERSATION_SUMMARIES = true;
    const loc = db.insert(locations).values({
      name: 'Summary Skip Tavern',
      type: 'tavern',
      position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 1, y: 4 },
      owner: null,
      capacity: 10,
      current_occupants: [],
      operating_hours: null,
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    const agent = (name: string) => db.insert(agents).values({
      name,
      bio: 'test',
      traits: [],
      personality: null,
      age: 30,
      gender: 'female',
      sprite_sheet: 'x',
      portrait_sprite: 'x',
      position: { x: 0, y: 0 },
      current_location: loc,
      current_action: { type: 'idle' },
      action_started: 0,
      action_queue: [],
      schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home: loc,
      created_at: 0,
      is_active: true,
    }).returning({ id: agents.id }).get().id;
    rosa = agent('Rosa Skiptest');
    yuki = agent('Yuki Skiptest');
    initMemoryObserver({ record } as unknown as MemoryService);
  });

  afterAll(() => {
    (CONFIG.AI as { CONVERSATION_SUMMARIES: boolean }).CONVERSATION_SUMMARIES = summariesWas;
    clearSpotlight();
  });

  beforeEach(() => {
    record.mockClear();
    vi.mocked(callOllamaChat).mockClear();
    clearSpotlight();
  });

  let conversationId = 9000;
  function end(lines: number): void {
    const messages = Array.from({ length: lines }, (_, i) => ({
      speakerId: i % 2 ? yuki : rosa,
      text: i === 2 ? "I never told anyone, but I am afraid of the dark." : `Some ordinary remark number ${i}.`,
      sentiment: 0.2,
    }));
    simEvents.emit('conversation:ended', {
      agentId: rosa, conversationId: ++conversationId, otherName: 'Yuki Skiptest',
      summary: 'chat', turns: lines, sentiment: 0.2, messages,
    });
  }

  it('a short off-screen chat gets the gist memory, no LLM call', () => {
    end(4);
    expect(callOllamaChat).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(rosa, 'conversation', expect.any(String), expect.anything(), expect.anything());
  });

  it('the same chat on screen asks for a summary at normal priority', async () => {
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: '{}' }) as never);
    setSpotlight([yuki]);
    end(4);
    await vi.waitFor(() => expect(callOllamaChat).toHaveBeenCalledTimes(1));
    expect(vi.mocked(callOllamaChat).mock.calls[0][0]).toMatchObject({ purpose: 'conversation.summary', priority: 'normal' });
  });

  it('a long off-screen chat is still summarised, at low priority', async () => {
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: '{}' }) as never);
    end(OFFSCREEN_MIN_SUMMARY_LINES);
    await vi.waitFor(() => expect(callOllamaChat).toHaveBeenCalledTimes(1));
    expect(vi.mocked(callOllamaChat).mock.calls[0][0]).toMatchObject({ priority: 'low' });
  });
});
