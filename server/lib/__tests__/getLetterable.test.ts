import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../db';
import { agents, locations, relationships, shared_knowledge } from '../../db/schema';
import { knowledgeRouter } from '../../routers/knowledge';

/**
 * `knowledge.getLetterable`: the secrets the player could write to one resident about. It is
 * the secret network's filter (live, sensitivity >= 2) minus what a letter could not do:
 * what the recipient already knows, is themself, is public, or (for a minor) is about romance.
 * Ranked so the first rows are the ones with a stake for them: a partner's, then close ties'.
 */

const caller = () => knowledgeRouter.createCaller({});

let home: number;

function insertAgent(name: string, age = 30): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function tie(x: number, y: number, friendship: number, status = 'friends', tags: string[] = []): void {
  const [a, b] = x < y ? [x, y] : [y, x];
  db.insert(relationships).values({
    agent_a: a, agent_b: b, friendship_ab: friendship, friendship_ba: friendship,
    romance_ab: 0, romance_ba: 0, trust_ab: 0, trust_ba: 0, familiarity: 10,
    interaction_count: 1, last_interaction: 0, average_interaction_sentiment: 0,
    tags, status, created_at: 0, last_updated: 0,
  }).run();
}

let seq = 0;
function fact(
  type: string, subject: number, target: number | null, sensitivity: number, knownBy: number[],
  extra: Partial<typeof shared_knowledge.$inferInsert> = {},
): number {
  return db.insert(shared_knowledge).values({
    type, subject_id: subject, target_id: target, content: `${type} #${++seq}`, sensitivity,
    known_by: knownBy, created_at: 0, source: 'test', ...extra,
  }).returning({ id: shared_knowledge.id }).get().id;
}

const ids = async (recipientId: number) => (await caller().getLetterable({ recipientId })).map((r) => r.factId);

beforeAll(() => {
  home = db.insert(locations).values({
    name: 'Letterable Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
});

describe('knowledge.getLetterable', () => {
  it('lists live secrets the recipient does not know, with the fields the picker shows', async () => {
    const me = insertAgent('Lena Recipient');
    const cook = insertAgent('Carl Cook');
    const f = fact('financial', cook, null, 3, [cook]);
    const rows = await caller().getLetterable({ recipientId: me });
    expect(rows.find((r) => r.factId === f)).toEqual({
      factId: f, content: expect.stringContaining('financial'), subjectName: 'Carl Cook', sensitivity: 3,
    });
  });

  it('leaves out what is known, their own, public, dead, or too small', async () => {
    const me = insertAgent('Nora Recipient');
    const other = insertAgent('Olga Other');
    const known = fact('financial', other, null, 3, [other, me]);
    const own = fact('financial', me, null, 3, [me]);
    const affairAsTarget = fact('affair', other, me, 3, [other]);
    const pub = fact('theft', other, null, 3, [other], { is_public: true });
    const dead = fact('theft', other, null, 3, [other], { is_active: false });
    const small = fact('crush', other, null, 1, [other]);
    const ok = fact('debt', other, null, 2, [other]);

    const got = await ids(me);
    expect(got).toContain(ok);
    for (const bad of [known, own, affairAsTarget, pub, dead, small]) expect(got, String(bad)).not.toContain(bad);
  });

  it('keeps romance facts from a minor, but not from an adult', async () => {
    const kid = insertAgent('Kim Kid', 15);
    const grown = insertAgent('Gus Grown', 40);
    const a = insertAgent('Amy A');
    const b = insertAgent('Ben B');
    const affair = fact('affair', a, b, 3, [a, b]);
    const debt = fact('debt', a, null, 2, [a]);

    expect(await ids(kid)).not.toContain(affair);
    expect(await ids(kid)).toContain(debt);
    expect(await ids(grown)).toContain(affair);
  });

  it("puts the partner's secrets first, then close ties', and never more than eight", async () => {
    const me = insertAgent('Pia Recipient');
    const spouse = insertAgent('Sol Spouse');
    const pal = insertAgent('Pat Pal');
    const stranger = insertAgent('Sue Stranger');
    tie(me, spouse, 20, 'partners', ['married']);
    tie(me, pal, 80);
    // The stranger's are the most sensitive and the newest, and still come last.
    for (let i = 0; i < 10; i++) fact('theft', stranger, null, 3, [stranger]);
    const palFact = fact('debt', pal, null, 2, [pal]);
    const spouseFact = fact('affair', spouse, stranger, 2, [spouse]);

    const got = await ids(me);
    expect(got.slice(0, 2)).toEqual([spouseFact, palFact]);
    expect(got).toHaveLength(8);
  });

  it('is empty for a recipient who is not in town', async () => {
    expect(await caller().getLetterable({ recipientId: 987654 })).toEqual([]);
  });
});
