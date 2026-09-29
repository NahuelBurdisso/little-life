import { describe, it, expect } from 'vitest';
import { CAPTION_MAX_CHARS, buildCaption, contextLine, findShotConversation } from '../directorCaption';

const NAMES: Record<number, string> = { 1: 'Mara', 2: 'Jonas', 3: 'Rosa' };
const nameOf = (id: number) => NAMES[id] ?? `Agent ${id}`;

describe('contextLine', () => {
  it('says who confronts whom, with the opener first', () => {
    expect(contextLine(['Mara', 'Jonas'], 'confrontation', 'player_confront')).toBe('Mara confronts Jonas');
    expect(contextLine(['Jonas', 'Mara'], 'confrontation', 'needs_social')).toBe('Jonas confronts Mara');
  });

  it('never prints the content of a secret', () => {
    const line = contextLine(['Mara', 'Jonas'], 'revealing: Jonas stole the ledger', 'player_tell_secret');
    expect(line).toBe('Mara lets Jonas in on a secret');
    expect(line).not.toMatch(/ledger/);
  });

  it('names the gossip subject', () => {
    expect(contextLine(['Mara', 'Jonas'], 'gossip about Rosa', 'needs_social')).toBe('Mara and Jonas gossip about Rosa');
  });

  it('covers the usual intents', () => {
    expect(contextLine(['Mara', 'Jonas'], 'flirting', null)).toBe('Mara flirts with Jonas');
    expect(contextLine(['Mara', 'Jonas'], 'venting worries', null)).toBe('Mara vents to Jonas');
    expect(contextLine(['Mara', 'Jonas'], 'seeking comfort', null)).toBe('Mara seeks comfort from Jonas');
    expect(contextLine(['Mara', 'Jonas'], 'offering comfort', null)).toBe('Mara offers Jonas comfort');
    expect(contextLine(['Mara', 'Jonas'], 'tension', null)).toBe('Mara and Jonas clash, tension in the air');
  });

  it('falls back to the topic, or to plain talk', () => {
    expect(contextLine(['Mara', 'Jonas'], 'Weather', null)).toBe('Mara and Jonas talk about weather');
    expect(contextLine(['Mara', 'Jonas'], null, null)).toBe('Mara and Jonas talk');
    expect(contextLine(['Mara', 'Jonas', 'Rosa'], null, null)).toBe('Mara, Jonas and Rosa talk');
  });
});

describe('findShotConversation', () => {
  const convos = [
    { id: 1, participants: [1, 2], messages: [{ text: 'a' }], location: 10 },
    { id: 2, participants: [3], messages: [{ text: 'a' }, { text: 'b' }], location: 11 },
    { id: 3, participants: [4], messages: [], location: 11 },
  ];

  it('prefers the shot\'s own conversation, then its cast, then the busiest talk at the place', () => {
    expect(findShotConversation({ key: 'convo:2', agentIds: [1], locationId: null }, convos)?.id).toBe(2);
    expect(findShotConversation({ key: 'alert:9', agentIds: [2], locationId: null }, convos)?.id).toBe(1);
    expect(findShotConversation({ key: 'roam:11', agentIds: [], locationId: 11 }, convos)?.id).toBe(2);
    expect(findShotConversation({ key: 'roam:12', agentIds: [], locationId: 12 }, convos)).toBeNull();
  });
});

describe('buildCaption', () => {
  const shot = { key: 'convo:1', agentIds: [1, 2], locationId: 10, label: 'Mara & Jonas' };

  it('shows the latest two lines with stable speaker colours', () => {
    const cap = buildCaption(shot, [{
      id: 1,
      participants: [1, 2],
      topic: 'confrontation',
      trigger_reason: 'player_confront',
      messages: [
        { speakerId: 1, text: 'Where is the ledger?' },
        { speakerId: 2, text: 'I do not know what you mean.' },
        { speakerId: 1, text: 'Do not lie to me.' },
      ],
    }], nameOf);
    expect(cap?.context).toBe('Mara confronts Jonas');
    expect(cap?.lines.map((l) => [l.name, l.text, l.color])).toEqual([
      ['Jonas', 'I do not know what you mean.', 1],
      ['Mara', 'Do not lie to me.', 0],
    ]);
    expect(cap?.lines.map((l) => l.index)).toEqual([1, 2]);
  });

  it('marks canned fallbacks as narration and clips long lines', () => {
    const cap = buildCaption(shot, [{
      id: 1,
      participants: [1, 2],
      messages: [
        { speakerId: 2, text: 'x'.repeat(CAPTION_MAX_CHARS + 50) },
        { speakerId: 1, text: 'Mara nodded.', fallback: true },
      ],
    }], nameOf);
    expect(cap?.lines[0].text.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(cap?.lines[1].narration).toBe(true);
  });

  it('has an empty line list while the pair has not spoken yet', () => {
    const cap = buildCaption(shot, [{ id: 1, participants: [1, 2], messages: [], topic: 'flirting' }], nameOf);
    expect(cap?.context).toBe('Mara flirts with Jonas');
    expect(cap?.lines).toEqual([]);
  });

  it('uses the shot label when nobody is talking, and nothing when there is no label', () => {
    expect(buildCaption({ key: 'alert:1', agentIds: [3], locationId: null, label: 'Rosa is furious' }, [], nameOf)?.context).toBe('Rosa is furious');
    expect(buildCaption({ key: 'roam:idle', agentIds: [], locationId: null, label: '' }, [], nameOf)).toBeNull();
  });
});
