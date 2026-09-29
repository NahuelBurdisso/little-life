import { describe, it, expect } from 'vitest';
import { parseQuestions, parseInsights } from '../reflectionParser';

describe('parseQuestions', () => {
  it('returns empty array for empty input', () => {
    expect(parseQuestions('')).toEqual([]);
    expect(parseQuestions('   ')).toEqual([]);
    expect(parseQuestions('\n\n\n')).toEqual([]);
  });

  it('parses plain numbered lines', () => {
    const raw = '1. What motivates Alice?\n2. Why does she avoid Bob?\n3. What is her goal?';
    expect(parseQuestions(raw)).toEqual([
      'What motivates Alice?',
      'Why does she avoid Bob?',
      'What is her goal?',
    ]);
  });

  it('strips dot-number prefixes like "1." and "2."', () => {
    const raw = '1. First question\n2. Second question';
    const result = parseQuestions(raw);
    expect(result[0]).toBe('First question');
    expect(result[1]).toBe('Second question');
  });

  it('strips paren-number prefixes like "1)" and "2)"', () => {
    const raw = '1) First question\n2) Second question';
    const result = parseQuestions(raw);
    expect(result[0]).toBe('First question');
    expect(result[1]).toBe('Second question');
  });

  it('strips bullet points (-, •, *)', () => {
    const raw = '- What does Alice want?\n• Why is she sad?\n* Where does she go?';
    expect(parseQuestions(raw)).toEqual([
      'What does Alice want?',
      'Why is she sad?',
      'Where does she go?',
    ]);
  });

  it('strips preamble lines starting with "here are"', () => {
    const raw = 'Here are my questions:\n1. What drives Alice?\n2. Why did Bob leave?';
    const result = parseQuestions(raw);
    expect(result).not.toContain('Here are my questions:');
    expect(result[0]).toBe('What drives Alice?');
  });

  it('strips preamble lines starting with "based on"', () => {
    const raw = 'Based on the above:\n1. What is her goal?\n2. Who does she trust?';
    const result = parseQuestions(raw);
    expect(result[0]).toBe('What is her goal?');
  });

  it('strips preamble lines starting with "from the"', () => {
    const raw = 'From the memories provided:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('strips preamble lines starting with "given"', () => {
    const raw = 'Given the context:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('strips preamble lines starting with "considering"', () => {
    const raw = 'Considering the events:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('strips preamble lines starting with "looking at"', () => {
    const raw = 'Looking at Alice\'s memories:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('strips preamble lines starting with "reflecting on"', () => {
    const raw = 'Reflecting on her experiences:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('strips preamble lines starting with "my questions"', () => {
    const raw = 'My questions for Alice:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('strips preamble lines starting with "my insights"', () => {
    const raw = 'My insights are:\n1. Insight one\n2. Insight two';
    expect(parseQuestions(raw)[0]).toBe('Insight one');
  });

  it('strips preamble lines starting with "the following"', () => {
    const raw = 'The following questions arise:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('strips preamble lines starting with "these are"', () => {
    const raw = 'These are the key questions:\n1. Question one?\n2. Question two?';
    expect(parseQuestions(raw)[0]).toBe('Question one?');
  });

  it('returns only first 3 when more than 3 lines', () => {
    const raw = '1. Q one\n2. Q two\n3. Q three\n4. Q four\n5. Q five';
    const result = parseQuestions(raw);
    expect(result).toHaveLength(3);
    expect(result).toEqual(['Q one', 'Q two', 'Q three']);
  });

  it('returns fewer than 3 when fewer non-empty lines provided', () => {
    const raw = '1. Only question';
    expect(parseQuestions(raw)).toEqual(['Only question']);
  });

  it('handles plain lines without numbering', () => {
    const raw = 'What does Alice want?\nWhy is she avoiding Bob?';
    expect(parseQuestions(raw)).toEqual([
      'What does Alice want?',
      'Why is she avoiding Bob?',
    ]);
  });

  it('filters blank lines between entries', () => {
    const raw = '1. First question\n\n2. Second question\n\n3. Third question';
    expect(parseQuestions(raw)).toHaveLength(3);
  });

  it('is case-insensitive for preamble matching', () => {
    const raw = 'HERE ARE some questions:\n1. Q one\n2. Q two';
    expect(parseQuestions(raw)[0]).toBe('Q one');
  });
});

describe('parseInsights', () => {
  it('returns empty array for empty input', () => {
    expect(parseInsights('')).toEqual([]);
    expect(parseInsights('   ')).toEqual([]);
    expect(parseInsights('\n\n')).toEqual([]);
  });

  it('parses citations in format "(because of 1, 5, 12)"', () => {
    const raw = 'Alice is lonely (because of 1, 5, 12)';
    const result = parseInsights(raw);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Alice is lonely');
    expect(result[0].citations).toEqual([1, 5, 12]);
  });

  it('parses citations in format "(1, 5, 12)" at end of line', () => {
    const raw = 'Bob distrusts strangers (1, 5, 12)';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Bob distrusts strangers');
    expect(result[0].citations).toEqual([1, 5, 12]);
  });

  it('parses citations in format "[1, 5, 12]" at end of line', () => {
    const raw = 'Clara values loyalty [1, 5, 12]';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Clara values loyalty');
    expect(result[0].citations).toEqual([1, 5, 12]);
  });

  it('parses citations in format "based on memories 1, 5, 12"', () => {
    const raw = 'Dave is ambitious based on memories 1, 5, 12';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Dave is ambitious');
    expect(result[0].citations).toEqual([1, 5, 12]);
  });

  it('"based on memories" matching is case insensitive', () => {
    const raw = 'Eve is cautious BASED ON MEMORIES 2, 7';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Eve is cautious');
    expect(result[0].citations).toEqual([2, 7]);
  });

  it('returns empty citations array when no pattern matches', () => {
    const raw = 'Frank enjoys solitude';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Frank enjoys solitude');
    expect(result[0].citations).toEqual([]);
  });

  it('strips preamble lines before parsing insights', () => {
    const raw = 'Here are my insights:\n1. Alice is lonely (because of 1, 3)\n2. Bob is angry (2, 4)';
    const result = parseInsights(raw);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Alice is lonely');
    expect(result[0].citations).toEqual([1, 3]);
  });

  it('strips numbered prefixes from insight lines', () => {
    const raw = '1. Alice is lonely (because of 1, 5)\n2. Bob distrusts (2, 6)';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Alice is lonely');
    expect(result[1].text).toBe('Bob distrusts');
  });

  it('strips bullet prefixes from insight lines', () => {
    const raw = '- Alice is lonely (1, 5)\n• Bob is sad [2, 6]';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Alice is lonely');
    expect(result[1].text).toBe('Bob is sad');
  });

  it('drops entries where cleaned text is shorter than 5 chars', () => {
    const raw = 'OK (1, 2)\nAlice is thoughtful (3, 4)';
    const result = parseInsights(raw);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Alice is thoughtful');
  });

  it('handles a single citation number', () => {
    const raw = 'Alice misses home (because of 7)';
    const result = parseInsights(raw);
    expect(result[0].citations).toEqual([7]);
  });

  it('handles mixed citation formats across multiple lines', () => {
    const raw = [
      'Alice is lonely (because of 1, 2)',
      'Bob distrusts people (3, 4)',
      'Clara values loyalty [5, 6]',
      'Dave is ambitious based on memories 7, 8',
      'Eve has no citations',
    ].join('\n');
    const result = parseInsights(raw);
    expect(result).toHaveLength(5);
    expect(result[0].citations).toEqual([1, 2]);
    expect(result[1].citations).toEqual([3, 4]);
    expect(result[2].citations).toEqual([5, 6]);
    expect(result[3].citations).toEqual([7, 8]);
    expect(result[4].citations).toEqual([]);
  });

  it('"because of" pattern takes priority over plain paren pattern', () => {
    // "(because of 1, 2)" should match pattern 1, not pattern 2
    const raw = 'Alice is sad (because of 1, 2)';
    const result = parseInsights(raw);
    expect(result[0].citations).toEqual([1, 2]);
    expect(result[0].text).toBe('Alice is sad');
  });

  it('trims whitespace from extracted text', () => {
    const raw = '  Alice is lonely (1, 5)  ';
    const result = parseInsights(raw);
    expect(result[0].text).toBe('Alice is lonely');
  });

  it('handles multiple lines with some being fragments', () => {
    const raw = 'Hi (1)\nAlice loves the town (2, 3)\nBye [4]';
    const result = parseInsights(raw);
    // "Hi" has 2 chars < 5, "Bye" has 3 chars < 5
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Alice loves the town');
  });
});

describe('structured (JSON) replies', () => {
  it('reads three questions and strips markdown', () => {
    const raw = JSON.stringify({ questions: ['Why does **Marco** avoid me?', 'Is the bakery worth it?', 'Should I call Rosa?'] });
    expect(parseQuestions(raw)).toEqual(['Why does Marco avoid me?', 'Is the bakery worth it?', 'Should I call Rosa?']);
  });

  it('reads insights with their citations, deduplicated', () => {
    const raw = JSON.stringify({ insights: [
      { insight: 'I trust *Rosa* more than I admit.', because: [2, 5, 2] },
      { insight: 'ok', because: [1] },
    ] });
    expect(parseInsights(raw)).toEqual([{ text: 'I trust Rosa more than I admit.', citations: [2, 5] }]);
  });
});

describe('structured insights — inline citations', () => {
  it('drops citation numbers repeated at the end of the sentence', () => {
    const raw = JSON.stringify({ insights: [{ insight: 'I feel lost in my own head (11, 13).', because: [11, 13] }] });
    expect(parseInsights(raw)[0].text).toBe('I feel lost in my own head.');
  });
});
