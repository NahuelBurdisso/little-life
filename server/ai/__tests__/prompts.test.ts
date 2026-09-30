import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildAgentSystemPrompt, buildConversationPrompt, topicIntent, romanceLevel, ConversationPromptParams, PROPOSAL_TOPIC, RENDEZVOUS_TOPIC } from '../prompts';
import { clearVoiceDirectiveCache } from '../voiceDirective';
import { maturityDirective } from '../contentRating';
import { TOWN_SETTING } from '../setting';

// The `adultContent` rule, flipped per test without a world row.
const rules = vi.hoisted(() => ({ adult: false }));
beforeEach(() => { rules.adult = false; });
vi.mock('../../lib/worldRules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/worldRules')>()),
  isAdultContent: () => rules.adult,
}));

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

  it('turns the topic label into an intent in the first turn instruction', () => {
    const { messages } = buildConversationPrompt(baseParams);
    const userMsg = messages[messages.length - 1].content;
    expect(userMsg).toContain('Something Carlos did has been eating at you');
    expect(userMsg).not.toContain('discuss confrontation');
  });

  it("bans the stock pleasantries in the opener, except in a newcomer's introduction (G6)", () => {
    const acquainted = {
      ...baseParams,
      relationship: { ...baseParams.relationship!, familiarity: 40 },
    };
    const opener = buildConversationPrompt(acquainted).messages.at(-1)!.content;
    expect(opener).toContain('"how are you doing today"');
    expect(opener).toContain('start with the thing itself');

    // Townsfolk who never really talked still know each other: same rule.
    const neverTalked = {
      ...baseParams,
      relationship: { ...baseParams.relationship!, familiarity: 0 },
    };
    expect(buildConversationPrompt(neverTalked).messages.at(-1)!.content).toContain('how are you doing today');

    const newcomer = { ...neverTalked, newcomer: 'listener' as const };
    expect(buildConversationPrompt(newcomer).messages.at(-1)!.content).not.toContain('how are you doing today');
  });

  describe('first meetings (playtest #3: "Well, I am Thomas Park, the Mayor")', () => {
    const friendly = {
      ...baseParams,
      conversation: { ...baseParams.conversation, topic: 'offering help' },
      relationship: { ...baseParams.relationship!, friendship_ab: 5, familiarity: 0, interaction_count: 0, tags: [] },
    };

    it('treats townsfolk who never talked as known by sight, not strangers, and keeps the topic', () => {
      const last = buildConversationPrompt(friendly).messages.at(-1)!.content;
      expect(last).toContain('know each other by sight and reputation');
      expect(last).toContain("Don't introduce yourself");
      expect(last).not.toMatch(/Introduce yourself/);
      expect(last).toContain('could use a hand');
    });

    it('sizes up a disliked face without an introduction', () => {
      const cold = { ...friendly, relationship: { ...friendly.relationship, friendship_ab: -20 } };
      const last = buildConversationPrompt(cold).messages.at(-1)!.content;
      expect(last).toContain("what you've heard doesn't impress you");
      expect(last).toContain("Don't introduce yourself");
    });

    it('lets only a newcomer be introduced', () => {
      const toNewcomer = buildConversationPrompt({ ...friendly, newcomer: 'listener' }).messages;
      expect(toNewcomer.at(-1)!.content).toContain("Carlos is new in town and you've never met. Introduce yourself");
      const asNewcomer = buildConversationPrompt({ ...friendly, newcomer: 'speaker', relationship: null }).messages;
      expect(asNewcomer.at(-1)!.content).toContain("You're new in town and have never met Carlos. Introduce yourself.");
      expect(asNewcomer[0].content).toContain("You've never met Carlos.");
    });

    it('stops framing a pair as a first meeting once they have talked', () => {
      const talked = { ...friendly, newcomer: 'listener' as const, relationship: { ...friendly.relationship, familiarity: 30 } };
      const last = buildConversationPrompt(talked).messages.at(-1)!.content;
      expect(last).not.toContain('new in town');
      expect(last).not.toContain('by sight');
    });

    it('names the listener by first name in the instructions', () => {
      const last = buildConversationPrompt(friendly).messages.at(-1)!.content.split('[Your turn]')[1];
      expect(last).not.toContain('Carlos Mendez');
      expect(last).toContain('Carlos');
    });
  });

  it('says who the listener is, so facts about their office are about them (playtest #3)', () => {
    const mayor = buildConversationPrompt({
      ...baseParams,
      otherAgent: { ...mockOther, name: 'Thomas Park' },
      otherJobTitle: 'Town Mayor',
    }).messages[0].content;
    expect(mayor).toContain("You're talking to Thomas Park (Thomas to you), the town mayor — whatever you know about the town mayor is about him.");
    const noJob = buildConversationPrompt({ ...baseParams, otherJobTitle: null }).messages[0].content;
    expect(noJob).toContain("You're talking to Carlos Mendez (Carlos to you).");
  });

  it('carries the stable self facts and drops the empty "neutral" reputation', () => {
    const system = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon, null, [], {
      reputationLabel: 'neutral', reputationScore: 3, hobbies: [], moodMomentum: 0, drinkCount: 0,
      selfFacts: 'Facts about you (keep them straight): Constable for 6 years; came to town 6 years ago.',
    });
    expect(system).toContain('Constable for 6 years');
    expect(system).not.toContain('consider you neutral');
  });

  describe('town roster (no invented townsfolk)', () => {
    const enrich = (roster?: string) => ({
      reputationLabel: 'neutral', reputationScore: 0, hobbies: [], moodMomentum: 0, drinkCount: 0, roster,
    });
    const ROSTER = 'People in town: Rosa Chen (Shopkeeper), Omar Haddad (Baker). Anyone not on this list is a stranger to town; never make up names for townsfolk.';

    it('puts the roster in the system prompt, after the header and before the volatile lines', () => {
      const system = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon, null, [], enrich(ROSTER));
      expect(system).toContain(ROSTER);
      // Stable prefix: header, then roster, then the mood/needs lines that change per turn.
      expect(system.indexOf(ROSTER)).toBeGreaterThan(system.indexOf(TOWN_SETTING));
      expect(system.indexOf(ROSTER)).toBeLessThan(system.indexOf('Your financial situation'));
    });

    it('is not in the per-turn user message', () => {
      const user = buildConversationPrompt({ ...baseParams, enrichment: enrich(ROSTER) }).messages[0].content;
      expect(user).not.toContain('People in town');
    });

    it('changes nothing without a roster', () => {
      const without = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon, null, [], enrich());
      const empty = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon, null, [], enrich(''));
      expect(without).not.toContain('People in town');
      expect(empty).toBe(without);
    });
  });

  describe('romance grounding (playtest #3: "my love" at romance 26)', () => {
    const withRomance = (romance_ab: number, romance_ba: number, tags: string[] = [], topic = 'catching up') =>
      buildConversationPrompt({
        ...baseParams,
        conversation: { ...baseParams.conversation, topic },
        relationship: { ...baseParams.relationship!, friendship_ab: 50, friendship_ba: 50, romance_ab, romance_ba, tags },
      }).messages[0].content;

    it('names the level and forbids pet names below a couple', () => {
      expect(romanceLevel(26.6, [])).toBe('spark');
      expect(romanceLevel(45, [])).toBe('courting');
      expect(romanceLevel(80, [])).toBe('in love');
      expect(romanceLevel(10, ['partner'])).toBe('partners');
      expect(withRomance(26.6, 70)).toContain('A spark of attraction to Carlos, nothing more — no pet names like "my love"');
      expect(withRomance(80, 30)).toContain("You're in love with Carlos, but you're not a couple — no pet names");
    });

    it('lets couples be tender, and says "no romance" only when it could be mistaken', () => {
      expect(withRomance(80, 80, ['partner'])).not.toContain('pet names');
      expect(withRomance(0, 0)).not.toContain('romance');
      expect(withRomance(0, 40)).toContain('No romance on your side');
      expect(withRomance(0, 0, [], 'flirting')).toContain('No romance on your side');
    });

    it('says a shared home once', () => {
      const text = withRomance(0, 0, ['housemate', 'roommate']);
      expect(text.split('You live together.').length - 1).toBe(1);
    });
  });

  it('passes unknown topics through as a subject', () => {
    expect(topicIntent('the missing ledger', 'Rosa')).toContain('talk about the missing ledger');
    expect(topicIntent('gossip about Marco Rivera', 'Rosa')).toBe("You heard something about Marco Rivera and can't keep it to yourself.");
    expect(topicIntent('Gossip about Marco  ', 'Rosa')).toBe("You heard something about Marco and can't keep it to yourself.");
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
    expect(userMsg).toContain('You know Carlos only by sight and reputation.');
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

  describe('rendezvous (lib/intimacy/rendezvous.ts)', () => {
    const invitation = (messages: Array<{ speakerId: number; text: string }>) =>
      buildConversationPrompt({
        ...baseParams,
        relationship: { ...baseParams.relationship!, romance_ab: 85, romance_ba: 80, tags: ['kissed'] },
        conversation: { ...baseParams.conversation, topic: RENDEZVOUS_TOPIC, messages, max_turns: 6 },
      }).messages;

    it('has the asker invite discreetly on the opening turn, leaving the other free to decline', () => {
      const intent = topicIntent(RENDEZVOUS_TOPIC, 'Carlos');
      expect(intent).toContain('spend the evening with Carlos somewhere private');
      expect(intent).toContain('accept or decline');
      expect(intent).not.toMatch(/sex|naked|bed|intercourse/i);
    });

    it('asks the other for an honest yes or no on the second turn, without the flirt nudge, and says no is allowed', () => {
      const last = invitation([{ speakerId: 2, text: 'Ray, spend the evening with me?' }]).at(-1)!.content;
      expect(last).toContain('Carlos has just asked you to spend the evening with them somewhere private');
      expect(last).toContain('free to say no');
      expect(last).not.toContain('Be flirty');
    });

    it('keeps the flirt nudge off later turns too, like a proposal', () => {
      const msgs = [
        { speakerId: 2, text: 'Ray, spend the evening with me?' },
        { speakerId: 1, text: 'Let me think about it.' },
      ];
      expect(invitation(msgs).at(-1)!.content).not.toContain('Be flirty');
    });
  });

  describe('proposal (lib/milestonesEngine.ts)', () => {
    const proposal = (messages: Array<{ speakerId: number; text: string }>, tags: string[] = ['partner']) =>
      buildConversationPrompt({
        ...baseParams,
        relationship: { ...baseParams.relationship!, romance_ab: 85, romance_ba: 80, tags },
        conversation: { ...baseParams.conversation, topic: PROPOSAL_TOPIC, messages, max_turns: 6 },
      }).messages;

    it('has the proposer ask the question on the opening turn', () => {
      const last = proposal([]).at(-1)!.content;
      expect(last).toContain('ask Carlos to marry you');
    });

    it('asks the other for a plain yes or no on the second turn, without the flirt nudge', () => {
      const last = proposal([{ speakerId: 2, text: 'Ray, will you marry me?' }]).at(-1)!.content;
      expect(last).toContain('Carlos has just asked you to marry them');
      expect(last).toContain('yes or no');
      expect(last).not.toContain('Be flirty');
    });

    it('names an engagement or a marriage in the relationship line', () => {
      expect(proposal([], ['engaged'])[0].content).toContain("You're engaged to be married.");
      expect(proposal([], ['married'])[0].content).toContain("You're married to them.");
    });
  });

  describe('intimacy context (ai/intimacyContext.ts)', () => {
    const withTags = (tags: string[], over: Partial<ConversationPromptParams> = {}) =>
      buildConversationPrompt({
        ...baseParams,
        relationship: { ...baseParams.relationship!, friendship_ab: 60, friendship_ba: 60, romance_ab: 50, romance_ba: 50, tags },
        ...over,
      });

    it('tells an adult what they have shared: a kiss, and lovers with the rule on', () => {
      rules.adult = true;
      expect(withTags(['kissed']).messages[0].content).toContain('You have kissed Carlos.');
      const lovers = withTags(['kissed', 'lovers']).messages[0].content;
      expect(lovers).toContain('You and Carlos are lovers.');
      expect(lovers).not.toContain('You have kissed Carlos.');
    });

    it('with the rule off a night is not mentioned, a kiss still is', () => {
      const lovers = withTags(['kissed', 'lovers']).messages[0].content;
      expect(lovers).toContain('You have kissed Carlos.');
      expect(lovers).not.toContain('lovers');
    });

    it('nothing for minors, whatever the tags say', () => {
      rules.adult = true;
      const kid = { ...mockOther, age: 16 };
      const tagsAll = ['kissed', 'lovers', 'crush'];
      expect(withTags(tagsAll, { otherAgent: kid }).messages[0].content).not.toMatch(/kissed|lovers/);
      expect(withTags(tagsAll, { speaker: { ...mockAgent, age: 15 } }).messages[0].content).not.toMatch(/kissed|lovers/);
    });

    it('a stranger with no history adds no line', () => {
      rules.adult = true;
      expect(withTags([]).messages[0].content).not.toMatch(/kissed|lovers|ache for/);
    });
  });
});

describe('maturity directive in the dialogue header', () => {
  beforeEach(() => { clearVoiceDirectiveCache(); rules.adult = false; });
  const adultText = maturityDirective(true);
  const chasteText = maturityDirective(false);
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it('is the chaste line with the rule off, once, right after the setting', () => {
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon);
    expect(count(prompt, chasteText)).toBe(1);
    expect(prompt).not.toContain(adultText);
    expect(prompt).toContain(`${TOWN_SETTING} ${chasteText}`);
  });

  it('switches to the adult line with the rule on, still once', () => {
    rules.adult = true;
    const prompt = buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon);
    expect(count(prompt, adultText)).toBe(1);
    expect(prompt).not.toContain(chasteText);
  });

  it('stays chaste when the speaker or the listener is a minor, rule or not', () => {
    rules.adult = true;
    expect(buildAgentSystemPrompt({ ...mockAgent, age: 16 }, mockNeeds, mockEcon)).toContain(chasteText);
    expect(buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon, null, [], null, 12)).toContain(chasteText);
    expect(buildAgentSystemPrompt(mockAgent, mockNeeds, mockEcon, null, [], null, 30)).toContain(adultText);
  });

  it('a full conversation prompt carries it once', () => {
    rules.adult = true;
    const { system } = buildConversationPrompt({
      speaker: mockAgent, speakerNeeds: mockNeeds, speakerEcon: mockEcon,
      conversation: { id: 1, messages: [], trigger_reason: 'proximity', topic: 'catching up', sentiment: 0, max_turns: 6 },
      relationship: null,
      otherAgent: { id: 2, name: 'Carlos Mendez', bio: '', age: 45, gender: 'male', traits: [], personality: null },
      memories: [],
      world: { time: { day: 5, hour: 20, minute: 30, totalTicks: 100, season: 'spring' }, weather: 'cloudy' },
      location: { id: 1, name: 'The Rusty Lantern', description: 'A cozy tavern' },
    });
    expect(count(system, adultText)).toBe(1);
  });
});
