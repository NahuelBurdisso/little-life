import { describe, it, expect } from 'vitest';
import { CONVERSATION_MOOD_CAP, addConversationModifier, type MoodModifier } from '../moodModifiers';

/**
 * Every chat appended a fresh `conversation` mood modifier (+5 x sentiment for 2 game hours)
 * with no de-duplication, and the needs phase SUMS the active ones. As friendships warmed late
 * in a run, a busy afternoon stacked a dozen of them: a likely cause of the late-run mood creep.
 */
const NOW = 10_000;
const warm = (value: number, at = NOW): MoodModifier => ({ source: 'conversation', value, expiresAt: at + 120 });
const sum = (mods: MoodModifier[], sources = ['conversation', 'template_conversation']) =>
  mods.filter((m) => sources.includes(m.source)).reduce((s, m) => s + m.value, 0);

describe('addConversationModifier', () => {
  it('ten warm chats inside two game hours add at most +6 in total', () => {
    let mods: MoodModifier[] = [];
    for (let i = 0; i < 10; i++) {
      mods = addConversationModifier(mods, warm(0.8 * 5, NOW + i * 5), NOW + i * 5);
      expect(sum(mods)).toBeLessThanOrEqual(CONVERSATION_MOOD_CAP);
    }
    // And the newest chat is always the one that is kept.
    expect(mods.at(-1)).toMatchObject({ source: 'conversation', expiresAt: NOW + 9 * 5 + 120 });
    expect(mods.length).toBeGreaterThan(0);
  });

  it('keeps the newest modifiers and drops the oldest first', () => {
    const a = warm(2, NOW), b = warm(2, NOW + 1), c = warm(2, NOW + 2), d = warm(2, NOW + 3);
    let mods: MoodModifier[] = [a, b, c];
    expect(sum(mods)).toBe(6);
    mods = addConversationModifier(mods, d, NOW + 3);
    expect(mods).toEqual([b, c, d]);
  });

  it('caps a run of bitter chats at -6 the same way', () => {
    let mods: MoodModifier[] = [];
    for (let i = 0; i < 8; i++) mods = addConversationModifier(mods, warm(-4, NOW + i), NOW + i);
    expect(sum(mods)).toBeGreaterThanOrEqual(-CONVERSATION_MOOD_CAP);
    expect(sum(mods)).toBeLessThan(0);
  });

  it('counts template chats in the same budget as LLM chats', () => {
    const template: MoodModifier = { source: 'template_conversation', value: 3, expiresAt: NOW + 120 };
    const mods = addConversationModifier([template, template], warm(4), NOW);
    expect(sum(mods)).toBeLessThanOrEqual(CONVERSATION_MOOD_CAP);
    expect(mods.at(-1)!.source).toBe('conversation');
  });

  it('leaves every other source alone, and forgets chats that already expired', () => {
    const other: MoodModifier = { source: 'moment:small_joy', value: 9, expiresAt: NOW + 500 };
    const stale: MoodModifier = { source: 'conversation', value: 5, expiresAt: NOW - 1 };
    const mods = addConversationModifier([other, stale], warm(3), NOW);
    expect(mods).toContainEqual(other);
    expect(mods).not.toContainEqual(stale);
    expect(sum(mods, ['moment:small_joy'])).toBe(9);
  });

  it('a mixed run (warm and bitter) is held to a net |sum| <= 6 too, and never mutates its input', () => {
    const before: MoodModifier[] = [warm(5), warm(-4), warm(5)];
    const copy = before.map((m) => ({ ...m }));
    const mods = addConversationModifier(before, warm(5), NOW);
    expect(Math.abs(sum(mods))).toBeLessThanOrEqual(CONVERSATION_MOOD_CAP);
    expect(before).toEqual(copy);
  });

  it('clamps a single modifier that is larger than the cap by itself', () => {
    const mods = addConversationModifier([], warm(9), NOW);
    expect(mods).toHaveLength(1);
    expect(mods[0].value).toBe(CONVERSATION_MOOD_CAP);
  });
});
