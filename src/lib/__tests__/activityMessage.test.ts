import { describe, it, expect } from 'vitest';
import { renderMessage } from '../activityMessage';

describe('renderMessage: plan_changed', () => {
  const row = (reason: string) => ({
    type: 'plan_changed',
    timestamp: 0,
    template_data: { agentName: 'Rosa Chen', reason, summary: 'x' },
  });

  it('does not stack a period on a reason that already ends a sentence', () => {
    expect(renderMessage(row('had a fight with Marco.'))).toBe('Rosa Chen changed plans: had a fight with Marco.');
    expect(renderMessage(row('had a conversation with Marco about the harvest…')))
      .toBe('Rosa Chen changed plans: had a conversation with Marco about the harvest…');
  });

  it('never cuts an old, over-long reason mid-word', () => {
    const msg = renderMessage(row(
      'had a conversation with Marco Rivera about the harvest festival preparations and the missing flour sacks',
    ));
    expect(msg).toMatch(/ [a-z]+…$/);
    expect(msg).not.toMatch(/\.$/);
  });
});
