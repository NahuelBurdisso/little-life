import { describe, it, expect } from 'vitest';
import { asClause, endSentence, extractConfidedQuote, thatSentence } from '../factText';

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

  it('lowercases contracted generic openers too', () => {
    expect(thatSentence('Ray heard', "It's been a hard winter for Marco."))
      .toBe("Ray heard that it's been a hard winter for Marco.");
    expect(thatSentence('Ray heard', "There's talk of Marco leaving town"))
      .toBe("Ray heard that there's talk of Marco leaving town.");
  });

  it('quotes a question instead of stating it as fact', () => {
    expect(thatSentence('Ray overheard', 'Is Marco secretly broke?'))
      .toBe('Ray overheard: "Is Marco secretly broke?"');
    expect(thatSentence('Ana learned', '"Did Priya "borrow" the ledger?"'))
      .toBe('Ana learned: "Did Priya \'borrow\' the ledger?"');
  });

  it('collapses stray whitespace', () => {
    expect(asClause('  Marco\n  is   broke.  ')).toBe('Marco is broke');
  });
});

describe('extractConfidedQuote', () => {
  it('rejects a line that is only a stage direction', () => {
    // The playtest secret, as the model actually wrote it (unclosed, too).
    expect(extractConfidedQuote(
      '(My heart gives a little skip, and I feel a warmth bloom in my chest that rivals the sun',
    )).toBeNull();
    expect(extractConfidedQuote('(She looks away.) *sighs*')).toBeNull();
  });

  it('keeps the speech around stage directions', () => {
    expect(extractConfidedQuote('(looks down) I haven\'t slept since Rosa left me. *wipes eyes*'))
      .toBe('I haven\'t slept since Rosa left me.');
  });

  it('drops a trailing fragment the model never finished', () => {
    expect(extractConfidedQuote('I still write letters to her every night. And sometimes I think that'))
      .toBe('I still write letters to her every night.');
  });

  it('cuts at a sentence boundary, never mid-word', () => {
    const long = 'I lost the shop money at cards last week. ' + 'Nobody knows, not even my sister who keeps the books for me every single month without fail.';
    expect(extractConfidedQuote(long, 60)).toBe('I lost the shop money at cards last week.');
  });

  it('rejects filler that says nothing', () => {
    expect(extractConfidedQuote('Oh. Well. Thanks!')).toBeNull();
  });

  it('does not let inner double quotes break the fact template', () => {
    expect(extractConfidedQuote('"He said "never again" and I believed him."'))
      .toBe("He said 'never again' and I believed him.");
  });
});

describe('thatSentence with the lead\'s own people (G7)', () => {
  const yuki = { name: 'Yuki Tanaka', gender: 'female' };
  const diego = { name: 'Diego Santos', gender: 'male' };
  const marco = { name: 'Marco Rivera', gender: 'male' };
  const sighting = "Yuki Tanaka spotted Diego Santos at a secret meeting they weren't supposed to attend.";

  it('never names the teller or listener twice', () => {
    expect(thatSentence('Yuki Tanaka told Marco Rivera', sighting, [yuki, marco])).toBe(
      "Yuki Tanaka told Marco Rivera that she spotted Diego Santos at a secret meeting they weren't supposed to attend.",
    );
    expect(thatSentence('Diego Santos overheard', sighting, [diego])).toBe(
      "Diego Santos overheard that Yuki Tanaka spotted him at a secret meeting they weren't supposed to attend.",
    );
  });

  it('uses the possessive and a neutral pronoun when gender is unknown', () => {
    expect(thatSentence('Rosa Chen learned', "Lucia noticed discrepancies in Rosa Chen's shop ledger.", [{ name: 'Rosa Chen' }]))
      .toBe('Rosa Chen learned that Lucia noticed discrepancies in their shop ledger.');
  });

  it('leaves facts that do not name them alone', () => {
    expect(thatSentence('Marco Rivera told Priya Sharma', sighting, [marco, { name: 'Priya Sharma', gender: 'female' }]))
      .toBe("Marco Rivera told Priya Sharma that Yuki Tanaka spotted Diego Santos at a secret meeting they weren't supposed to attend.");
  });
});
