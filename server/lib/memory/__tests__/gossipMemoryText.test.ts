import { describe, it, expect, afterEach, vi } from 'vitest';
import { describeEvent } from '../descriptionTemplates';

/**
 * Gossip memories spliced the fact raw: "I told Ana about Yuki Tanaka and
 * Thomas Park were once together — and it ended badly.." — ungrammatical, and
 * the agent's LLM reads these memories back verbatim.
 */

const FACT = 'Yuki Tanaka and Thomas Park were once together — and it ended badly.';

/** Every variant of a template key, by pinning the random pick. */
function allVariants(key: string, ctx: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const r of [0, 0.49, 0.51, 0.99]) {
    vi.spyOn(Math, 'random').mockReturnValue(r);
    out.add(describeEvent(key, ctx));
  }
  return [...out];
}

describe('gossip memory templates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('learned: one "that" clause, one full stop', () => {
    const lines = allVariants('gossip_learned', { source: 'Ray', content: FACT });
    expect(lines).toEqual(expect.arrayContaining([
      'Ray told me that Yuki Tanaka and Thomas Park were once together — and it ended badly.',
      'I heard from Ray that Yuki Tanaka and Thomas Park were once together — and it ended badly.',
    ]));
    for (const line of lines) expect(line).not.toMatch(/\.\.$/);
  });

  it('letter: reads as a letter arriving, one "that" clause, one full stop', () => {
    const lines = allVariants('gossip_letter', { source: 'an unsigned letter', content: FACT });
    expect(lines).toEqual(expect.arrayContaining([
      'An unsigned letter came for me, and it said that Yuki Tanaka and Thomas Park were once together — and it ended badly.',
      'I found an unsigned letter saying that Yuki Tanaka and Thomas Park were once together — and it ended badly.',
    ]));
    for (const line of lines) {
      expect(line).not.toMatch(/\.\.$/);
      expect(line).not.toContain('told me');
    }
  });

  it('shared: no "about <clause>" and no doubled period', () => {
    const lines = allVariants('gossip_shared', { other: 'Ana', content: FACT });
    expect(lines).toEqual(expect.arrayContaining([
      'I told Ana that Yuki Tanaka and Thomas Park were once together — and it ended badly.',
      'I shared with Ana that Yuki Tanaka and Thomas Park were once together — and it ended badly.',
    ]));
    for (const line of lines) {
      expect(line).not.toMatch(/\.\.$/);
      expect(line).not.toContain(' about Yuki');
    }
  });
});
