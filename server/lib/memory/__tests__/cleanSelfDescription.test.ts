import { describe, it, expect } from 'vitest';
import { cleanSelfDescription } from '../SelfDescriptionGenerator';

describe('cleanSelfDescription', () => {
  it('drops a preamble line, markdown and a cut-off tail', () => {
    expect(cleanSelfDescription('Here is a summary:\n**Marco** loves *people*. He worries about Carlos and the', 'Marco Rivera'))
      .toBe('Marco loves people.');
  });

  it('unwraps quotes and keeps complete text', () => {
    expect(cleanSelfDescription('"Rosa runs the store. She misses her sister."', 'Rosa Chen'))
      .toBe('Rosa runs the store. She misses her sister.');
  });

  it('keeps a first line that is already about the person', () => {
    expect(cleanSelfDescription('Based on everything, Omar is tired.\nHe wants a new job.', 'Omar Hassan'))
      .toBe('Based on everything, Omar is tired. He wants a new job.');
  });
});
