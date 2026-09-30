import { describe, it, expect, vi } from 'vitest';
import { buildSummaryPrompt, parseSummary } from '../conversationSummary';
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
    const { system } = buildSummaryPrompt(people, lines);
    expect(count(system, maturityDirective(true))).toBe(1);
    expect(system).not.toContain(maturityDirective(false));
  });
});
