/**
 * The Town Journal's tabs and badges (src/components/ui/Journal.tsx).
 *
 * Every story surface used to be its own button: the feed's Stories and Brewing
 * tabs, the Timeline and History modals, the Inbox popover, the Paper. They are
 * tabs of one drawer now, opened with J or deep-linked (`openJournal('paper')`).
 * Pure so the keyboard stepping and the badge sums are tested on their own.
 */

export type JournalTab = 'brewing' | 'stories' | 'timeline' | 'paper' | 'inbox' | 'talks';

export interface JournalTabDef {
  key: JournalTab;
  icon: string;
  label: string;
  /** Tooltip: what the tab is for. */
  hint: string;
}

/** In strip order; 1–6 pick them by position while the Journal is open. */
export const JOURNAL_TABS: readonly JournalTabDef[] = [
  { key: 'brewing', icon: '🔥', label: 'Brewing', hint: 'What is about to boil over' },
  { key: 'stories', icon: '📖', label: 'Stories', hint: 'The town\'s running story arcs' },
  { key: 'timeline', icon: '🕰', label: 'Timeline', hint: 'What happened, day by day' },
  { key: 'paper', icon: '📰', label: 'Paper', hint: 'The Town Crier, one edition a day' },
  { key: 'inbox', icon: '🔔', label: 'Inbox', hint: 'Every alert, including what your nudges came to' },
  { key: 'talks', icon: '💬', label: 'Talks', hint: 'Every finished conversation, searchable' },
];

export function isJournalTab(v: unknown): v is JournalTab {
  return typeof v === 'string' && JOURNAL_TABS.some((t) => t.key === v);
}

/** The tab `step` places along the strip, wrapping at both ends (← / →). */
export function stepTab(current: JournalTab, step: 1 | -1): JournalTab {
  const i = JOURNAL_TABS.findIndex((t) => t.key === current);
  const n = JOURNAL_TABS.length;
  return JOURNAL_TABS[(((i < 0 ? 0 : i) + step) % n + n) % n].key;
}

/** The tab a digit key picks ("1" = first), or null for any other key. */
export function tabForDigit(key: string): JournalTab | null {
  if (!/^[1-9]$/.test(key)) return null;
  return JOURNAL_TABS[Number(key) - 1]?.key ?? null;
}

export interface JournalSignals {
  /** Alerts not yet seen in the Inbox tab (useDramaAlerts). */
  unreadAlerts: number;
  /** A Town Crier edition the player hasn't opened (useGazette). */
  hasNewPaper: boolean;
  /** Brewing rows close to the boil (heat ≥ HOT_BREWING). */
  hotBrewing: number;
}

/** Heat from which a Brewing row counts as "about to go" for the badges. */
export const HOT_BREWING = 0.7;

/** A tab's badge: a count, the word "new", or nothing. */
export type TabBadge = number | 'new' | null;

export function tabBadges(s: JournalSignals): Record<JournalTab, TabBadge> {
  return {
    brewing: s.hotBrewing > 0 ? s.hotBrewing : null,
    stories: null,
    timeline: null,
    paper: s.hasNewPaper ? 'new' : null,
    inbox: s.unreadAlerts > 0 ? s.unreadAlerts : null,
    talks: null,
  };
}

/**
 * The one badge on the TopBar's Journal button: unread alerts plus one for a
 * new paper. Brewing heat is left out on purpose — it is a live gauge, not
 * something to "read", and the feed's 🔥 chip already shows it.
 */
export function journalUnread(s: Pick<JournalSignals, 'unreadAlerts' | 'hasNewPaper'>): number {
  return Math.max(0, s.unreadAlerts) + (s.hasNewPaper ? 1 : 0);
}

/** "9+" past nine, like the old inbox bell. */
export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(n);
}
