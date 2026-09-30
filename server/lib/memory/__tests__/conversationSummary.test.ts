import { describe, it, expect, vi } from 'vitest';
import { buildSummaryPrompt, parseFeelings, parseSummary } from '../conversationSummary';
import { maturityDirective } from '../../../ai/contentRating';

// The `adultContent` rule, flipped per test without a world row.
const rules = vi.hoisted(() => ({ adult: false }));
vi.mock('../../worldRules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../worldRules')>()),
  isAdultContent: () => rules.adult,
}));

describe('conversation summary', () => {
  const people = ['Marco Rivera', 'Rosa Chen'];

  it('asks for one field per participant, labelling lines by first name', () => {
    const p = buildSummaryPrompt(people, [{ speaker: 'Marco Rivera', text: "I'm broke." }, { speaker: 'Rosa Chen', text: 'I can lend you ten.' }]);
    expect(p.system).toContain("Marco: I'm broke.");
    expect(p.format).toMatchObject({ required: people });
    expect(Object.keys((p.format as { properties: object }).properties)).toEqual(people);
  });

  it('reads takeaways, strips markdown, drops unusable ones', () => {
    const raw = JSON.stringify({ 'Marco Rivera': 'I admitted to **Rosa** that I am broke.', 'Rosa Chen': 'ok' });
    const out = parseSummary(raw, people)!;
    expect(out.get('Marco Rivera')).toBe('I admitted to Rosa that I am broke.');
    expect(out.has('Rosa Chen')).toBe(false);
  });

  it('returns null for garbage', () => {
    expect(parseSummary('no json here', people)).toBeNull();
    expect(parseSummary('{"Someone Else":"I did a thing today."}', people)).toBeNull();
  });
});

describe('maturity directive in the summary prompt', () => {
  const people = ['Marco Rivera', 'Rosa Chen'];
  const lines = [{ speaker: 'Marco Rivera', text: "I'm broke." }, { speaker: 'Rosa Chen', text: 'I can lend you ten.' }];
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it('is the chaste line with the rule off, once', () => {
    rules.adult = false;
    const { system } = buildSummaryPrompt(people, lines);
    expect(count(system, maturityDirective(false))).toBe(1);
    expect(system).not.toContain(maturityDirective(true));
  });

  it('is the adult line with the rule on, once', () => {
    rules.adult = true;
    const { system } = buildSummaryPrompt(people, lines, true);
    expect(count(system, maturityDirective(true))).toBe(1);
    expect(system).not.toContain(maturityDirective(false));
  });

  it('stays chaste with the rule on when anyone in the conversation is a minor, or the ages are unknown', () => {
    rules.adult = true;
    for (const { system } of [buildSummaryPrompt(people, lines, false), buildSummaryPrompt(people, lines)]) {
      expect(system).toContain(maturityDirective(false));
      expect(system).not.toContain(maturityDirective(true));
    }
  });
});

describe('conversation feelings (the pair judgement)', () => {
  const people = ['Marco Rivera', 'Rosa Chen'];
  const lines = [{ speaker: 'Marco Rivera', text: "I'm broke." }, { speaker: 'Rosa Chen', text: 'Then I cannot help you.' }];

  it('asks for feelings only when told to, and only of a pair', () => {
    const without = buildSummaryPrompt(people, lines);
    expect(without.system).not.toContain('"feelings"');
    expect((without.format as { properties: object }).properties).not.toHaveProperty('feelings');

    const withIt = buildSummaryPrompt(people, lines, false, true);
    expect(withIt.system).toContain('"feelings"');
    expect(withIt.format).toMatchObject({
      required: [...people, 'feelings'],
      properties: { feelings: { type: 'object', required: people, properties: { 'Marco Rivera': { type: 'integer', minimum: -3, maximum: 3 } } } },
    });

    const trio = buildSummaryPrompt([...people, 'Ivo Brandt'], lines, false, true);
    expect((trio.format as { properties: object }).properties).not.toHaveProperty('feelings');
  });

  it('reads both sides, and the takeaways still parse beside them', () => {
    const raw = JSON.stringify({
      'Marco Rivera': 'Rosa refused to lend me money and I felt small.',
      'Rosa Chen': 'Marco asked me for money again; I said no.',
      feelings: { 'Marco Rivera': -2, 'Rosa Chen': 0 },
    });
    expect([...parseFeelings(raw, people)]).toEqual([['Marco Rivera', -2], ['Rosa Chen', 0]]);
    expect(parseSummary(raw, people)!.get('Rosa Chen')).toBe('Marco asked me for money again; I said no.');
  });

  it('a reply without feelings still gives its takeaways, and no feelings', () => {
    const raw = JSON.stringify({ 'Marco Rivera': 'I admitted to Rosa that I am broke.', 'Rosa Chen': 'Marco is broke, poor man.' });
    expect(parseSummary(raw, people)!.size).toBe(2);
    expect(parseFeelings(raw, people).size).toBe(0);
  });

  it('clamps out-of-range values, rounds, and reads numeric strings', () => {
    const raw = JSON.stringify({ feelings: { 'Marco Rivera': -7, 'Rosa Chen': '+1.6' } });
    expect([...parseFeelings(raw, people)]).toEqual([['Marco Rivera', -3], ['Rosa Chen', 2]]);
  });

  it('drops bad values and bad shapes', () => {
    expect(parseFeelings(JSON.stringify({ feelings: { 'Marco Rivera': 'very hurt', 'Rosa Chen': null } }), people).size).toBe(0);
    expect(parseFeelings(JSON.stringify({ feelings: [1, -1] }), people).size).toBe(0);
    expect(parseFeelings(JSON.stringify({ feelings: 2 }), people).size).toBe(0);
    expect(parseFeelings('not json at all', people).size).toBe(0);
  });

  it('matches keys ignoring case, then by first name', () => {
    const raw = JSON.stringify({ feelings: { 'marco rivera': 1, Rosa: -1 } });
    expect([...parseFeelings(raw, people)]).toEqual([['Marco Rivera', 1], ['Rosa Chen', -1]]);
  });
});
