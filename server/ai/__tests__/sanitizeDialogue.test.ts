import { describe, it, expect } from 'vitest';
import { sanitizeDialogue, isFallbackMessage, fallbackReply, type DialogueSanitizeOptions } from '../sanitizeDialogue';

// Fixtures are real (or minimally completed) lines from a 104-line playtest
// transcript; see the header of sanitizeDialogue.ts for the failure tally.

const TOWN = [
  'Omar Haddad', 'Sofia Reyes', 'Elena Petrova', 'Carlos Mendez', 'Lucia Romano',
  'Rosa Delgado', 'Diego Alvarez', 'Marco Bianchi', 'Thomas Wright', 'Yuki Tanaka',
];

function clean(raw: string, opts: Partial<DialogueSanitizeOptions> = {}): string {
  return sanitizeDialogue(raw, {
    speakerName: 'Omar Haddad',
    listenerName: 'Sofia Reyes',
    townNames: TOWN,
    ...opts,
  });
}

describe('sanitizeDialogue — stage directions', () => {
  it('strips a second-person parenthetical direction', () => {
    expect(clean("(You shift slightly, avoiding direct eye contact with Omar…) I'm fine, really. Just tired."))
      .toBe("I'm fine, really. Just tired.");
  });

  it('strips a markdown-wrapped parenthetical', () => {
    expect(clean("*(Marco leans in, lowering his voice)* You didn't hear this from me.", { speakerName: 'Marco Bianchi' }))
      .toBe("You didn't hear this from me.");
  });

  it('strips an asterisk gesture but keeps one-word emphasis', () => {
    expect(clean('*sighs* Fine. I *really* mean it this time.')).toBe('Fine. I really mean it this time.');
  });

  it('strips bracketed directions and a direction the token cap left unclosed', () => {
    expect(clean('[smiling warmly] It is good to see you. (She reaches for')).toBe('It is good to see you.');
  });

  it('handles a long run of unclosed openers in linear time', () => {
    const started = performance.now();
    expect(clean(`Fine. ${'('.repeat(50_000)}x`)).toBe('Fine.');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('returns empty when the reply was nothing but a direction', () => {
    expect(clean('(Omar smiles and nods.)')).toBe('');
    expect(clean('*shrugs*')).toBe('');
  });
});

describe('sanitizeDialogue — quotes and narration', () => {
  it('strips wrapping quotes', () => {
    expect(clean('"I haven\'t seen you at the market lately."')).toBe("I haven't seen you at the market lately.");
    expect(clean('“Curly quotes, too.”')).toBe('Curly quotes, too.');
  });

  it('keeps only the quoted speech when the speaker narrates themself', () => {
    expect(clean('I murmur, leaning in slightly, "Do you ever wonder what they\'re hiding?"'))
      .toBe("Do you ever wonder what they're hiding?");
    expect(clean('"Hmm, interesting," Omar said.')).toBe('Hmm, interesting.');
    expect(clean('Omar grins. "Fancy meeting you here." "Coffee?"')).toBe('Fancy meeting you here. Coffee?');
    expect(clean('"Maybe," I say, tapping the table. "Maybe not."')).toBe('Maybe, Maybe not.');
    expect(clean('Omar Haddad leans closer. "Not here."')).toBe('Not here.');
  });

  it('leaves reported speech and quotes inside a full clause alone', () => {
    for (const line of [
      'She told me "never again" and then she walked out on the whole town.',
      'She whispered "I never loved him" and I believed her.',
      'I heard Diego say "the money is gone" at the tavern.',
      'Diego said "stay away" so I did.',
      'I said "no" and walked away.',
      'He called it "the best pie in the whole town" and I laughed.',
      // A third-person "He" can't be told apart from reported speech: left alone.
      'Omar grins. "Fancy meeting you here." He taps the counter. "Coffee?"',
    ]) {
      expect(clean(line)).toBe(line);
    }
  });

  it('strips a leading speaker-name prefix', () => {
    expect(clean('Omar: Not now, I have work to do.')).toBe('Not now, I have work to do.');
    expect(clean('Omar Haddad: "Not now."')).toBe('Not now.');
  });
});

describe('sanitizeDialogue — noise', () => {
  it('removes emoji', () => {
    expect(clean('You look great today 😉✨')).toBe('You look great today');
    expect(clean("That's the spirit! 🔥🔥")).toBe("That's the spirit!");
    expect(clean('Nice work 👍🏽 really.')).toBe('Nice work really.');
  });

  it('collapses newlines and whitespace', () => {
    expect(clean('Well...\n\nI suppose so.\n  Maybe tomorrow.')).toBe('Well... I suppose so. Maybe tomorrow.');
  });

  it('leaves clean dialogue untouched', () => {
    const line = "Can't complain. The bakery's been busy since the festival, and I'm exhausted.";
    expect(clean(line)).toBe(line);
  });
});

describe('sanitizeDialogue — names', () => {
  it('replaces a [Your Name] placeholder with the listener (conversation #2442)', () => {
    expect(clean("I'm doing alright, thank you for asking, [Your Name]."))
      .toBe("I'm doing alright, thank you for asking, Sofia.");
    expect(clean('thank you for asking, [Your Name]')).toBe('Thank you for asking, Sofia');
    expect(clean('Hello {name}, and {{name}}!')).toBe('Hello Sofia, and Sofia!');
    expect(clean("I'm [My Name], by the way.")).toBe("I'm Omar, by the way.");
  });

  it('collapses a self-corrected wrong name', () => {
    expect(clean('Morning, Elena... wait, Carlos. Sleep well?', { listenerName: 'Carlos Mendez' }))
      .toBe('Morning, Carlos. Sleep well?');
  });

  it('fixes a wrong opening vocative addressed to the listener', () => {
    expect(clean('Oh, Diego, you seem deep in thought.', { speakerName: 'Lucia Romano', listenerName: 'Rosa Delgado' }))
      .toBe('Oh, Rosa, you seem deep in thought.');
    expect(clean('Morning, Elena... you look tired.', { listenerName: 'Carlos Mendez' })).toBe('Morning, Carlos... you look tired.');
    expect(clean('Marco, you look tired.')).toBe('Sofia, you look tired.');
    expect(clean("Marco! You're late again.")).toBe("Sofia! You're late again.");
  });

  it('never touches names mentioned as third parties or appositives', () => {
    for (const line of [
      'I saw Diego at the tavern last night.',
      'Diego? He left an hour ago.',
      "Diego, he's been acting strange lately.",
      'Diego, Rosa and I went fishing.',
      'Yes, Diego. He came by yesterday.',
      'Ask Diego about it.',
      'Oh, Sofia, you remembered!',
      'I ran into your ex, Diego.',
      'Say hello to my friend, Marco.',
      'Diego, of all people, told me.',
      'Marco, the baker, said so.',
      'Good to see you, Diego! How was the trip?',
      // No second-person cue: may be about Elena, not to her.
      'Morning, Elena. Sleep well?',
    ]) {
      expect(clean(line)).toBe(line);
    }
  });

  it('never "corrects" names that are also ordinary words', () => {
    const town = [...TOWN, 'Will Turner', 'Hope Adams', 'May Chen', 'Grace Kim'];
    for (const line of ['Will, you coming or not?', 'Hope, you are late.', 'May, you look well.', 'Grace, your cake was lovely.']) {
      expect(clean(line, { townNames: town })).toBe(line);
    }
  });

  it('only corrects names of actual townsfolk', () => {
    expect(clean('Oh, Bob, you seem tired.')).toBe('Oh, Bob, you seem tired.');
  });
});

describe('sanitizeDialogue — truncation', () => {
  it('drops an unfinished trailing sentence when the token cap hit', () => {
    expect(clean('Every old house has a secret. There is always a story just beneath the surface of', { truncated: true }))
      .toBe('Every old house has a secret.');
  });

  it('keeps a lone unfinished sentence, marked as trailing off', () => {
    expect(clean('There is always a story just beneath the surface of', { truncated: true }))
      .toBe('There is always a story just beneath the surface of…');
  });

  it('does not treat an abbreviation as a sentence end', () => {
    expect(clean('I spoke with Mr. Wright about the', { truncated: true })).toBe('I spoke with Mr. Wright about the…');
  });

  it('keeps a complete reply even when flagged', () => {
    expect(clean('That is all I wanted to say.', { truncated: true })).toBe('That is all I wanted to say.');
  });

  it('leaves an unpunctuated reply alone when it was not cut off', () => {
    expect(clean('See you around then')).toBe('See you around then');
  });

  it('recovers a complete sentence after stripping a cut-off direction', () => {
    expect(clean('Sure, I can help. (He glances toward the door, clearly', { truncated: true }))
      .toBe('Sure, I can help.');
  });
});

describe('isFallbackMessage', () => {
  it('trusts the stored flag whenever it is present', () => {
    expect(isFallbackMessage({ text: 'Omar Haddad shrugged.', fallback: false }, 'Omar Haddad')).toBe(false);
    expect(isFallbackMessage({ text: 'Anything at all.', fallback: true })).toBe(true);
  });

  it("matches a legacy line only as the exact canned shape with its speaker's name", () => {
    for (let i = 0; i < 20; i++) {
      expect(isFallbackMessage({ text: fallbackReply('Omar Haddad') }, 'Omar Haddad')).toBe(true);
    }
    expect(isFallbackMessage({ text: '"Hmm, interesting," Omar Haddad said.' }, 'Omar Haddad')).toBe(true);
  });

  it('never flags real speech that merely resembles a fallback', () => {
    for (const text of ['He shrugged.', 'Diego paused thoughtfully.', 'Diego Alvarez shrugged.', 'She smiled and nodded.']) {
      expect(isFallbackMessage({ text }, 'Omar Haddad')).toBe(false);
    }
    // Without the speaker's name a legacy line is treated as speech.
    expect(isFallbackMessage({ text: 'Omar Haddad shrugged.' })).toBe(false);
  });
});

describe('sanitizeDialogue — leading hesitation', () => {
  const opts = { speakerName: 'Elena Voss', listenerName: 'James O\'Brien', townNames: [] };
  it('drops an ellipsis before a full sentence but keeps a continuation', () => {
    expect(sanitizeDialogue('... Not today, James.', opts)).toBe('Not today, James.');
    expect(sanitizeDialogue('…I will manage.', opts)).toBe('I will manage.');
    expect(sanitizeDialogue('...and then he left.', opts)).toBe('...and then he left.');
  });
});

describe('sanitizeDialogue — listener full name', () => {
  it('addresses the listener by first name', () => {
    const opts = { speakerName: 'Rosa Chen', listenerName: 'Yuki Tanaka', townNames: [] };
    expect(sanitizeDialogue('I will count the minutes, Yuki Tanaka.', opts)).toBe('I will count the minutes, Yuki.');
    expect(sanitizeDialogue("Is that Yuki Tanaka's scarf?", opts)).toBe("Is that Yuki's scarf?");
  });

  it('uses title and surname for a titled listener', () => {
    const opts = { speakerName: 'Omar Hassan', listenerName: 'Dr. Sofia Petrov', townNames: [] };
    expect(sanitizeDialogue('See you at the clinic, Dr. Sofia Petrov.', opts)).toBe('See you at the clinic, Dr. Petrov.');
  });
});
