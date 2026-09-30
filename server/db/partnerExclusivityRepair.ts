import type Database from 'better-sqlite3';

/**
 * Every start (and save load): nobody is the partner of two living people at once, in a world made
 * before partner exclusivity existed (engine/systems/relationships.ts `holdsPartnerElsewhere`).
 *
 * The relationship tick now refuses to promote a pair to `partners` while one of them already holds
 * a partner elsewhere, but it deliberately grandfathers incumbents, so a save (or a soak) from
 * before still has people with several `partners` rows. Nothing at runtime ever removes those; this
 * settles them once:
 *
 *  - every partner row between two residents who are both in town competes, best first: a marriage
 *    or engagement (the milestone tags) beats a plain partnership, then the earlier
 *    `status_since_minute` (the pair that has been together longest), then the lower id;
 *  - walking that order, a row is kept when neither person already holds a kept row, and demoted
 *    otherwise. So a spouse wins over an older fling, and a demoted row frees its other person for
 *    a later row of theirs (no one is left single because of a pair that was itself demoted);
 *  - a demoted row loses the `partner` tag and becomes what the tick would have made it had it been
 *    blocked: a `romantic_interest` with a `crush` tag (a `complicated` one when they have fallen
 *    out), or, with no romance left worth the name, plain friends or acquaintances. Its numbers are
 *    untouched: it is the label that goes, not the feeling.
 *
 * A partner who has left town (inactive) holds nobody, so rows involving one are ignored, like the
 * tick does. Idempotent: after one run at most one partner row per person remains among the living,
 * so a second finds nothing (no user_version needed). Raw `sqlite` handle and plain SQL: it runs
 * inside `initSchema`, before the drizzle client exists. Returns how many rows it demoted.
 */
export function repairPartnerExclusivity(sqlite: Database.Database): number {
  const active = new Set(
    (sqlite.prepare('SELECT id FROM agents WHERE is_active = 1').all() as Array<{ id: number }>).map((r) => r.id),
  );
  const raw = sqlite.prepare(
    'SELECT id, agent_a, agent_b, friendship_ab, friendship_ba, romance_ab, romance_ba, tags, status, status_since_minute FROM relationships',
  ).all() as Array<{
    id: number; agent_a: number; agent_b: number; friendship_ab: number; friendship_ba: number;
    romance_ab: number; romance_ba: number; tags: string; status: string; status_since_minute: number | null;
  }>;

  const partners = raw.flatMap((r) => {
    if (!active.has(r.agent_a) || !active.has(r.agent_b)) return [];
    let tags: string[] = [];
    try {
      const v = JSON.parse(r.tags);
      if (Array.isArray(v)) tags = v.filter((t): t is string => typeof t === 'string');
    } catch { /* a corrupt tag column reads as no tags */ }
    if (r.status !== 'partners' && !tags.includes('partner')) return [];
    return [{ ...r, parsedTags: tags, bound: tags.includes('married') || tags.includes('engaged') }];
  });
  partners.sort((x, y) =>
    Number(y.bound) - Number(x.bound)
    || (x.status_since_minute ?? 0) - (y.status_since_minute ?? 0)
    || x.id - y.id);

  const held = new Set<number>();
  const demote: typeof partners = [];
  for (const r of partners) {
    if (held.has(r.agent_a) || held.has(r.agent_b)) {
      demote.push(r);
      continue;
    }
    held.add(r.agent_a);
    held.add(r.agent_b);
  }
  if (demote.length === 0) return 0;

  const set = sqlite.prepare('UPDATE relationships SET tags = ?, status = ? WHERE id = ?');
  sqlite.transaction(() => {
    for (const r of demote) {
      const maxRomance = Math.max(r.romance_ab, r.romance_ba);
      const avgFriendship = (r.friendship_ab + r.friendship_ba) / 2;
      const crush = maxRomance > 40;
      // The tick's own reading of a blocked pair (deriveStatus without the partners branch).
      const status = maxRomance > 30
        ? (avgFriendship < -10 ? 'complicated' : 'romantic_interest')
        : avgFriendship > 40 ? 'friends' : 'acquaintances';
      const tags = r.parsedTags.filter((t) => t !== 'partner');
      if (crush && !tags.includes('crush')) tags.push('crush');
      set.run(JSON.stringify(tags), status, r.id);
    }
  })();
  console.log(`[db] Partner exclusivity: ${demote.length} extra partnership(s) settled (earliest kept, marriages first)`);
  return demote.length;
}
