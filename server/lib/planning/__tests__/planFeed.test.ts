import { describe, it, expect } from 'vitest';
import { describeStateTrigger, conversationReplanSignal } from '../PlanEventAdapter';
import { joinForFeed, shortenForFeed } from '../../factText';
import { ACTIVITY_REGISTRY } from '../../../data/activityRegistry';

/**
 * Playtest feed noise: plan summaries of 250+ characters, and replan reasons
 * leaking internal labels ("started feeling drunk: cascade:goal_failure_drinking").
 */

describe('describeStateTrigger', () => {
  it('drops internal cause labels', () => {
    expect(describeStateTrigger('drunk', 'cascade:goal_failure_drinking')).toBe('started feeling drunk');
    expect(describeStateTrigger('drunk', 'action:drinking')).toBe('started feeling drunk');
    expect(describeStateTrigger('in_debt', 'broke_3_days')).toBe('started feeling in debt');
    expect(describeStateTrigger('angry', 'bad_conversation')).toBe('started feeling angry');
    expect(describeStateTrigger('alcoholic', 'relapse')).toBe('started feeling alcoholic');
  });

  it('keeps causes written as prose', () => {
    expect(describeStateTrigger('relieved', 'exposed blackmail secret publicly'))
      .toBe('started feeling relieved: exposed blackmail secret publicly');
  });

  it('works without a cause', () => {
    expect(describeStateTrigger('sick')).toBe('started feeling sick');
  });
});

describe('feed-sized plan text', () => {
  const blocks = [
    'Open the bakery and knead the morning dough',
    'Deliver bread to the tavern',
    'Lunch with Carlos by the river',
    'Balance the shop ledger',
    'Walk past Lucia\'s house hoping to run into her',
    'Early night',
  ];

  it('lists whole plan items up to the limit and counts the rest', () => {
    expect(joinForFeed(blocks)).toBe('Open the bakery and knead the morning dough, Deliver bread to the tavern, +4 more');
  });

  it('fills the registry template without "…." or ", …" artifacts', () => {
    const fill = (template: string, data: Record<string, string>) =>
      template.replace(/\{(\w+)\}/g, (_, k: string) => data[k] ?? '');
    const reason = shortenForFeed(
      'had a conversation with Marco Rivera about the harvest festival preparations and the missing flour sacks', 80,
    ).replace(/\.$/, '');
    const line = fill(ACTIVITY_REGISTRY.plan_changed.template, {
      agentName: 'Rosa', reason, summary: joinForFeed(blocks),
    });
    expect(line).not.toMatch(/…\./);
    expect(line).not.toMatch(/, …/);
    expect(line).toMatch(/^Rosa changed plans \(had a conversation with .+…\)\. Now: Open the bakery/);
  });

  it('shows a short plan in full', () => {
    expect(joinForFeed(['Sleep in.', 'Fish'])).toBe('Sleep in, Fish');
  });

  it('keeps only the first sentence of a long reason', () => {
    expect(shortenForFeed('had a fight with Marco. Then went home and cried for hours about it all.'))
      .toBe('had a fight with Marco.');
  });

  it('cuts an over-long sentence at a word boundary', () => {
    const reason = 'had a conversation with Marco Rivera about the harvest festival preparations and the missing flour sacks';
    const short = shortenForFeed(reason, 80);
    expect(short.endsWith('…')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(81);
    // Every word before the ellipsis is a whole word of the original.
    const words = short.slice(0, -1).split(' ');
    expect(reason.split(' ').slice(0, words.length)).toEqual(words);
  });
});

describe('conversationReplanSignal', () => {
  it('treats only a clearly bad talk as dramatic', () => {
    expect(conversationReplanSignal(-0.7)).toEqual({ sentiment: -0.7, isDramatic: true });
    expect(conversationReplanSignal(0.8)).toEqual({ sentiment: 0.4, isDramatic: false });
    expect(conversationReplanSignal(0)).toEqual({ sentiment: 0, isDramatic: false });
  });
});
