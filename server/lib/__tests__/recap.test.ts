import { describe, it, expect } from 'vitest';
import { buildRecap, RECAP_MAX_BULLETS, type RecapRow } from '../recap';

/**
 * "Previously on…": which rows make the card, in what order, how many, and
 * that the same story never takes two lines.
 */

const DAY = 1440;
let nextId = 1;

function row(p: Partial<RecapRow> & { type: string; game_minute: number }): RecapRow {
  return {
    id: nextId++,
    category: 'drama',
    importance: 0.8,
    agent_ids: [],
    template_data: {},
    metadata: null,
    ...p,
  };
}

const death = (m: number, who = 1) =>
  row({ type: 'drama', game_minute: m, initiator_id: who, agent_ids: [who], metadata: { beat: 'death' }, template_data: { description: 'Ada Finch has died. Old age. The town mourns.' } });
const wedding = (m: number, a = 2, b = 3) =>
  row({ type: 'wedding', category: 'relationship', importance: 1, game_minute: m, agent_ids: [a, b], template_data: { description: 'Bo and Cy were married on the square, with the whole town looking on.' } });
const status = (m: number, s: string, a = 2, b = 3) =>
  row({ type: 'relationship_status_change', category: 'relationship', importance: 0.7, game_minute: m, agent_ids: [a, b], template_data: { agent1: 'Bo Hale', agent2: 'Cy Moss', status: s } });
const fight = (m: number, a: number, b: number, importance = 0.85, text = `Fight ${a}-${b}`, beat = 'fight') =>
  row({ type: 'confrontation', game_minute: m, importance, agent_ids: [a, b], metadata: { beat }, template_data: { description: text } });

/** Ten different story beats, so the per-family cap stays out of a test's way. */
const BEATS = ['fight', 'insult', 'snap', 'date', 'flirt', 'reconciliation', 'confession', 'gossip', 'breakup', 'arrest'];

describe('buildRecap', () => {
  it('returns no bullets for an empty span', () => {
    const r = buildRecap({ sinceMinute: 100, untilMinute: 500, rows: [] });
    expect(r.bullets).toEqual([]);
    expect(r).toMatchObject({ sinceMinute: 100, untilMinute: 500 });
  });

  it('ignores rows outside the span and small rows', () => {
    const r = buildRecap({
      sinceMinute: 1000,
      untilMinute: 2000,
      rows: [
        fight(1000, 1, 2), // exactly the last minute seen: already seen
        fight(2001, 3, 4), // after "now"
        row({ type: 'purchase', category: 'economy', importance: 0.15, game_minute: 1500 }),
        row({ type: 'state_gained', category: 'state', importance: 0.7, game_minute: 1500 }),
        row({ type: 'drama', importance: 0.65, game_minute: 1500, template_data: { description: 'A small scene.' } }),
      ],
    });
    expect(r.bullets).toEqual([]);
  });

  it('writes human sentences: status flips in words, a full stop on every line', () => {
    const r = buildRecap({
      sinceMinute: 0,
      untilMinute: DAY,
      rows: [status(100, 'partners'), fight(200, 5, 6, 0.9, 'Eli shoved Fay outside the tavern')],
    });
    expect(r.bullets.map((b) => b.text)).toEqual([
      'Bo Hale and Cy Moss got together.',
      'Eli shoved Fay outside the tavern.',
    ]);
    expect(r.bullets[0]).toMatchObject({ kind: 'status', agentIds: [2, 3] });
  });

  it('skips status changes that do not rewrite a pair', () => {
    const r = buildRecap({ sinceMinute: 0, untilMinute: DAY, rows: [status(100, 'acquaintances'), status(200, 'best_friends', 4, 5)] });
    expect(r.bullets).toEqual([]);
  });

  it('picks by importance but tells the story in order', () => {
    const rows = [
      fight(100, 10, 11, 0.8),
      wedding(300),
      fight(400, 12, 13, 0.95),
      death(500),
    ];
    const r = buildRecap({ sinceMinute: 0, untilMinute: DAY, rows });
    expect(r.bullets.map((b) => b.gameMinute)).toEqual([100, 300, 400, 500]);
  });

  it('caps the card, dropping the smallest beats first', () => {
    const rows = [
      death(900),
      wedding(50),
      ...Array.from({ length: 10 }, (_, i) => fight(100 + i, 20 + i * 2, 21 + i * 2, 0.76 + i * 0.02, `Scene ${i}`, BEATS[i])),
    ];
    const r = buildRecap({ sinceMinute: 0, untilMinute: DAY, rows });
    expect(r.bullets).toHaveLength(RECAP_MAX_BULLETS);
    const kinds = r.bullets.map((b) => b.kind);
    expect(kinds).toContain('death');
    expect(kinds).toContain('wedding');
    // The four strongest fights survive: 0.94, 0.92, 0.90, 0.88 (rows 9..6).
    expect(r.bullets.filter((b) => b.kind === 'beat').map((b) => b.gameMinute)).toEqual([106, 107, 108, 109]);
  });

  it('gives one line per pair: a wedding outranks the partners flip and their date', () => {
    const r = buildRecap({
      sinceMinute: 0,
      untilMinute: DAY,
      rows: [
        status(100, 'partners'),
        row({ type: 'drama', game_minute: 150, agent_ids: [3, 2], metadata: { beat: 'date' }, template_data: { description: 'Bo and Cy shared a dinner' } }),
        row({ type: 'engagement', category: 'relationship', importance: 0.9, game_minute: 200, agent_ids: [2, 3], template_data: { description: 'Bo and Cy are engaged!' } }),
        wedding(300),
      ],
    });
    expect(r.bullets).toHaveLength(1);
    expect(r.bullets[0].kind).toBe('wedding');
  });

  it('keeps the latest status when a pair flips twice', () => {
    const r = buildRecap({ sinceMinute: 0, untilMinute: DAY, rows: [status(100, 'partners'), status(200, 'enemies')] });
    expect(r.bullets.map((b) => b.text)).toEqual(['Bo Hale and Cy Moss became enemies.']);
  });

  it('never merges a death into a pair and dedupes identical sentences', () => {
    const r = buildRecap({
      sinceMinute: 0,
      untilMinute: DAY,
      rows: [
        death(100, 1),
        fight(50, 1, 2, 0.9, 'Rumor: the mill is haunted'),
        fight(60, 3, 4, 0.9, 'Rumor: the mill is haunted'),
      ],
    });
    expect(r.bullets.map((b) => b.kind)).toEqual(['beat', 'death']);
  });

  it('tells a rumor once, in its widest telling', () => {
    const tell = (m: number, text: string, importance: number, agents: number[]) =>
      row({ type: 'drama', game_minute: m, importance, agent_ids: agents, template_data: { description: text } });
    const r = buildRecap({
      sinceMinute: 0,
      untilMinute: DAY,
      rows: [
        tell(100, 'Ray told Lucia that Diego has a crush on Rosa', 0.8, [1, 2]),
        tell(200, 'Omar overheard that Diego has a crush on Rosa', 0.8, [3]),
        tell(300, 'The whole town now knows that Diego has a crush on Rosa', 1, [4]),
      ],
    });
    expect(r.bullets.map((b) => b.text)).toEqual(['The whole town now knows that Diego has a crush on Rosa.']);
  });

  it('keeps at most two beats of one family, so a gossipy day still reads varied', () => {
    const known = (m: number, what: string, who: number) =>
      row({ type: 'drama', game_minute: m, importance: 1, agent_ids: [who], template_data: { description: `The whole town now knows that ${what}` } });
    const storm = (m: number, text: string) =>
      row({ type: 'world_event', category: 'world_event', importance: 0.9, game_minute: m, template_data: { description: text } });
    const r = buildRecap({
      sinceMinute: 0,
      untilMinute: DAY,
      rows: [
        known(10, 'A is in love', 1), known(20, 'B lied', 2), known(30, 'C stole', 3), known(40, 'D cried', 4),
        storm(50, 'Heavy Storm: rain'), storm(60, 'Traveling Merchant: goods'), storm(70, 'Bountiful Catch: fish'),
        fight(80, 7, 8, 0.8, 'Eli shoved Fay'),
      ],
    });
    const texts = r.bullets.map((b) => b.text);
    expect(texts.filter((t) => t.startsWith('The whole town'))).toHaveLength(2);
    expect(texts.filter((t) => /Storm|Merchant|Catch/.test(t))).toHaveLength(2);
    expect(texts).toContain('Eli shoved Fay.');
  });

  it('caps the player lines at two, outcomes before expired nudges', () => {
    const outcome = (m: number, t: string) =>
      row({ type: 'player_outcome', category: 'player', importance: 0.85, game_minute: m, agent_ids: [7], template_data: { description: t } });
    const r = buildRecap({
      sinceMinute: 0,
      untilMinute: DAY,
      rows: [
        row({ type: 'player_nudge_expired', category: 'player', importance: 0.8, game_minute: 10, template_data: { description: 'Your nudge never happened' } }),
        outcome(20, 'Your confrontation: Gus and Hal made up'),
        outcome(30, 'Your rumor reached Ivy'),
        row({ type: 'player_whisper', category: 'player', importance: 0.9, game_minute: 40, template_data: { description: 'You whispered' } }),
      ],
    });
    expect(r.bullets.map((b) => b.text)).toEqual(['Your confrontation: Gus and Hal made up.', 'Your rumor reached Ivy.']);
  });

  it('leads with the span\'s paper headlines, newest printing of a day, two at most', () => {
    const r = buildRecap({
      sinceMinute: 2 * DAY + 600,
      untilMinute: 5 * DAY + 100,
      rows: [fight(3 * DAY, 1, 2)],
      headlines: [
        { id: 1, day: 1, headline: 'Before the span' },
        { id: 2, day: 3, headline: 'Old draft' },
        { id: 5, day: 3, headline: 'Mill burns' },
        { id: 3, day: 4, headline: 'Wedding bells' },
        { id: 4, day: 2, headline: 'Too old to lead' },
      ],
    });
    expect(r.bullets.map((b) => b.kind)).toEqual(['paper', 'paper', 'beat']);
    expect(r.bullets[0].text).toContain('Mill burns');
    expect(r.bullets[1].text).toContain('Wedding bells');
  });
});

describe('buildRecap and romance', () => {
  const names = { agent1: 'Ada Finch', agent2: 'Bruno Vale' };
  const firstKiss = (m: number, a = 4, b = 5, data: Record<string, string> = names) =>
    row({ type: 'first_kiss', category: 'relationship', importance: 0.65, game_minute: m, initiator_id: a, target_id: b, agent_ids: [a, b], metadata: { beat: 'kiss' }, template_data: data });

  it('a first kiss makes the card, in the feed\'s own discreet words', () => {
    const r = buildRecap({ sinceMinute: 0, untilMinute: DAY, rows: [firstKiss(100)] });
    expect(r.bullets).toHaveLength(1);
    expect(r.bullets[0]).toMatchObject({ kind: 'romance', icon: '♥', text: 'Ada Finch and Bruno Vale shared a first kiss.', agentIds: [4, 5] });
  });

  it('nothing else of the private side does: a routine kiss, an evening, a refusal', () => {
    const r = buildRecap({
      sinceMinute: 0, untilMinute: DAY,
      rows: [
        row({ type: 'kiss', category: 'relationship', importance: 0.3, game_minute: 100, agent_ids: [4, 5], template_data: names }),
        row({ type: 'tryst', category: 'relationship', importance: 0.5, game_minute: 110, agent_ids: [4, 5], template_data: { ...names, venue: 'Ada Cottage' } }),
        row({ type: 'kiss_rebuffed', category: 'drama', importance: 0.5, game_minute: 120, agent_ids: [4, 5], template_data: names }),
      ],
    });
    expect(r.bullets).toEqual([]);
  });

  it('being seen and the town\'s whispers are beats, with a hush icon', () => {
    const r = buildRecap({
      sinceMinute: 0, untilMinute: DAY,
      rows: [
        row({ type: 'caught', importance: 0.75, game_minute: 100, agent_ids: [4, 5, 6], metadata: { beat: 'caught' }, template_data: { ...names, witness: 'Cora Lund', scene: 'dawn' } }),
        row({ type: 'scandal', importance: 0.85, game_minute: 200, initiator_id: 4, agent_ids: [4], metadata: { beat: 'scandal' }, template_data: { agent1: 'Ada Finch' } }),
      ],
    });
    expect(r.bullets.map((b) => [b.kind, b.icon, b.text])).toEqual([
      ['beat', '🤫', "Cora Lund saw Ada Finch slipping out of Bruno Vale's house at dawn."],
      ['beat', '🤫', 'Whispers follow Ada Finch through town.'],
    ]);
  });

  it('a first kiss that became a couple is one line, the status flip', () => {
    const r = buildRecap({ sinceMinute: 0, untilMinute: DAY, rows: [firstKiss(100, 2, 3), status(300, 'partners')] });
    expect(r.bullets.map((b) => b.kind)).toEqual(['status']);
  });

  it('keeps first kisses to two a card so a spring of them is not the whole recap', () => {
    const r = buildRecap({
      sinceMinute: 0, untilMinute: DAY,
      rows: [10, 12, 14, 16].map((a, i) =>
        firstKiss(100 * (i + 1), a, a + 1, { agent1: `Lover ${a}`, agent2: `Beloved ${a + 1}` })),
    });
    expect(r.bullets.filter((b) => b.kind === 'romance')).toHaveLength(2);
  });
});
