import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt, parseSummary } from '../conversationSummary';

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
