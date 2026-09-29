import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db';
import { activityLog } from '../../db/schema';
import { buildGazettePrompt, parseGazette, gatherMaterial, GAZETTE_NAME } from '../gazette';

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
});
