import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  INBOX_MAX,
  inboxKey,
  inboxReducer,
  loadInbox,
  parseInbox,
  saveInbox,
  unreadCount,
  type InboxEntry,
} from '../alertInbox';

const entry = (id: number, over: Partial<InboxEntry> = {}): InboxEntry => ({
  id,
  tier: 'major',
  type: 'drama',
  template_data: { description: `row ${id}` },
  agent_ids: [1],
  timestamp: id,
  receivedAt: 0,
  read: false,
  ...over,
});

describe('inboxReducer', () => {
  it('adds newest first, drops repeats and keeps the last INBOX_MAX', () => {
    let s = inboxReducer([], { type: 'add', entries: [entry(1), entry(2)] });
    expect(s.map((e) => e.id)).toEqual([2, 1]);

    const same = inboxReducer(s, { type: 'add', entries: [entry(2, { read: true })] });
    expect(same).toBe(s); // nothing new: same reference, no re-render or save
    expect(same[0].read).toBe(false); // the repeat didn't overwrite the stored row

    s = inboxReducer(s, { type: 'add', entries: Array.from({ length: INBOX_MAX + 5 }, (_, i) => entry(100 + i)) });
    expect(s).toHaveLength(INBOX_MAX);
    expect(s[0].id).toBe(100 + INBOX_MAX + 4);
    expect(s.some((e) => e.id === 1)).toBe(false);
  });

  it('counts unread and marks everything read', () => {
    const s = inboxReducer([], { type: 'add', entries: [entry(1), entry(2, { read: true }), entry(3)] });
    expect(unreadCount(s)).toBe(2);
    const read = inboxReducer(s, { type: 'markAllRead' });
    expect(unreadCount(read)).toBe(0);
    expect(inboxReducer(read, { type: 'markAllRead' })).toBe(read);
  });

  it('clears and loads', () => {
    const s = inboxReducer([], { type: 'add', entries: [entry(1)] });
    expect(inboxReducer(s, { type: 'clear' })).toEqual([]);
    const empty: InboxEntry[] = [];
    expect(inboxReducer(empty, { type: 'clear' })).toBe(empty);
    expect(inboxReducer([], { type: 'load', entries: [entry(1), entry(5), entry(3)] }).map((e) => e.id)).toEqual([5, 3, 1]);
  });
});

describe('inbox storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses tolerantly', () => {
    expect(parseInbox(null)).toEqual([]);
    expect(parseInbox('not json')).toEqual([]);
    expect(parseInbox('{"id":1}')).toEqual([]);
    const good = entry(4, { tier: 'player' });
    expect(parseInbox(JSON.stringify([good, { id: 'x' }, { ...good, id: 5, tier: 'loud' }, null]))).toEqual([good]);
  });

  it('round-trips through sessionStorage under the world seed', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    saveInbox('seed-a', [entry(1), entry(2)]);
    expect(store.has(inboxKey('seed-a'))).toBe(true);
    expect(loadInbox('seed-a').map((e) => e.id)).toEqual([2, 1]);
    expect(loadInbox('seed-b')).toEqual([]);
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(loadInbox('seed')).toEqual([]);
    expect(() => saveInbox('seed', [entry(1)])).not.toThrow();
  });
});
