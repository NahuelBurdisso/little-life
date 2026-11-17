import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../../db';
import { activityLog } from '../../db/schema';
import { logActivity } from '../activityLogger';
import { activityRouter } from '../../routers/activity';
import { DRAMA_BEAT_KIND, isDramaBeat, type DramaBeat } from '../../data/dramaBeats';

/**
 * `metadata.beat` is the contract between the server's drama emit sites and the canvas's
 * story beats (src/components/canvas/systems/beats/beatDetect.ts). Three things must hold:
 * the tag survives storage and the query the client reads, the vocabulary is closed, and every
 * emit site the client used to recognise by wording really passes its tag.
 */

beforeEach(() => { db.delete(activityLog).run(); });
afterAll(() => { db.delete(activityLog).run(); });

describe('drama beat tag storage', () => {
  it('persists metadata.beat and hands it to the client through activity.getRecent', async () => {
    logActivity({
      type: 'drama', initiator: 1, target: 2,
      templateData: { description: 'Ana started a fight with Bo' },
      metadata: { beat: 'fight' },
    });
    logActivity({ type: 'drama', initiator: 1, templateData: { description: 'an old-style row' } });

    const rows = await activityRouter.createCaller({} as never).getRecent({ limit: 10 });
    const tagged = rows.find(r => r.initiator_id === 1 && r.target_id === 2)!;
    const untagged = rows.find(r => r.target_id === null)!;
    expect((tagged.metadata as { beat?: string }).beat).toBe('fight');
    expect(untagged.metadata).toBeNull();
  });
});

describe('drama beat vocabulary: intimacy beats', () => {
  it('maps the kiss beats to their canvas family (contract table)', () => {
    expect(DRAMA_BEAT_KIND.kiss).toBe('kiss');
    expect(DRAMA_BEAT_KIND.kiss_rebuffed).toBe('heartbreak');
    expect(DRAMA_BEAT_KIND.tryst).toBe('romance');
    expect(DRAMA_BEAT_KIND.caught).toBe('secret');
    expect(DRAMA_BEAT_KIND.scandal).toBe('secret');
    for (const b of ['kiss', 'kiss_rebuffed', 'tryst', 'caught', 'scandal']) expect(isDramaBeat(b)).toBe(true);
  });
});

describe('drama beat vocabulary: the small everyday rows', () => {
  it('knows the beats that untagged rows now carry, and draws nothing for them', () => {
    for (const b of ['release', 'drunk', 'outburst', 'blackmail', 'lonely']) {
      expect(isDramaBeat(b), b).toBe(true);
      // They never had a picture (their wording matched nothing in beatDetect); tagging must not add one.
      expect(DRAMA_BEAT_KIND[b as DramaBeat], b).toBeNull();
    }
  });
});

describe('drama beat vocabulary', () => {
  it('isDramaBeat only accepts known subtypes (not prototype keys, not other types)', () => {
    expect(isDramaBeat('fight')).toBe(true);
    expect(isDramaBeat('theft')).toBe(true);
    expect(isDramaBeat('toString')).toBe(false);
    expect(isDramaBeat('nonsense')).toBe(false);
    expect(isDramaBeat(undefined)).toBe(false);
    expect(isDramaBeat(3)).toBe(false);
  });
});

/**
 * [file, a unique fragment of the description, the beat its logActivity call must carry].
 * If a template is reworded, update the fragment here; if a call loses its tag, this fails
 * instead of the animation silently going missing on fresh rows.
 */
const EMIT_SITES: Array<[string, string, DramaBeat]> = [
  ['lib/confrontationEngine.ts', 'managed to clear the air', 'reconciliation'],
  ['lib/confrontationEngine.ts', 'had a public shouting match', 'fight'],
  ['lib/confrontationEngine.ts', 'got into a physical fight in public', 'fight'],
  ['lib/conversationBeats.ts', 'during a heated argument', 'insult'],
  ['lib/conversationBeats.ts', 'started a fight with ${target.name}`', 'fight'],
  ['lib/conversationBeats.ts', 'after their conversation`', 'flirt'],
  ['lib/conversationBeats.ts', 'confessed a secret to ${listener.name}.`', 'confession'],
  ['lib/conversationBeats.ts', 'have reconciled.', 'reconciliation'],
  ['lib/conversationBeats.ts', "affair and broke up!", 'breakup'],
  ['engine/systems/decisions/social.ts', 'are on a date', 'date'],
  ['engine/systems/decisions/crime.ts', 'arrested ${other.name}!', 'arrest'],
  ['engine/systems/decisions/crime.ts', 'was caught pickpocketing', 'theft'],
  ['engine/systems/relationships.ts', 'are estranged for good', 'estrangement'],
  ['engine/systems/gossipEngine.ts', '} overheard`', 'gossip'],
  ['engine/systems/gossipEngine.ts', '} discovered`', 'gossip'],
  ['lib/cascade/SnapResolver.ts', 'snapped and confronted someone!', 'snap'],
  ['lib/cascade/SnapResolver.ts', 'snapped and lashed out at those nearby!', 'snap'],
  ['lib/secretSharing.ts', 'confided a personal secret to', 'confession'],
  ['lib/gossip.ts', '} learned`', 'gossip'],
  ['lib/lifeEventsEngine.ts', 'has died.', 'death'],
  ['lib/agingEngine.ts', 'Happy birthday to', 'birthday'],
  // The snap's quiet outcomes (the story-health tally counts `metadata.beat`, so an untagged row is invisible).
  ['lib/cascade/SnapResolver.ts', 'snapped and fled home in distress', 'outburst'],
  ['lib/cascade/SnapResolver.ts', 'snapped quietly and began plotting revenge`', 'misdeed'],
  ['lib/cascade/SnapResolver.ts', 'had a public emotional breakdown!', 'outburst'],
  ['lib/cascade/SnapResolver.ts', 'spiraled into self-destructive behavior', 'outburst'],
  // Rows that used to log `drama` untagged: gossip read as ~90% of the beats because these were invisible.
  ['engine/systems/states.ts', 'was released from prison after', 'release'],
  ['engine/systems/states.ts', "publicly exposed their blackmailer's leverage", 'blackmail'],
  ['engine/systems/states/effects.ts', 'was caught stealing from ${loc.name}!', 'theft'],
  ['engine/systems/states/effects.ts', 'gambled at the tavern', 'drunk'],
  ['engine/systems/states/effects.ts', 'started spreading rumors about', 'gossip'],
  ['lib/tavernEngine.ts', 'is getting tipsy at the tavern', 'drunk'],
  ['lib/tavernEngine.ts', 'is now drunk at the tavern!', 'drunk'],
  ['lib/tavernEngine.ts', 'outbursts[Math.floor(Math.random() * outbursts.length)]', 'outburst'],
  ['engine/systems/economy.ts', 'during the economic crisis', 'theft'],
  ['engine/systems/economy.ts', 'to a traveling scammer', 'theft'],
  ['engine/systems/economy.ts', 'is hoarding supplies', 'misdeed'],
  ['lib/lonelinessEngine.ts', 'has become lonely and withdrawn', 'lonely'],
  ['lib/lonelinessEngine.ts', 'seems lonely and decided to visit', 'lonely'],
  ['lib/giftEngine.ts', 'and feels jealous', 'outburst'],
  ['engine/systems/conversations/darkDynamics.ts', 'reported blackmail to the constable', 'blackmail'],
  ['lib/gossip.ts', 'and is furious.', 'outburst'],
];

describe('drama emit sites carry their beat tag', () => {
  it.each(EMIT_SITES)('%s: "%s" -> %s', (file, fragment, beat) => {
    const src = readFileSync(resolve(__dirname, '../..', file), 'utf8');
    const at = src.indexOf(fragment);
    expect(at, `fragment not found in ${file}`).toBeGreaterThan(-1);
    // The tag sits inside the same logActivity call, i.e. before the next call starts.
    const nextCall = src.indexOf('logActivity(', at);
    const call = src.slice(at, nextCall === -1 ? at + 600 : Math.min(nextCall, at + 600));
    expect(call).toMatch(new RegExp(`beat:\\s*['"]${beat}['"]`));
    expect(DRAMA_BEAT_KIND).toHaveProperty(beat);
  });
});
