/**
 * The resident lifecycle: one way in, one way out.
 *
 * Why this exists. A person could enter the town three ways and leave it two,
 * and each path wrote its own subset of rows:
 *   - `setup.seedWorld` built the starting cast completely (starting ties, a
 *     backstory memory, an aspiration, job money, named homes);
 *   - `nudge.introduce_agent` built a newcomer with no ties, no memory and no
 *     aspiration — a stranger to every housemate, with nothing to reflect on;
 *   - death (`lifeEventsEngine.deactivateAgent`) freed the corpse's zone slot,
 *     conversations and queue entries, while `nudge.remove_agent` did its own,
 *     smaller version (the queue entries survived; a housemate was left
 *     "talking" to nobody).
 * Now that the town also grows and shrinks on its own (lib/populationFlow.ts),
 * every one of those paths goes through `createResident` / `retireResident`.
 *
 * Deliberately NOT here: what the arrival or departure means to the story —
 * feed lines, the townsfolk's memories, the funeral. The caller knows whether
 * the player dropped someone in, a stranger walked up the road or a resident
 * died, and words it. This module only makes the rows right and says what
 * happened on `simEvents` (`life:arrived`, `life:departed`) so the director,
 * sound and outcome listeners can react without knowing who caused it.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, sqlite } from '../db';
import {
  agents, agentStates, aspirations, conversationQueue, conversations, economy, locations, needs,
  relationships, worldState,
} from '../db/schema';
import { CONFIG } from './constants';
import { generateNewResident } from './newResident';
import { buildStartingTies, type StartingTieAgent } from './startingTies';
import { nameHomes } from './homeNames';
import { jobSalary } from '../data/jobs';
import { workplaceForJob } from './jobWorkplace';
import { gameMinutes } from './gameClock';
import { zoneOccupancy } from './interiorGrid';
import { planCache } from './planning/PlanCache';
import { memoryService } from './memory/instance';
import { simEvents } from './simEvents';
import { emitter } from '../engine/emitter';
import { makeRng, stringToSeed } from './worldgen/rng';

type AgentRow = typeof agents.$inferSelect;
type LocationRow = typeof locations.$inferSelect;
type Point = { x: number; y: number };

// ─── Housing ─────────────────────────────────────────────────────────────────

/**
 * Location types that take in a lodger when every house is full. The town has
 * no inn; the tavern's back rooms are the period answer.
 */
const LODGING_TYPES = ['inn', 'tavern'] as const;

export interface Housing {
  location: LocationRow;
  /** Rooms at the tavern, not a house of their own. */
  lodging: boolean;
}

/**
 * Residents per home, counted from `agents.home` of the LIVING. Residency, not
 * presence: `locations.current_occupants` is who is physically inside right
 * now (movement.ts rewrites it on every walk), which made every house look full
 * at 3am and empty at noon. The dead and the departed keep `home` on their row
 * (the column is NOT NULL, and it is where they lived), so counting only the
 * living is what frees their room.
 */
export function residentsByHome(living: ReadonlyArray<Pick<AgentRow, 'home'>>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const a of living) if (a.home != null) counts.set(a.home, (counts.get(a.home) ?? 0) + 1);
  return counts;
}

/** Houses nobody lives in: what a newcomer can move into without sharing with strangers. */
export function emptyHomes(locs: readonly LocationRow[], counts: ReadonlyMap<number, number>): LocationRow[] {
  return locs.filter((l) => l.type === 'home' && (counts.get(l.id) ?? 0) === 0).sort((a, b) => a.id - b.id);
}

/**
 * Where a newcomer can live: an empty house first (a stranger moving into a
 * family's home is its own story, not a default), then a house with a spare
 * bed, then — unless `emptyOnly` — lodging at the tavern. Null when none.
 */
export function findHousing(
  locs: readonly LocationRow[],
  living: ReadonlyArray<Pick<AgentRow, 'home'>>,
  opts: { emptyOnly?: boolean } = {},
): Housing | null {
  const counts = residentsByHome(living);
  const empty = emptyHomes(locs, counts)[0];
  if (empty) return { location: empty, lodging: false };
  if (opts.emptyOnly) return null;
  const withRoom = locs
    .filter((l) => l.type === 'home' && (counts.get(l.id) ?? 0) < l.capacity)
    .sort((a, b) => a.id - b.id)[0];
  if (withRoom) return { location: withRoom, lodging: false };
  for (const type of LODGING_TYPES) {
    const inn = locs.filter((l) => l.type === type).sort((a, b) => a.id - b.id)[0];
    if (inn) return { location: inn, lodging: true };
  }
  return null;
}

// ─── The town edge ───────────────────────────────────────────────────────────

/**
 * Where the road leaves town: the road tile closest to the map border, as a
 * pixel point. Arrivals walk in from here and leavers walk out to it, so both
 * are seen on the road rather than popping into (or out of) a doorway. Towns
 * whose roads stop short of the border use the outermost road tile — that is
 * still where the town ends. A world with no road tiles (old saves, tests)
 * falls back to the middle of the southern border, inside the worldgen margin.
 */
export function townEdgePoint(world: { map_width: number; map_height: number; road_tiles?: Point[] | null }): Point {
  const tile = CONFIG.MOVEMENT.TILE_SIZE;
  const w = Math.max(1, world.map_width);
  const h = Math.max(1, world.map_height);
  let best: Point | null = null;
  let bestD = Infinity;
  for (const r of world.road_tiles ?? []) {
    const d = Math.min(r.x, r.y, w - 1 - r.x, h - 1 - r.y);
    // Ties broken by position so the edge doesn't depend on array order.
    if (d < bestD || (d === bestD && best && (r.y > best.y || (r.y === best.y && r.x < best.x)))) {
      best = r;
      bestD = d;
    }
  }
  const t = best ?? { x: Math.floor(w / 2), y: Math.max(0, h - 3) };
  return { x: t.x * tile + tile / 2, y: t.y * tile + tile / 2 };
}

// ─── createResident ──────────────────────────────────────────────────────────

/** Workplaces a newcomer takes over when nobody runs them (setup.ts `ownerJobs`, minus 'retired'). */
const OWNER_JOBS = new Set(['shopkeeper', 'doctor', 'mayor', 'farmer', 'baker', 'bartender', 'handyperson', 'constable']);

/** Aspirations a newcomer may bring (goalPrompts AMBITION_CATEGORIES, minus the dark ones). */
const NEWCOMER_ASPIRATIONS = ['wealth', 'love', 'freedom', 'knowledge', 'legacy', 'pleasure'] as const;

/**
 * How much of a structural tie a newcomer starts with. The seeded cast has
 * known their housemates and coworkers for years (lib/startingTies.ts); a
 * newcomer has been introduced once. The friendship stays above 10 — the
 * decisions phase's "worth walking over to" floor — so a newcomer is not
 * friendless on day one; familiarity stays at 5+ so the first chat is not an
 * LLM "first meeting" for every housemate at once.
 */
export const NEWCOMER_TIE_SCALE = { friendship: 0.6, trust: 0.5, familiarity: 0.5 } as const;

export interface CreateResidentOptions {
  name: string;
  /** Blank = a template bio (lib/newResident.ts). */
  bio?: string;
  traits?: string[];
  job: string;
  /** Known gender (a generated arrival); guessed from the first name otherwise. */
  gender?: 'female' | 'male';
  /**
   * Where they appear: at their own door (the player's New Resident), or on
   * the road at the town edge, walking home (a town-generated arrival).
   */
  arriveAt?: 'home' | 'edge';
  /** Only an empty house will do (town-generated arrivals never lodge or share). */
  emptyHomeOnly?: boolean;
  /** Who brought them, for `life:arrived` listeners. */
  source: 'player' | 'town';
}

export type CreateResidentResult =
  | { ok: true; agentId: number; homeId: number; homeName: string; lodging: boolean; workplaceId: number | null; jobTitle: string }
  | { ok: false; reason: string };

/** Living residents right now. */
export function livingCount(): number {
  return db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().length;
}

/**
 * The first-person line a newcomer starts with. The seeded cast carries
 * authored backstory memories; without one a newcomer's first reflection had
 * nothing of their own to start from. Template text, no LLM: arrivals are
 * decided in the tick.
 */
export function newcomerBackstory(p: { jobTitle: string; job: string; lodging: boolean; homeName: string; tieNames: string[] }): string {
  const work = p.job === 'unemployed' || p.job === 'retired' || !p.job
    ? p.job === 'retired' ? 'to spend my quiet years somewhere new' : 'hoping to find work and a fresh start'
    : `to work as ${/^[aeiou]/i.test(p.jobTitle) ? 'an' : 'a'} ${p.jobTitle.toLowerCase()}`;
  const where = p.lodging ? `For now I'm lodging at ${p.homeName}.` : `I've taken ${p.homeName}.`;
  const people = p.tieNames.length === 0
    ? "I don't know a soul here yet."
    : `I don't know anyone well yet, though ${p.tieNames.slice(0, 2).join(' and ')} ${p.tieNames.length === 1 ? 'seems' : 'seem'} friendly.`;
  return `I left my old life behind and came to this town ${work}. ${where} ${people}`;
}

/**
 * Build a complete resident: agent row, needs, economy, aspiration, starting
 * ties with the people they will live and work beside, a backstory memory, a
 * home (named after them) — everything `seedWorld` gives the starting cast.
 * One transaction: a failure leaves no half-made person behind.
 */
export function createResident(opts: CreateResidentOptions): CreateResidentResult {
  const name = opts.name.trim();
  if (!name) return { ok: false, reason: 'A resident needs a name' };
  const job = opts.job.trim().toLowerCase() || 'unemployed';

  const world = db.select().from(worldState).get();
  if (!world) return { ok: false, reason: 'World not initialized' };

  const living = db.select().from(agents).where(eq(agents.is_active, true)).all();
  if (living.length >= CONFIG.MAX_AGENTS) {
    return { ok: false, reason: `Maximum agents reached (${CONFIG.MAX_AGENTS})` };
  }
  const allLocations = db.select().from(locations).all();
  const housing = findHousing(allLocations, living, { emptyOnly: opts.emptyHomeOnly });
  if (!housing) return { ok: false, reason: 'No available housing' };
  const home = housing.location;

  const workplace = workplaceForJob(job, allLocations);
  const worldSeedRaw = (world.setup_config as { worldgen?: { seed?: unknown } } | null)?.worldgen?.seed;
  const worldSeed = typeof worldSeedRaw === 'string' || typeof worldSeedRaw === 'number' ? worldSeedRaw : 'world';
  const profile = generateNewResident({
    name,
    bio: opts.bio ?? '',
    traits: opts.traits ?? [],
    job,
    worldSeed,
    gender: opts.gender,
    availableLocationTypes: [...new Set(allLocations.map((l) => l.type))],
  });

  // CLOCK: `now` is the TICK clock (agents.created_at, memories); `nowMinutes`
  // is GAME MINUTES (action_started, needs.last_updated, economy.last_payday).
  const now = (world.time as { totalTicks?: number }).totalTicks ?? 0;
  const nowMinutes = gameMinutes(world.time);
  const door = home.entry_point as Point;
  const atEdge = opts.arriveAt === 'edge';
  const edge = atEdge ? townEdgePoint(world) : null;

  let agentId = 0;
  const tieNames: string[] = [];

  db.transaction(() => {
    agentId = Number(db.insert(agents).values({
      name,
      bio: profile.bio,
      traits: profile.traits,
      personality: profile.personality,
      age: profile.age,
      gender: profile.gender,
      // Resident art is generated from the name when the sheet is missing
      // (src/lib/residentArt), so 'default' draws a person, not a placeholder.
      sprite_sheet: 'default',
      portrait_sprite: 'default',
      position: edge ?? { x: door.x, y: door.y },
      // Walking in: movement.ts routes them from the road to their door and
      // runs the arrival bookkeeping (occupants, `agent:arrived`) on the way.
      current_destination: edge ? { x: door.x, y: door.y, locationId: home.id } : null,
      current_location: edge ? null : home.id,
      current_action: edge ? { type: 'walking', to: { x: door.x, y: door.y } } : { type: 'idle' },
      action_started: nowMinutes,
      action_duration: null,
      action_queue: [],
      current_path: null,
      schedule: profile.schedule,
      home: home.id,
      workplace: workplace ? workplace.id : null,
      created_at: now,
      is_active: true,
    }).run().lastInsertRowid);

    // A reused rowid (SQLite hands the highest id out again once its row is
    // deleted) must not inherit a stranger's ties or aspirations.
    db.delete(relationships).where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId))).run();
    db.delete(aspirations).where(eq(aspirations.agent_id, agentId)).run();
    db.delete(needs).where(eq(needs.agent_id, agentId)).run();
    db.delete(economy).where(eq(economy.agent_id, agentId)).run();

    if (!edge) {
      db.update(locations)
        .set({ current_occupants: [...new Set([...(home.current_occupants as number[]), agentId])] })
        .where(eq(locations.id, home.id))
        .run();
    }

    db.insert(needs).values({
      agent_id: agentId,
      ...profile.needs,
      decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES },
      thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
      mood_modifiers: [],
      // CLOCK: GAME MINUTES — mood modifiers' `expiresAt` derives from it.
      last_updated: nowMinutes,
    }).run();

    db.insert(economy).values({
      agent_id: agentId,
      job,
      job_title: profile.jobTitle,
      // One wage table for everyone (data/jobs.ts), newcomers included.
      salary: jobSalary(job),
      work_performance: 0.7,
      money: CONFIG.ECONOMY.STARTING_MONEY,
      daily_expenses: CONFIG.ECONOMY.DAILY_EXPENSES.min,
      inventory: [],
      // CLOCK: GAME MINUTES. Stamped now: a newcomer is paid at their next
      // shift end, not on arrival.
      last_payday: nowMinutes,
      production_remainder: 0,
    }).run();

    // Seeded like the rest of the profile: the same arrival in the same town
    // wants the same thing.
    const rng = makeRng(stringToSeed(`aspiration|${worldSeed}|${name.toLowerCase()}`));
    db.insert(aspirations).values({
      agent_id: agentId,
      type: rng.pick(NEWCOMER_ASPIRATIONS),
      intensity: Math.round((0.4 + rng.next() * 0.3) * 100) / 100,
      status: 'active',
      adopted_at: nowMinutes,
      trigger: 'initial',
    }).run();

    // A town nobody runs: the newcomer who came to fill the trade takes it on.
    if (workplace && OWNER_JOBS.has(job)) {
      const owner = workplace.owner != null ? living.find((a) => a.id === workplace.owner) : undefined;
      if (!owner) db.update(locations).set({ owner: agentId }).where(eq(locations.id, workplace.id)).run();
    }

    // Starting ties: the same structural rule as the seeded cast, lightened.
    const locName = new Map(allLocations.map((l) => [l.id, l.name]));
    const cast: StartingTieAgent[] = living.map((a) => ({
      name: `#${a.id}`,
      homeName: locName.get(a.home) ?? `#home${a.home}`,
      workplaceName: a.workplace != null ? locName.get(a.workplace) ?? null : null,
      personality: a.personality as { warmth?: number } | null,
    }));
    const me = `#${agentId}`;
    cast.push({
      name: me,
      homeName: home.name,
      workplaceName: workplace?.name ?? null,
      personality: profile.personality,
    });
    // Lodgers at the tavern have no door of their own: no neighbours, only
    // whoever works or lodges there.
    const homeDoors = new Map<string, Point>();
    for (const l of allLocations) if (l.type === 'home') homeDoors.set(l.name, l.entry_point as Point);
    const byId = new Map(living.map((a) => [a.id, a]));
    for (const tie of buildStartingTies(cast, homeDoors)) {
      if (tie.a !== me && tie.b !== me) continue;
      const otherId = Number((tie.a === me ? tie.b : tie.a).slice(1));
      const mine = tie.a === me;
      const light = (v: number, scale: number, floor: number) => Math.max(floor, Math.round(v * scale));
      const fMine = light(mine ? tie.friendshipAB : tie.friendshipBA, NEWCOMER_TIE_SCALE.friendship, 11);
      const fTheirs = light(mine ? tie.friendshipBA : tie.friendshipAB, NEWCOMER_TIE_SCALE.friendship, 11);
      const trust = Math.round(tie.trustAB * NEWCOMER_TIE_SCALE.trust);
      const lo = Math.min(agentId, otherId);
      const hi = Math.max(agentId, otherId);
      const iAmLo = agentId === lo;
      db.insert(relationships).values({
        agent_a: lo,
        agent_b: hi,
        friendship_ab: iAmLo ? fMine : fTheirs,
        friendship_ba: iAmLo ? fTheirs : fMine,
        romance_ab: 0,
        romance_ba: 0,
        trust_ab: trust,
        trust_ba: trust,
        familiarity: light(tie.familiarity, NEWCOMER_TIE_SCALE.familiarity, 5),
        interaction_count: 0,
        last_interaction: Date.now(),
        last_interaction_minute: nowMinutes,
        status_since_minute: nowMinutes,
        average_interaction_sentiment: 0,
        tags: [...tie.tags],
        status: tie.status,
        created_at: Date.now(),
        last_updated: Date.now(),
      }).run();
      const other = byId.get(otherId);
      if (other) tieNames.push(other.name.split(' ')[0]);
    }

    // The house is named after who lives there now ("Rosa's cottage" → "the
    // Ortega house"). Lodging keeps the tavern's name.
    if (!housing.lodging) nameHomes(sqlite, { homeIds: [home.id] });
  });

  const homeName = db.select({ name: locations.name }).from(locations).where(eq(locations.id, home.id)).get()?.name ?? home.name;

  // Through the memory service (not a raw insert) so it is embedded and
  // retrievable from the first conversation, like any memory made in play.
  memoryService.record(
    agentId,
    'observation',
    newcomerBackstory({ jobTitle: profile.jobTitle, job, lodging: housing.lodging, homeName, tieNames }),
    { subtype: 'backstory', tags: ['backstory'] },
    0.3,
    8,
  );

  simEvents.emit('life:arrived', { agentId, name, homeId: home.id, source: opts.source, lodging: housing.lodging });
  emitter.markDirty('agents.all');
  emitter.markDirty('world.state');

  return {
    ok: true,
    agentId,
    homeId: home.id,
    homeName,
    lodging: housing.lodging,
    workplaceId: workplace?.id ?? null,
    jobTitle: profile.jobTitle,
  };
}

// ─── retireResident ──────────────────────────────────────────────────────────

export type RetireReason = 'death' | 'left' | 'removed';

/**
 * Take a resident out of the running town, whatever the reason. What used to
 * be `deactivateAgent` in lifeEventsEngine (death) and a smaller copy in
 * `nudge.remove_agent`:
 *
 *   - the row goes inactive and stops moving (`dead` for a death, so the
 *     canvas and the Story tab read it; `idle` otherwise);
 *   - out of every building's occupant list, and their interior zone slot
 *     released — `zoneOccupancy.leave` only runs on a location change, and a
 *     retired resident never moves again, so the slot (a bed, a stool) counted
 *     against the zone for the rest of the run;
 *   - their states cleared, conversations ended (anyone left "talking" to them
 *     set idle) and queued conversations dropped;
 *   - today's plan dropped (DB and cache) so no pending decomposition acts on
 *     them;
 *   - places they owned handed to their closest living friend (or nobody).
 *
 * Their home frees itself: residency is counted from the living only
 * (`residentsByHome`). The house keeps its name — "Rosa's cottage" still
 * stands after Rosa has gone — until someone new moves in.
 *
 * Emits `life:departed` for a resident who left or was removed. A death is
 * announced by `processAgentDeath` as `life:death` once its whole pipeline
 * (funeral, inheritance) has run.
 */
export function retireResident(agentId: number, reason: RetireReason): boolean {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || !agent.is_active) return false;

  db.update(agents).set({
    is_active: false,
    current_action: { type: reason === 'death' ? 'dead' : 'idle' },
    current_destination: null,
    current_path: null,
    action_queue: [],
    action_duration: null,
    daily_plan: null,
  }).where(eq(agents.id, agentId)).run();
  planCache.invalidate(agentId);

  for (const loc of db.select({ id: locations.id, current_occupants: locations.current_occupants }).from(locations).all()) {
    const occupants = loc.current_occupants as number[];
    if (!occupants.includes(agentId)) continue;
    db.update(locations).set({ current_occupants: occupants.filter((id) => id !== agentId) })
      .where(eq(locations.id, loc.id)).run();
  }
  zoneOccupancy.leave(agentId);

  db.delete(agentStates).where(eq(agentStates.agent_id, agentId)).run();

  for (const convo of db.select().from(conversations).where(eq(conversations.status, 'active')).all()) {
    const participants = convo.participants as number[];
    if (!participants.includes(agentId)) continue;
    // conversations.ended_at is wall-clock ms everywhere else.
    db.update(conversations).set({ status: 'ended', ended_at: Date.now() })
      .where(eq(conversations.id, convo.id)).run();
    for (const pid of participants) {
      if (pid === agentId) continue;
      const other = db.select({ current_action: agents.current_action, is_active: agents.is_active })
        .from(agents).where(eq(agents.id, pid)).get();
      if (other?.is_active && (other.current_action as { type?: string } | null)?.type === 'talking') {
        db.update(agents).set({ current_action: { type: 'idle' }, action_duration: null })
          .where(eq(agents.id, pid)).run();
      }
    }
  }

  const queued = db.select({ id: conversationQueue.id, participants: conversationQueue.participants })
    .from(conversationQueue).all()
    .filter((q) => (q.participants as number[]).includes(agentId))
    .map((q) => q.id);
  if (queued.length > 0) db.delete(conversationQueue).where(inArray(conversationQueue.id, queued)).run();

  handOverOwnedPlaces(agentId);

  if (reason !== 'death') {
    simEvents.emit('life:departed', { agentId, name: agent.name, reason, homeId: agent.home });
  }
  emitter.markDirty('agents.all');
  emitter.markDirty('conversations');
  return true;
}

/**
 * Places the resident owned go to their closest living friend, or to nobody
 * (a newcomer in the trade takes an unowned workplace, see createResident).
 * Was death-only (`handleJobVacancy`); a shopkeeper who moved away left the
 * shop owned by someone who no longer existed, so its till and wages went
 * nowhere.
 */
function handOverOwnedPlaces(agentId: number): void {
  const owned = db.select({ id: locations.id }).from(locations).where(eq(locations.owner, agentId)).all();
  if (owned.length === 0) return;

  const rels = db.select().from(relationships).where(
    or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId)),
  ).all();
  let heir: number | null = null;
  let best = 0;
  for (const rel of rels) {
    const otherId = rel.agent_a === agentId ? rel.agent_b : rel.agent_a;
    // The other's feeling toward the one leaving.
    const friendship = rel.agent_a === otherId ? rel.friendship_ab : rel.friendship_ba;
    if (friendship <= best) continue;
    const other = db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, otherId)).get();
    if (!other?.is_active) continue;
    heir = otherId;
    best = friendship;
  }
  for (const loc of owned) {
    db.update(locations).set({ owner: heir }).where(eq(locations.id, loc.id)).run();
  }
}

/** Both halves of a relationship row as seen from `agentId` (their feeling toward the other, and back). */
export function feelingsToward(rel: typeof relationships.$inferSelect, agentId: number): { mine: number; theirs: number; otherId: number } {
  const isA = rel.agent_a === agentId;
  return {
    mine: isA ? rel.friendship_ab : rel.friendship_ba,
    theirs: isA ? rel.friendship_ba : rel.friendship_ab,
    otherId: isA ? rel.agent_b : rel.agent_a,
  };
}

/** Relationship rows of one resident with other LIVING residents. */
export function livingTiesOf(agentId: number): Array<typeof relationships.$inferSelect> {
  const rows = db.select().from(relationships)
    .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId))).all();
  if (rows.length === 0) return [];
  const others = rows.map((r) => (r.agent_a === agentId ? r.agent_b : r.agent_a));
  const alive = new Set(db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.is_active, true), inArray(agents.id, others))).all().map((r) => r.id));
  return rows.filter((r) => alive.has(r.agent_a === agentId ? r.agent_b : r.agent_a));
}

