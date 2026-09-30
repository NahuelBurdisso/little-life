import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../../db';
import { activityLog, worldState } from '../../db/schema';
import { ACTIVITY_REGISTRY } from '../../data/activityRegistry';
import { buildGazettePrompt, parseGazette, gatherMaterial, arcsForPaper, GAZETTE_NAME } from '../gazette';
import { maturityDirective } from '../../ai/contentRating';
import { setRuleOverrides } from '../worldRules';

describe('gazette prompt and parser', () => {
  const material = {
    items: ['Marco Rivera was caught stealing bread from Priya Sharma', 'Rosa Chen and Yuki Tanaka are now dating'],
    events: ['A storm rolled in over the farms'],
    arcs: [{ title: 'Marco vs Priya', summary: 'A feud over stolen bread' }],
  };

  it('hands the model only the reported facts, the setting and a schema', () => {
    const p = buildGazettePrompt(material, 4, 'spring', 'stormy');
    expect(p.system).toContain(GAZETTE_NAME);
    expect(p.system).toContain('- Marco Rivera was caught stealing bread from Priya Sharma');
    expect(p.system).toContain('Marco vs Priya: A feud over stolen bread');
    expect(p.system).toContain('around 1900');
    expect(p.system).toMatch(/ONLY facts/);
    expect(p.format).toMatchObject({ required: ['headline', 'articles', 'gossip'] });
  });

  it('hands the model the roster so the paper does not invent names', () => {
    const roster = 'People in town: Rosa Chen (Shopkeeper). Anyone not on this list is a stranger to town; never make up names for townsfolk.';
    expect(buildGazettePrompt(material, 4, 'spring', 'stormy', roster).system).toContain(roster);
    expect(buildGazettePrompt(material, 4, 'spring', 'stormy').system).not.toContain('People in town');
  });

  it('parses an edition and drops empty articles', () => {
    const raw = JSON.stringify({
      headline: 'THIEF IN THE BAKERY!',
      articles: [
        { headline: 'Bread Gone Missing', body: 'Mr. Marco Rivera was seen leaving the bakery with a loaf he had not paid for.' },
        { headline: '', body: 'x' },
      ],
      gossip: 'Which shopkeeper has been seen *arm in arm* with a certain lady?',
    });
    expect(parseGazette(raw)).toEqual({
      headline: 'THIEF IN THE BAKERY!',
      articles: [{ headline: 'Bread Gone Missing', body: 'Mr. Marco Rivera was seen leaving the bakery with a loaf he had not paid for.' }],
      gossip: 'Which shopkeeper has been seen arm in arm with a certain lady?',
    });
  });

  it('rejects an edition without a headline or articles', () => {
    expect(parseGazette('{"headline":"","articles":[]}')).toBeNull();
    expect(parseGazette('not json')).toBeNull();
  });
});

describe('gatherMaterial', () => {
  beforeEach(() => {
    db.delete(activityLog).run();
  });

  const log = (type: string, category: string, importance: number, timestamp: number, description: string) =>
    db.insert(activityLog).values({
      type, category, importance, agent_ids: [], template_key: type,
      template_data: { description }, timestamp, real_timestamp: Date.now(),
    }).run();

  it('keeps important, non-system lines after the last edition, oldest first, once each', () => {
    log('drama', 'drama', 0.8, 5, 'Old news from before the last edition');
    log('drama', 'drama', 0.8, 20, 'Marco stole bread');
    log('world_event', 'world_event', 0.9, 30, 'A storm rolled in');
    log('drama', 'drama', 0.8, 31, 'Marco stole bread');
    log('purchase', 'economy', 0.15, 32, 'Rosa bought bread');
    log('system', 'system', 0.9, 33, 'Server restarted');
    const m = gatherMaterial(10);
    expect(m.items).toEqual(['Marco stole bread']);
    expect(m.events).toEqual(['A storm rolled in']);
  });

  it('collapses retellings of one rumor into the widest one', () => {
    log('drama', 'drama', 0.8, 40, 'Ray told Lucia that Marco loves Carlos.');
    log('drama', 'drama', 0.8, 41, 'Diego overheard that Marco loves Carlos.');
    log('drama', 'drama', 0.9, 42, 'The whole town now knows that Marco loves Carlos.');
    expect(gatherMaterial(10).items).toEqual(['The whole town now knows that Marco loves Carlos.']);
  });

  it('keeps the private side of romance out of the paper: kisses and evenings stay private, being caught is news', () => {
    const row = (type: string, data: Record<string, string>) => {
      const e = ACTIVITY_REGISTRY[type];
      db.insert(activityLog).values({
        type, category: e.category, importance: e.base_importance, agent_ids: [], template_key: type,
        template_data: data, timestamp: 50, real_timestamp: Date.now(),
      }).run();
    };
    const names = { agent1: 'Ada', agent2: 'Bruno' };
    row('first_kiss', names);
    row('kiss', names);
    row('kiss_rebuffed', names);
    row('tryst', { ...names, venue: 'Ada Cottage' });
    row('caught', { ...names, witness: 'Cora', scene: 'dawn' });
    row('scandal', { agent1: 'Ada' });
    row('suspicion', names);
    const { items } = gatherMaterial(10);
    expect(items).toHaveLength(2);
    expect(items.join(' ')).toContain('Cora saw Ada slipping out');
    expect(items.join(' ')).toContain('Whispers follow Ada');
    expect(items.join(' ')).not.toMatch(/kiss|slipped away together|where they had been/);
    // The registry says so too: private by default, the leak and the scandal are not.
    for (const t of ['first_kiss', 'kiss', 'kiss_rebuffed', 'tryst', 'suspicion']) expect(ACTIVITY_REGISTRY[t].newsworthy, t).toBe(false);
    for (const t of ['caught', 'scandal']) expect(ACTIVITY_REGISTRY[t].newsworthy, t).not.toBe(false);
  });
});

describe('the paper stays discreet', () => {
  const empty = { items: ['Ada and Bruno shared a first kiss'], events: [], arcs: [] };

  // The rules live on the world row.
  beforeAll(() => {
    if (db.select().from(worldState).get()) return;
    db.insert(worldState).values({
      time: { day: 5, hour: 12, minute: 0, totalTicks: 7200, seasonDay: 5, season: 'spring' }, day_phase: 'afternoon',
      weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true, last_tick_completed: 0,
      current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30,
      collision_grid: '',
    }).run();
  });

  afterEach(() => setRuleOverrides({ adultContent: false }));

  it('carries the maturity line for the rule as it stands, and its own period discretion either way', () => {
    setRuleOverrides({ adultContent: true });
    const adult = buildGazettePrompt(empty, 4, 'spring', 'sunny').system;
    expect(adult).toContain(maturityDirective(true));
    expect(adult).toMatch(/never describe intimacy/);
    expect(adult).toMatch(/under 18/);

    setRuleOverrides({ adultContent: false });
    const chaste = buildGazettePrompt(empty, 4, 'spring', 'sunny').system;
    expect(chaste).toContain(maturityDirective(false));
    expect(chaste).not.toContain(maturityDirective(true));
    expect(chaste).toMatch(/hint and euphemism/);
  });

  it('is never handed an arc the town does not know about', () => {
    const arc = (title: string, secret?: true) => ({
      id: title, kind: 'love_triangle' as const, title, summary: `${title} summary`, participants: [1, 2, 3],
      participantNames: [], beats: [], heat: 0.5, lastActivity: 0, ...(secret ? { secret } : {}),
    });
    expect(arcsForPaper([arc('Open scandal'), arc('Hidden affair', true), arc('Feud')])).toEqual([
      { title: 'Open scandal', summary: 'Open scandal summary' },
      { title: 'Feud', summary: 'Feud summary' },
    ]);
    // Still four at most, counted after the secret ones are gone.
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => arc(t));
    expect(arcsForPaper([arc('h1', true), ...many])).toHaveLength(4);
  });
});
