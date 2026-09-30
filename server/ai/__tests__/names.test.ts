import { describe, it, expect } from 'vitest';
import { addressName, firstName, nameVariants, withoutHonorific } from '../names';
import { sanitizeDialogue } from '../sanitizeDialogue';
import { buildConversationPrompt } from '../prompts';
import { pickConversationGist } from '../../lib/memory/conversationGist';

describe('names — honorifics', () => {
  it('skips a title when taking the first name', () => {
    expect(firstName('Dr. Sofia Petrov')).toBe('Sofia');
    expect(firstName('Mrs Rosa Delgado')).toBe('Rosa');
    expect(firstName('Prof. Rev. Alan Moss')).toBe('Alan');
    expect(firstName('Omar Haddad')).toBe('Omar');
    expect(firstName('Sir')).toBe('Sir');
    expect(withoutHonorific('Miss Yuki Tanaka')).toBe('Yuki Tanaka');
    expect(nameVariants('Dr. Sofia Petrov')).toEqual(['Dr. Sofia Petrov', 'Sofia Petrov', 'Sofia']);
  });

  it('addresses people the way the town does: first name, or title and surname', () => {
    expect(addressName('Priya Sharma')).toBe('Priya');
    expect(addressName('Dr. Sofia Petrov')).toBe('Dr. Petrov');
    expect(addressName('Mrs Rosa Delgado')).toBe('Mrs. Delgado');
    expect(addressName('Miss Yuki Tanaka')).toBe('Miss Tanaka');
    expect(addressName('Sir John Moss')).toBe('Sir John');
    expect(addressName('Omar')).toBe('Omar');
  });
});

describe('titled townsfolk in dialogue', () => {
  const town = ['Dr. Sofia Petrov', 'Carlos Mendez', 'Omar Haddad'];

  it('fills a placeholder with the first name, not the title', () => {
    expect(sanitizeDialogue('Thank you for asking, [Your Name].', {
      speakerName: 'Omar Haddad', listenerName: 'Dr. Sofia Petrov', townNames: town,
    })).toBe('Thank you for asking, Sofia.');
  });

  it('recognises a titled townsperson in a wrong vocative', () => {
    expect(sanitizeDialogue('Sofia, you look tired.', {
      speakerName: 'Omar Haddad', listenerName: 'Carlos Mendez', townNames: town,
    })).toBe('Carlos, you look tired.');
  });

  it("strips a titled speaker's own prefix and dialogue tag", () => {
    const opts = { speakerName: 'Dr. Sofia Petrov', listenerName: 'Omar Haddad', townNames: town };
    expect(sanitizeDialogue('Dr. Sofia Petrov: Take two of these.', opts)).toBe('Take two of these.');
    expect(sanitizeDialogue('Sofia: Take two of these.', opts)).toBe('Take two of these.');
    expect(sanitizeDialogue('Dr. Sofia Petrov sighs. "Take two of these."', opts)).toBe('Take two of these.');
  });

  it("labels a titled person's lines with their first name in the prompt", () => {
    const { messages } = buildConversationPrompt({
      speaker: { id: 1, name: 'Omar Haddad', bio: '', age: 40, gender: 'male', traits: [], personality: null },
      speakerNeeds: { mood: 50, energy: 50, hunger: 50, social: 50 },
      speakerEcon: { job: 'baker', job_title: 'Baker', money: 50 },
      conversation: { id: 1, messages: [{ speakerId: 2, text: 'Any pain?' }], trigger_reason: 't', topic: null, sentiment: 0, max_turns: 10 },
      relationship: null,
      otherAgent: { id: 2, name: 'Dr. Sofia Petrov', bio: '', age: 50, gender: 'female', traits: [], personality: null },
      memories: [],
      world: { time: { day: 1, hour: 10, minute: 0, totalTicks: 1, season: 'spring' }, weather: 'sunny' },
      location: { id: 1, name: 'Clinic', description: '' },
    });
    const transcript = messages.map((m) => m.content).join('\n');
    expect(transcript).toContain('Sofia: Any pain?');
    expect(transcript).not.toContain('Dr.:');
  });

  it("drops a titled speaker's prefix from an old line quoted in memory", () => {
    const gist = pickConversationGist(
      [{ speakerId: 2, text: 'Dr. Sofia Petrov: I lied to you about the money, and I am so sorry.', sentiment: -0.6 }],
      (id) => (id === 2 ? 'Dr. Sofia Petrov' : undefined),
    );
    expect(gist?.quote).toBe('I lied to you about the money, and I am so sorry.');
  });
});

describe('names — nobody rolls their own first name', () => {
  // Playtest #4: "Dr. has made up their mind to learn something new this season."
  // Thirteen modules took `name.split(' ')[0]`; they all go through firstName now.
  it('no server module takes the first word of a name by hand', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__' && entry !== 'node_modules') walk(full);
        } else if (full.endsWith('.ts') && !full.endsWith(join('ai', 'names.ts'))) {
          if (readFileSync(full, 'utf8').includes(".split(' ')[0]")) offenders.push(full);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
