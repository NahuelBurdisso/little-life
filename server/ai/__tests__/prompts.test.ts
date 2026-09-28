import { describe, it, expect, beforeEach } from 'vitest';
import { buildAgentSystemPrompt, buildConversationPrompt, ConversationPromptParams } from '../prompts';
import { clearVoiceDirectiveCache } from '../voiceDirective';

const mockAgent = {
  id: 1, name: 'Ray Kowalski', bio: '', age: 44, gender: 'male',
  traits: ['cynical', 'observant', 'intimidating'],
  personality: {
    honesty: 35, aggression: 65, warmth: 30, impulsiveness: 45,
    vanity: 55, curiosity: 70, loyalty: 50, morality: 40,
    sensuality: 35, neuroticism: 45,
  },
};

const mockNeeds = { mood: 25, energy: 60, hunger: 50, social: 40 };
const mockEcon = { job: 'constable', job_title: 'Town Constable', money: 50 };

describe('buildAgentSystemPrompt', () => {
  beforeEach(() => clearVoiceDirectiveCache());

  it('includes name, age, job title', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon);
    expect(prompt).toContain('Ray Kowalski');
    expect(prompt).toContain('44');
    expect(prompt).toContain('Town Constable');
  });

  it('includes traits line', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon);
    expect(prompt).toContain('cynical, observant, and intimidating');
  });

  it('includes voice directive from personality', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon);
    // honesty:35 + curiosity:70 triggers "social spy" combo
    expect(prompt).toContain('social spy');
  });

  it('includes mood line when mood < 35', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, { ...mockNeeds, mood: 25 }, mockEcon);
    expect(prompt).toContain("You're in a bad mood");
  });

  it('omits mood line when mood is neutral', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, { ...mockNeeds, mood: 50 }, mockEcon);
    expect(prompt).not.toContain('mood');
  });

  it('includes critical needs when hunger < 15', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, { ...mockNeeds, hunger: 10 }, mockEcon);
    expect(prompt).toContain('starving');
  });

  it('includes money when < 10', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, { ...mockEcon, money: 3 });
    expect(prompt).toContain('$3');
  });

  it('includes state line when provided', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon, mockAgent.personality, ["You've been drinking."]);
    expect(prompt).toContain("You've been drinking");
  });

  it('includes instruction line', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon);
    expect(prompt).toContain('Reply in 1-2 sentences');
  });
});

describe('buildConversationPrompt', () => {
  beforeEach(() => clearVoiceDirectiveCache());

  const mockOther = {
    id: 2, name: 'Carlos Mendez', bio: '', age: 45, gender: 'male',
    traits: ['generous', 'funny'], personality: null,
  };

  const baseParams: ConversationPromptParams = {
    speaker: mockAgent,
    speakerNeeds: mockNeeds,
    speakerEcon: mockEcon,
    conversation: {
      id: 1, messages: [], trigger_reason: 'proximity',
      topic: 'confrontation', sentiment: 0, max_turns: 6,
    },
    relationship: {
      agent_a: 1, agent_b: 2,
      friendship_ab: -50, friendship_ba: -30,
      romance_ab: 0, romance_ba: 0,
      trust_ab: -40, trust_ba: -20,
      familiarity: 45, interaction_count: 10,
      tags: ['grudge', 'antagonist'],
    },
    otherAgent: mockOther,
    memories: [],
    world: { time: { day: 5, hour: 20, minute: 30, totalTicks: 100, season: 'spring' }, weather: 'cloudy' },
    location: { id: 1, name: 'The Rusty Lantern', description: 'A cozy tavern' },
  };

  it('produces compact setting line', () => {
    const { messages } = buildConversationPrompt(baseParams);
    const userMsg = messages[0].content;
    expect(userMsg).toContain('Evening, day 5');
    expect(userMsg).toContain('Spring');
    expect(userMsg).toContain('cloudy');
    expect(userMsg).toContain('The Rusty Lantern');
  });

  it('produces emotionally-weighted relationship tag for hostile relationship', () => {
    const { messages } = buildConversationPrompt(baseParams);
    const userMsg = messages[0].content;
    expect(userMsg).toContain("You can't stand Carlos");
  });

  it('includes structural tags', () => {
    const { messages } = buildConversationPrompt(baseParams);
    const userMsg = messages[0].content;
    expect(userMsg).toContain('You hold a grudge');
  });

  it('includes topic in first turn instruction', () => {
    const { messages } = buildConversationPrompt(baseParams);
    const userMsg = messages[0].content;
    expect(userMsg).toContain('discuss confrontation with Carlos Mendez');
  });

  it('uses "Respond to" for mid-conversation turns', () => {
    const params = {
      ...baseParams,
      conversation: {
        ...baseParams.conversation,
        messages: [{ speakerId: 2, text: 'Hey Ray' }],
      },
    };
    const { messages } = buildConversationPrompt(params);
    const userMsg = messages[messages.length - 1].content;
    expect(userMsg).toContain('Respond to Carlos');
  });

  it('handles null relationship', () => {
    const params = { ...baseParams, relationship: null };
    const { messages } = buildConversationPrompt(params);
    const userMsg = messages[0].content;
    expect(userMsg).toContain("You don't know Carlos");
    expect(userMsg).not.toContain('grudge');
  });

  it('limits message history to 6', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      speakerId: i % 2 === 0 ? 1 : 2,
      text: `Message ${i}`,
    }));
    const params = {
      ...baseParams,
      conversation: { ...baseParams.conversation, messages: msgs },
    };
    const { messages } = buildConversationPrompt(params);
    const transcript = messages.map((m) => m.content).join('\n');
    expect(transcript).not.toContain('Message 3');
    for (let i = 4; i < 10; i++) expect(transcript).toContain(`Message ${i}`);
  });

  it('puts the turn instruction after the history, as the final user message', () => {
    const msgs = [
      { speakerId: 2, text: 'Evening, Ray.' },
      { speakerId: 1, text: 'What do you want?' },
      { speakerId: 2, text: 'Just a drink.' },
    ];
    const { messages } = buildConversationPrompt({
      ...baseParams,
      conversation: { ...baseParams.conversation, messages: msgs, max_turns: 10 },
    });
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('Carlos: Just a drink.\n\n[Your turn] Respond to Carlos');
    expect(messages[0].content).not.toContain('Respond to');
  });

  it("labels the other person's lines with their name, not the speaker's own", () => {
    const msgs = [
      { speakerId: 2, text: 'How are you?' },
      { speakerId: 1, text: 'Fine.' },
    ];
    const { messages } = buildConversationPrompt({
      ...baseParams,
      conversation: { ...baseParams.conversation, messages: msgs },
    });
    expect(messages[0].content).toContain('Carlos: How are you?');
    expect(messages.find((m) => m.role === 'assistant')?.content).toBe('Fine.');
  });

  it('keeps canned fallback narration out of the speech history', () => {
    const msgs = [
      { speakerId: 2, text: 'Carlos Mendez shrugged.', fallback: true },
      { speakerId: 1, text: 'Ray Kowalski smiled and nodded.', fallback: true },
      { speakerId: 2, text: 'So, about that debt.' },
    ];
    const { messages } = buildConversationPrompt({
      ...baseParams,
      conversation: { ...baseParams.conversation, messages: msgs, max_turns: 10 },
    });
    const transcript = messages.map((m) => m.content).join('\n');
    // The other's action stays visible as a bracketed note, not as a spoken line.
    expect(transcript).toContain('[Carlos Mendez shrugged.]');
    expect(transcript).not.toContain('Carlos: Carlos Mendez shrugged.');
    // The speaker's own narration is dropped — as an assistant turn it would teach narrating.
    expect(transcript).not.toContain('smiled and nodded');
    expect(messages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('alternates user and assistant roles', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ speakerId: i % 2 === 0 ? 2 : 1, text: `Line ${i}` }));
    const { messages } = buildConversationPrompt({
      ...baseParams,
      conversation: { ...baseParams.conversation, messages: msgs },
    });
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
  });

  it('asks the speaker not to reuse their own recent openers and questions', () => {
    const msgs = [
      { speakerId: 1, text: 'Well, I suppose. How are you doing, really?' },
      { speakerId: 2, text: 'Fine, fine.' },
      { speakerId: 1, text: 'Well, I heard the mill is hiring.' },
      { speakerId: 2, text: 'Is it?' },
    ];
    const { messages } = buildConversationPrompt({
      ...baseParams,
      conversation: { ...baseParams.conversation, messages: msgs },
    });
    const last = messages[messages.length - 1].content;
    expect(last).toContain(`Don't start with "Well, I" again.`);
    expect(last).toContain(`Don't repeat your question "How are you doing, really?"`);
    // Only the speaker's own lines count — Carlos's "Is it?" is not Ray's question.
    expect(last).not.toContain('Is it?"');
  });
});
