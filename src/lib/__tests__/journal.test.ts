import { describe, it, expect } from 'vitest';
import {
  JOURNAL_TABS, badgeText, journalUnread, stepTab, tabBadges, tabForDigit,
} from '../journal';

describe('journal tabs', () => {
  it('has the seven tabs in strip order', () => {
    expect(JOURNAL_TABS.map((t) => t.key)).toEqual(['brewing', 'stories', 'timeline', 'paper', 'inbox', 'talks', 'challenges']);
  });

  it('steps with the arrows and wraps at both ends', () => {
    expect(stepTab('brewing', 1)).toBe('stories');
    expect(stepTab('talks', 1)).toBe('challenges');
    expect(stepTab('challenges', 1)).toBe('brewing');
    expect(stepTab('brewing', -1)).toBe('challenges');
    expect(stepTab('paper', -1)).toBe('timeline');
  });

  it('picks a tab by digit, 1-based, and ignores anything else', () => {
    expect(tabForDigit('1')).toBe('brewing');
    expect(tabForDigit('4')).toBe('paper');
    expect(tabForDigit('6')).toBe('talks');
    expect(tabForDigit('7')).toBe('challenges');
    expect(tabForDigit('8')).toBeNull();
    expect(tabForDigit('0')).toBeNull();
    expect(tabForDigit('a')).toBeNull();
    expect(tabForDigit('12')).toBeNull();
  });
});

describe('journal badges', () => {
  it('puts each signal on its own tab', () => {
    expect(tabBadges({ unreadAlerts: 3, hasNewPaper: true, hotBrewing: 2 })).toEqual({
      brewing: 2, stories: null, timeline: null, paper: 'new', inbox: 3, talks: null, challenges: null,
    });
    expect(tabBadges({ unreadAlerts: 0, hasNewPaper: false, hotBrewing: 0 })).toEqual({
      brewing: null, stories: null, timeline: null, paper: null, inbox: null, talks: null, challenges: null,
    });
  });

  it('sums unread alerts and a new paper for the TopBar button, not brewing heat', () => {
    expect(journalUnread({ unreadAlerts: 0, hasNewPaper: false })).toBe(0);
    expect(journalUnread({ unreadAlerts: 0, hasNewPaper: true })).toBe(1);
    expect(journalUnread({ unreadAlerts: 4, hasNewPaper: true })).toBe(5);
    expect(journalUnread({ unreadAlerts: -2, hasNewPaper: false })).toBe(0);
  });

  it('caps the badge text at 9+', () => {
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
  });
});
