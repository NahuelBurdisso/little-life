import { describe, it, expect } from 'vitest';
import { asClause, endSentence, thatSentence } from '../factText';

describe('fact text normalisation', () => {
  it('drops the trailing full stop so the fact can sit inside a sentence', () => {
    // The playtest line: "...overheard something about Yuki Tanaka and Thomas
    // Park were once together — and it ended badly.."
    expect(thatSentence('Ray overheard', 'Yuki Tanaka and Thomas Park were once together — and it ended badly.'))
      .toBe('Ray overheard that Yuki Tanaka and Thomas Park were once together — and it ended badly.');
  });

  it('adds a full stop to facts that never had one', () => {
    expect(thatSentence('Lucia learned', 'Diego Santos has a crush on Lucia Fernandez'))
      .toBe('Lucia learned that Diego Santos has a crush on Lucia Fernandez.');
  });

  it('keeps a closing quote balanced and does not punctuate after it', () => {
    expect(thatSentence('Ana discovered', 'Marco confided to Ana: "I can\'t pay rent."'))
      .toBe('Ana discovered that Marco confided to Ana: "I can\'t pay rent."');
  });

  it('keeps question and exclamation marks rather than stacking a period on them', () => {
    expect(endSentence('Did Marco really do it?')).toBe('Did Marco really do it?');
    expect(asClause('It ended badly!!  ')).toBe('it ended badly');
  });

  it('lowercases generic openers but never a name', () => {
    expect(thatSentence('The whole town now knows', 'There are rumors going around about Priya'))
      .toBe('The whole town now knows that there are rumors going around about Priya.');
    expect(asClause('Marco Rivera is broke.')).toBe('Marco Rivera is broke');
  });

  it('collapses stray whitespace', () => {
    expect(asClause('  Marco\n  is   broke.  ')).toBe('Marco is broke');
  });
});
