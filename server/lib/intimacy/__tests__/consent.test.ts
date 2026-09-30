import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../../../ai/ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../ai/ollama')>()),
  callOllamaChat: vi.fn(),
}));

import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog, agents, conversationQueue, locations, needs, relationships, worldState,
} from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import { RENDEZVOUS_TOPIC } from '../../../ai/prompts';
import { CONFIG } from '../../constants';
import { bumpWorldEpoch } from '../../worldEpoch';
import { simEvents } from '../../simEvents';
import { gameMinutes } from '../../gameClock';
import { setRuleOverrides } from '../../worldRules';
import {
  CHARACTER_VETO_BELOW, REFUSAL_MOOD, REFUSAL_MOOD_MINUTES, REFUSAL_RETRY_MINUTES,
  decideConsent, onRendezvousConversationEnded, registerRendezvousListener, regexConsent,
} from '../rendezvous';
import { CONSENT_LINES, buildConsentPrompt, parseConsent, type ConsentInput, type ConsentLine } from '../consentPrompt';
import { clearIntimacy, ensureAgentIntimacy, getPairIntimacy, updatePairIntimacy } from '../state';
import { KISSED_TAG } from '../kiss';

/**
 * Consent: how a lover's answer is read (LLM, then words, then character) and
 * what a yes and a no do. The model never overrides character: an answerer whose
 * willingness is under 0.25 refuses whatever anything says.
 */

const ASKER = 1;
const ANSWERER = 2;
const lines = (...texts: string[]): ConsentLine[] => texts.map((text, i) => ({
  speakerId: i % 2 === 0 ? ASKER : ANSWERER, speaker: i % 2 === 0 ? 'Ada Marsh' : 'Bruno Cole', text,
}));
const input = (over: Partial<ConsentInput> = {}): ConsentInput => ({
  lines: lines('Would you spend the evening with me?', 'Yes, I would love to.'),
  initiatorName: 'Ada Marsh', answererId: ANSWERER, answererName: 'Bruno Cole', willingness: 0.7, ...over,
});
const say = (text: string) => vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text }) as never);
const llmSays = (accepted: boolean) => say(JSON.stringify({ accepted, reason: 'because' }));
const calls = () => vi.mocked(callOllamaChat).mock.calls;

beforeEach(() => vi.mocked(callOllamaChat).mockReset());

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe('parseConsent', () => {
  it('reads the structured reply', () => {
    expect(parseConsent('{"accepted": true, "reason": "warm yes"}')).toEqual({ accepted: true, reason: 'warm yes' });
    expect(parseConsent('{"accepted": false, "reason": "deflected"}')).toEqual({ accepted: false, reason: 'deflected' });
  });

  it('is tolerant of prose around the JSON, string booleans and a missing reason', () => {
    expect(parseConsent('Sure! ```json\n{"accepted": true, "reason": "ok"}\n``` hope that helps')?.accepted).toBe(true);
    expect(parseConsent('{"accepted": "yes"}')).toEqual({ accepted: true, reason: '' });
    expect(parseConsent('{"accepted": "False", "reason": 5}')).toEqual({ accepted: false, reason: '' });
  });

  it('caps the reason at 120 characters and returns null for anything unusable', () => {
    expect(parseConsent(`{"accepted": true, "reason": "${'x'.repeat(300)}"}`)?.reason).toHaveLength(120);
    for (const bad of ['', 'yes', '{"reason": "no verdict"}', '{"accepted": 1}', '{broken', 'null', '[]']) {
      expect(parseConsent(bad), bad).toBeNull();
    }
  });
});

describe('regexConsent', () => {
  const reply = (text: string) => regexConsent(lines('Will you?', text), ANSWERER);

  it('reads a clear yes or no from the answerer\'s own first reply', () => {
    expect(reply("Yes, I'd love to.")).toBe(true);
    expect(reply('Of course. Gladly.')).toBe(true);
    expect(reply("No, I can't tonight.")).toBe(false);
    expect(reply("I won't, forgive me.")).toBe(false);
  });

  it('is undecided when it says both, neither, or the answerer said nothing', () => {
    expect(reply('Of course not... well, yes')).toBeNull();
    expect(reply('Hmm, the evening is chilly.')).toBeNull();
    expect(regexConsent(lines('Will you?'), ANSWERER)).toBeNull();
  });

  it('does not read the asker\'s words as the answer', () => {
    expect(regexConsent([{ speakerId: ASKER, speaker: 'Ada Marsh', text: 'Yes, please, come.' }], ANSWERER)).toBeNull();
  });
});

// ─── decideConsent ───────────────────────────────────────────────────────────

describe('decideConsent', () => {
  it('the LLM reads the answer: yes accepts, no refuses, through a structured call at normal priority', async () => {
    llmSays(true);
    const yes = await decideConsent(input(), { llm: true });
    expect(yes).toMatchObject({ accepted: true, source: 'llm', reason: 'because' });

    llmSays(false);
    const no = await decideConsent(input({ lines: lines('Come to mine?', 'Yes, I would love to.') }), { llm: true });
    // The model's no stands even though the words said yes: the model is the reader.
    expect(no).toMatchObject({ accepted: false, source: 'llm' });

    expect(calls()).toHaveLength(2);
    const arg = calls()[0][0];
    expect(arg).toMatchObject({ purpose: 'intimacy.consent', priority: 'normal' });
    expect(arg.format).toMatchObject({
      type: 'object',
      properties: { accepted: { type: 'boolean' }, reason: { type: 'string', maxLength: 120 } },
      required: ['accepted', 'reason'],
    });
  });

  it('reads only the last four lines of the conversation', async () => {
    const long = lines('one-line-A', 'two-line-B', 'three-line-A', 'four-line-B', 'five-line-A', 'six-line-B');
    const prompt = buildConsentPrompt(input({ lines: long }));
    expect(CONSENT_LINES).toBe(4);
    for (const kept of ['three-line-A', 'four-line-B', 'five-line-A', 'six-line-B']) expect(prompt.system).toContain(kept);
    for (const dropped of ['one-line-A', 'two-line-B']) expect(prompt.system).not.toContain(dropped);

    llmSays(true);
    await decideConsent(input({ lines: long }), { llm: true });
    expect(calls()[0][0].system).not.toContain('one-line-A');
  });

  it('the prompt stays discreet: an invitation and its answer, nothing more', () => {
    const { system, user } = buildConsentPrompt(input());
    expect(`${system} ${user}`).toMatch(/spend the evening together somewhere private/);
    expect(`${system} ${user}`).not.toMatch(/sex|naked|bed\b|intercourse/i);
  });

  it('the answerer\'s character overrides a yes from the LLM (willingness < 0.25 refuses)', async () => {
    llmSays(true);
    const out = await decideConsent(input({ willingness: 0.2 }), { llm: true });
    expect(out).toMatchObject({ accepted: false, source: 'character' });
    // A flat-no character never even reaches the model.
    expect(calls()).toHaveLength(0);
  });

  it('...and overrides the words and the rule too', async () => {
    expect(await decideConsent(input({ willingness: 0.2 }), { llm: false })).toMatchObject({ accepted: false, source: 'character' });
    expect(await decideConsent(input({ willingness: 0 }), { llm: true })).toMatchObject({ accepted: false, source: 'character' });
    expect(await decideConsent(input({ willingness: CHARACTER_VETO_BELOW - 0.001 }), { llm: true })).toMatchObject({ accepted: false });
  });

  it('at exactly the veto line the model is consulted and its yes stands', async () => {
    llmSays(true);
    expect(await decideConsent(input({ willingness: CHARACTER_VETO_BELOW }), { llm: true })).toMatchObject({ accepted: true, source: 'llm' });
  });

  it('an LLM no stands however willing the character is', async () => {
    llmSays(false);
    expect(await decideConsent(input({ willingness: 0.95 }), { llm: true })).toMatchObject({ accepted: false, source: 'llm' });
  });

  it('falls back to the words when the call fails or comes back unusable', async () => {
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => { throw new Error('model down'); });
    expect(await decideConsent(input(), { llm: true })).toMatchObject({ accepted: true, source: 'regex' });

    say('I could not decide, sorry.');
    expect(await decideConsent(input({ lines: lines('Come?', "No, I can't.") }), { llm: true }))
      .toMatchObject({ accepted: false, source: 'regex' });
  });

  it('falls back to the rule when the words are undecided too: willingness >= 0.5 accepts', async () => {
    const vague = lines('Come to mine tonight?', 'The evening is chilly, is it not.');
    expect(await decideConsent(input({ lines: vague, willingness: 0.5 }), { llm: false })).toMatchObject({ accepted: true, source: 'rule' });
    expect(await decideConsent(input({ lines: vague, willingness: 0.49 }), { llm: false })).toMatchObject({ accepted: false, source: 'rule' });
  });

  it('a regex yes with a character that would refuse is still a refusal', async () => {
    expect(await decideConsent(input({ willingness: 0.1 }), { llm: false })).toMatchObject({ accepted: false });
  });

  it('skips the model when the answerer said nothing, or when LLM consent is off (the default under tests)', async () => {
    llmSays(true);
    const silent = await decideConsent(input({ lines: lines('Come to mine tonight?'), willingness: 0.8 }), { llm: true });
    expect(silent).toMatchObject({ accepted: true, source: 'rule' });
    expect(calls()).toHaveLength(0);

    expect(CONFIG.AI.INTIMACY_CONSENT).toBe(false);
    await decideConsent(input());
    await decideConsent(input(), { llm: false });
    expect(calls()).toHaveLength(0);
  });
});

// ─── The listener against the DB ─────────────────────────────────────────────

const TIME = { day: 40, hour: 21, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);

let homeId: number;
const made: number[] = [];

function setClock(): void {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time: TIME, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time: TIME, day_phase: 'evening', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

/**
 * `a` (woman) has an invitation out to `b` (man). `b`'s feelings decide his
 * willingness: the defaults are plainly willing (0.5 + 0.12 + 0.18 = 0.8).
 */
function invitation(opts: { romanceB?: number; trustB?: number; longingB?: number; bOver?: Partial<typeof agents.$inferInsert> } = {}) {
  const a = insertAgent(`Asker ${made.length}`, { gender: 'female' });
  const b = insertAgent(`Asked ${made.length}`, { gender: 'male', ...opts.bOver });
  db.insert(relationships).values({
    agent_a: a, agent_b: b, friendship_ab: 70, friendship_ba: 70,
    romance_ab: 80, romance_ba: opts.romanceB ?? 80, trust_ab: 70, trust_ba: opts.trustB ?? 60,
    familiarity: 80, interaction_count: 40, last_interaction: 0, average_interaction_sentiment: 0.5,
    tags: [KISSED_TAG], status: 'romantic_interest', created_at: 0, last_updated: 0,
  }).run();
  ensureAgentIntimacy(a).longing = 70;
  ensureAgentIntimacy(b).longing = opts.longingB ?? 60;
  updatePairIntimacy(a, b, (p) => { p.pendingRendezvous = { initiatorId: a, since: NOW - 10 }; });
  return { a, b };
}

const ended = (agentId: number, other: number, texts: string[], over: Record<string, unknown> = {}) => ({
  agentId, perpetratorId: other, conversationId: 7_000 + agentId, summary: RENDEZVOUS_TOPIC, turns: texts.length, sentiment: 0.4,
  messages: texts.map((text, i) => ({ speakerId: i % 2 === 0 ? agentId : other, text })),
  ...over,
});
const yesTalk = ['Would you spend the evening with me, somewhere quiet?', 'Yes, I would love to.'];
const noTalk = ['Would you spend the evening with me, somewhere quiet?', "No, I can't. Forgive me."];
const pending = (a: number, b: number) => getPairIntimacy(a, b)?.pendingRendezvous;
const moods = (id: number) => db.select().from(needs).where(eq(needs.agent_id, id)).get()!.mood_modifiers;
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('the answer, against the DB', () => {
  beforeAll(() => {
    setClock();
    homeId = db.insert(locations).values({
      name: 'Consent Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    setRuleOverrides({ adultContent: true });
    registerRendezvousListener();
  });

  beforeEach(() => {
    clearIntimacy();
    setClock();
    setRuleOverrides({ adultContent: true });
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'rendezvous')).run();
  });

  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'rendezvous')).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(needs).where(inArray(needs.agent_id, made)).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
    clearIntimacy();
  });

  it('a yes marks the evening agreed (venue left for Task 9) and clears nothing else', async () => {
    const { a, b } = invitation();
    await onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: false });
    expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW - 10, agreed: true, agreedAt: NOW });
    expect(pending(a, b)?.venueId).toBeUndefined();
    expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBeUndefined();
    expect(moods(a)).toHaveLength(0);
  });

  it('a no is a real outcome: mood -8 for 4 h, no new invitation for two game days, both remember, no feed row', async () => {
    const { a, b } = invitation();
    const feedBefore = db.select().from(activityLog).all().length;
    const memories: Array<{ agentId: number; description: string }> = [];
    const onMemory = (p: { agentId: number; description: string }) => memories.push(p);
    simEvents.on('life:milestone', onMemory);
    try {
      await onRendezvousConversationEnded(ended(a, b, noTalk), { llm: false });
    } finally {
      simEvents.off('life:milestone', onMemory);
    }
    expect(pending(a, b)).toBeUndefined();
    expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBe(NOW + REFUSAL_RETRY_MINUTES);
    expect(REFUSAL_RETRY_MINUTES).toBe(2 * 24 * 60);
    expect(moods(a)).toEqual([{ source: 'rendezvous_refused', value: REFUSAL_MOOD, expiresAt: NOW + REFUSAL_MOOD_MINUTES }]);
    expect(REFUSAL_MOOD).toBe(-8);
    expect(REFUSAL_MOOD_MINUTES).toBe(240);
    expect(moods(b)).toHaveLength(0);
    expect(memories.map((m) => m.agentId).sort()).toEqual([a, b].sort());
    expect(memories.map((m) => m.description).join(' ')).not.toMatch(/sex|naked|bed\b/i);
    expect(db.select().from(activityLog).all().length).toBe(feedBefore);
  });

  it('the model cannot make someone consent against their character: LLM yes, willingness under 0.25 -> refused', async () => {
    // Romance 5, trust 5, no longing: willingness ~0.04.
    const { a, b } = invitation({ romanceB: 5, trustB: 5, longingB: 0 });
    llmSays(true);
    await onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: true });
    expect(pending(a, b)).toBeUndefined();
    expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBe(NOW + REFUSAL_RETRY_MINUTES);
    expect(moods(a)).toHaveLength(1);
  });

  it('an LLM yes from a willing answerer is accepted; an LLM no is refused', async () => {
    const yes = invitation();
    llmSays(true);
    await onRendezvousConversationEnded(ended(yes.a, yes.b, noTalk), { llm: true });
    expect(pending(yes.a, yes.b)?.agreed).toBe(true);

    const no = invitation();
    llmSays(false);
    await onRendezvousConversationEnded(ended(no.a, no.b, yesTalk), { llm: true });
    expect(pending(no.a, no.b)).toBeUndefined();
  });

  it('the event fires once per participant: only the asker\'s copy acts, and a repeat does nothing', async () => {
    const { a, b } = invitation();
    // The answerer's copy first (perpetrator = the asker): ignored.
    await onRendezvousConversationEnded(ended(b, a, yesTalk), { llm: false });
    expect(pending(a, b)?.agreed).toBeUndefined();
    expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBeUndefined();

    await onRendezvousConversationEnded(ended(a, b, noTalk), { llm: false });
    expect(moods(a)).toHaveLength(1);
    const retry = getPairIntimacy(a, b)?.rendezvousRetryAfter;
    await onRendezvousConversationEnded(ended(a, b, noTalk), { llm: false });
    expect(moods(a)).toHaveLength(1);
    expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBe(retry);
  });

  it('through the registered listener: a real conversation:ended settles it', async () => {
    const { a, b } = invitation();
    simEvents.emit('conversation:ended', ended(a, b, yesTalk));
    simEvents.emit('conversation:ended', ended(b, a, yesTalk));
    await flush();
    expect(pending(a, b)?.agreed).toBe(true);
  });

  it('ignores other conversations, unrelated template chats, and a rule that is off', async () => {
    const { a, b } = invitation();
    await onRendezvousConversationEnded(ended(a, b, yesTalk, { summary: 'weather' }), { llm: false });
    // A template chat that was not the queued invitation (small talk, a script topic) is not an answer.
    await onRendezvousConversationEnded(
      ended(a, b, yesTalk, { summary: 'the weather', template: true, triggerReason: 'social' }), { llm: false });
    expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW - 10 });
    setRuleOverrides({ adultContent: false });
    await onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: false });
    expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW - 10 });
  });

  // I1: the invitation that fell to the template tier (no LLM, or a slot busy for an hour) used to be ignored,
  // expire after 3 h and be asked again 12 h later, forever: 0 trysts in every as-shipped soak. It is
  // answered now by the answerer's character, as proposals are; the chat's script lines say nothing about it.
  describe('an invitation that fell to the template tier', () => {
    const templateChat = (a: number, b: number, texts = ['Lovely evening.', 'No, not at all.']) =>
      ended(a, b, texts, { template: true, summary: 'the evening sky', triggerReason: 'rendezvous' });

    it('a willing answerer accepts on character, whatever the script lines said', async () => {
      const { a, b } = invitation();
      await onRendezvousConversationEnded(templateChat(a, b), { llm: true });
      expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW - 10, agreed: true, agreedAt: NOW });
      // No model was asked to read canned script lines.
      expect(calls()).toHaveLength(0);
    });

    it('an answerer whose character is under the bar refuses, with the refusal\'s real cost', async () => {
      // Romance 40, trust 40, longing 20: willingness 0.34, above the veto and under 0.5.
      const { a, b } = invitation({ romanceB: 40, trustB: 40, longingB: 20 });
      await onRendezvousConversationEnded(templateChat(a, b, ['Yes, gladly.', 'Yes, of course.']), { llm: true });
      expect(pending(a, b)).toBeUndefined();
      expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBe(NOW + REFUSAL_RETRY_MINUTES);
      expect(moods(a)).toHaveLength(1);
    });

    it('the character veto still applies', async () => {
      const { a, b } = invitation({ romanceB: 5, trustB: 5, longingB: 0 });
      await onRendezvousConversationEnded(templateChat(a, b), { llm: false });
      expect(pending(a, b)).toBeUndefined();
      expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBe(NOW + REFUSAL_RETRY_MINUTES);
    });

    it('settles once, through the registered listener', async () => {
      const { a, b } = invitation();
      simEvents.emit('conversation:ended', templateChat(a, b));
      simEvents.emit('conversation:ended', templateChat(b, a));
      await flush();
      expect(pending(a, b)?.agreed).toBe(true);
    });
  });

  it('does nothing without an invitation of the asker\'s own', async () => {
    const { a, b } = invitation();
    updatePairIntimacy(a, b, (p) => { delete p.pendingRendezvous; });
    await onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: false });
    expect(pending(a, b)).toBeUndefined();
    // An invitation the OTHER one made is not settled by this one's conversation.
    updatePairIntimacy(a, b, (p) => { p.pendingRendezvous = { initiatorId: b, since: NOW }; });
    await onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: false });
    expect(pending(a, b)).toEqual({ initiatorId: b, since: NOW });
  });

  it('an answer that arrives after the world was replaced is dropped', async () => {
    const { a, b } = invitation();
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => {
      bumpWorldEpoch();
      return { text: '{"accepted": true, "reason": "yes"}' } as never;
    });
    await onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: true });
    expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW - 10 });
    expect(moods(a)).toHaveLength(0);
  });

  it('while the answer is being read nothing else is seated for the pair', async () => {
    const { a, b } = invitation();
    let release!: () => void;
    vi.mocked(callOllamaChat).mockImplementationOnce(() => new Promise((res) => {
      release = () => res({ text: '{"accepted": true, "reason": "yes"}' } as never);
    }));
    const done = onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: true });
    const { pendingRendezvousPartner } = await import('../rendezvous');
    expect(pendingRendezvousPartner(a)).toBeNull();
    // A second copy of the same event is a no-op while the first is in flight.
    await onRendezvousConversationEnded(ended(a, b, noTalk), { llm: false });
    expect(pending(a, b)?.agreed).toBeUndefined();
    release();
    await done;
    expect(pending(a, b)?.agreed).toBe(true);
    expect(moods(a)).toHaveLength(0);
  });

  it('a pair that is no longer eligible (a minor) gets no answer and no evening', async () => {
    const { a, b } = invitation({ bOver: { age: 17 } });
    await onRendezvousConversationEnded(ended(a, b, yesTalk), { llm: false });
    expect(pending(a, b)).toBeUndefined();
    expect(getPairIntimacy(a, b)?.pendingRendezvous?.agreed).toBeUndefined();
  });

  it('with no answer text at all the rule decides (a willing answerer accepts)', async () => {
    const { a, b } = invitation();
    await onRendezvousConversationEnded(ended(a, b, [], { turns: 0 }), { llm: false });
    expect(pending(a, b)?.agreed).toBe(true);
  });
});
