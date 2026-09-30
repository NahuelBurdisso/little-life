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
  ['engine/systems/decisions.ts', 'are on a date', 'date'],
  ['engine/systems/decisions.ts', 'arrested ${other.name}!', 'arrest'],
  ['engine/systems/decisions.ts', 'was caught pickpocketing', 'theft'],
  ['engine/systems/relationships.ts', 'are estranged for good', 'estrangement'],
  ['engine/systems/gossipEngine.ts', '} overheard`', 'gossip'],
  ['engine/systems/gossipEngine.ts', '} discovered`', 'gossip'],
  ['lib/cascade/SnapResolver.ts', 'snapped and confronted someone!', 'snap'],
  ['lib/cascade/SnapResolver.ts', 'snapped and lashed out at those nearby!', 'snap'],
  ['lib/secretSharing.ts', 'confided a personal secret to', 'confession'],
  ['lib/gossip.ts', '} learned`', 'gossip'],
  ['lib/lifeEventsEngine.ts', 'has died.', 'death'],
  ['lib/agingEngine.ts', 'Happy birthday to', 'birthday'],
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
