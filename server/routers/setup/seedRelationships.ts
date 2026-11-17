/**
 * Seeding step 6: the starting relationships, staged pair by pair (structural
 * ties, authored rows, the scenario, the opening hooks), sanitised by the
 * adults-only rule and inserted; then each agent's orientation, which reads them.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, relationships } from '../../db/schema';
import { HOOK_VALUES } from '../../lib/dramaHooks';
import { gameMinutes } from '../../lib/gameClock';
import { assignOrientations } from '../../lib/intimacy/orientation';
import { adultIdSet, sanitizeSeedRomance } from '../../lib/intimacy/seedRomance';
import { buildStartingTies } from '../../lib/startingTies';
import { clamp } from '../../lib/utils';
import { forkRng } from '../../lib/worldgen/rng';
import type { Scenario, SeedContext } from './seedContext';

/** A relationship row being assembled by the step-6 staging passes, before insert. */
interface StagedRel {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  romance_ab: number;
  romance_ba: number;
  trust_ab: number;
  trust_ba: number;
  familiarity: number;
  tags: string[];
  status: string;
}

/** The staged rows, keyed by `pairKey`. */
type StagedRels = Map<string, StagedRel>;

/** Agent index in `config.agents` → agent id, or undefined when that agent was not seeded. */
type AgentIdOf = (agentIdx: number) => number | undefined;

/** The staging key of a pair, the same whichever way round it is given. */
function pairKey(a: number, b: number): string {
  return `${Math.min(a, b)}:${Math.max(a, b)}`;
}

/**
 * Fetch or create the row for a pair, always stored with `agent_a < agent_b`.
 * Every reader normalises with Math.min/Math.max before querying, so a row
 * stored the other way round is invisible to the engine.
 */
function relFor(staged: StagedRels, x: number, y: number): StagedRel {
  const key = pairKey(x, y);
  const existing = staged.get(key);
  if (existing) return existing;
  const fresh: StagedRel = {
    agent_a: Math.min(x, y),
    agent_b: Math.max(x, y),
    friendship_ab: 0,
    friendship_ba: 0,
    romance_ab: 0,
    romance_ba: 0,
    trust_ab: 0,
    trust_ba: 0,
    familiarity: 5,
    tags: [],
    status: 'acquaintance',
  };
  staged.set(key, fresh);
  return fresh;
}

/** Write a directional field, respecting canonical pair order. */
function setDirectional(
  row: StagedRel,
  from: number,
  field: 'friendship' | 'romance' | 'trust',
  apply: (current: number) => number,
): void {
  const key = (from === row.agent_a ? `${field}_ab` : `${field}_ba`) as keyof StagedRel;
  (row[key] as number) = apply(row[key] as number);
}

/**
 * Step 6: stage every starting relationship (structural ties, authored rows,
 * the scenario), apply the adults-only rule, and insert. Returns the inserted
 * rows for orientation assignment and the adult ids the secret steps check.
 */
export function seedRelationships(ctx: SeedContext): { stagedRows: StagedRel[]; adultIds: Set<number> } {
  // 6. Insert relationships from config, with the scenario folded in.
  //
  // Rows are staged in a map first because the scenario's trust delta, romance
  // threads and rival pairs all edit pairs that may or may not appear in
  // `config.relationships`, and `idx_relationships_pair` is unique — a second
  // INSERT for the same pair would throw and roll the whole seed back.
  const staged: StagedRels = new Map<string, StagedRel>();

  const structuralTags = stageStructuralTies(ctx, staged);
  stageAuthoredRelationships(ctx, staged, structuralTags);
  if (ctx.scenario) stageScenarioRelationships(ctx, ctx.scenario, staged);

  const { stagedRows, adultIds } = sanitizeStagedRelationships(ctx, staged);
  insertStagedRelationships(ctx, stagedRows);
  return { stagedRows, adultIds };
}

/**
 * Step 6a: stage housemates, coworkers and neighbours. Returns each tie's
 * structural tags by pair key, which the authored rows keep alongside theirs.
 */
function stageStructuralTies(ctx: SeedContext, staged: StagedRels): Map<string, string[]> {
  const { config, agentMap } = ctx;
  const dynamicLocations = ctx.genResult.locations;

  // 6a. Structural ties first: housemates, coworkers and next-door neighbours
  //     already know each other (lib/startingTies.ts has the why). Staged before
  //     the authored rows so those overwrite the values, and before the scenario
  //     so the trust slider calibrates these too and a scenario rivalry can
  //     still sour a household.
  const homeDoors = new Map<string, { x: number; y: number }>();
  for (const loc of dynamicLocations) {
    if (loc.type === 'home') homeDoors.set(loc.name, loc.entry_point);
  }
  const structuralTags = new Map<string, string[]>();
  for (const tie of buildStartingTies(config.agents, homeDoors)) {
    const aId = agentMap.get(tie.a);
    const bId = agentMap.get(tie.b);
    if (aId === undefined || bId === undefined) continue;
    const row = relFor(staged, aId, bId);
    const flipped = aId > bId;
    row.friendship_ab = flipped ? tie.friendshipBA : tie.friendshipAB;
    row.friendship_ba = flipped ? tie.friendshipAB : tie.friendshipBA;
    row.trust_ab = flipped ? tie.trustBA : tie.trustAB;
    row.trust_ba = flipped ? tie.trustAB : tie.trustBA;
    row.familiarity = tie.familiarity;
    row.status = tie.status;
    row.tags = [...tie.tags];
    structuralTags.set(pairKey(aId, bId), tie.tags);
  }
  return structuralTags;
}

/** Step 6b: stage the wizard's (or saved config's) relationship rows over the structural ties. */
function stageAuthoredRelationships(
  ctx: SeedContext,
  staged: StagedRels,
  structuralTags: ReadonlyMap<string, string[]>,
): void {
  const { config, agentMap } = ctx;

  // 6b. Authored rows (wizard / saved config). Their values win outright; only
  //     the structural tags are kept alongside theirs, since "they share a house"
  //     is still true of two rivals.
  for (const relCfg of config.relationships) {
    const agentAId = agentMap.get(relCfg.agentAName);
    const agentBId = agentMap.get(relCfg.agentBName);
    if (agentAId === undefined || agentBId === undefined) continue;

    const row = relFor(staged, agentAId, agentBId);
    // `*AB` in the config means "A's feeling toward B". If the config listed the
    // pair in the opposite order to the canonical one, the directional halves
    // swap with it.
    const flipped = agentAId > agentBId;
    row.friendship_ab = flipped ? relCfg.friendshipBA : relCfg.friendshipAB;
    row.friendship_ba = flipped ? relCfg.friendshipAB : relCfg.friendshipBA;
    row.romance_ab = flipped ? relCfg.romanceBA : relCfg.romanceAB;
    row.romance_ba = flipped ? relCfg.romanceAB : relCfg.romanceBA;
    row.trust_ab = flipped ? relCfg.trustBA : relCfg.trustAB;
    row.trust_ba = flipped ? relCfg.trustAB : relCfg.trustBA;
    row.familiarity = relCfg.familiarity;
    row.tags = [...new Set([...relCfg.tags, ...(structuralTags.get(pairKey(agentAId, agentBId)) ?? [])])];
    row.status = relCfg.status;
  }
}

/**
 * The scenario's part of step 6: the trust slider's calibration, the romance
 * threads, the rival pairs, then the opening hooks, which are applied last so
 * they win.
 */
function stageScenarioRelationships(ctx: SeedContext, scenario: Scenario, staged: StagedRels): void {
  const { config, agentMap } = ctx;
  const idOf: AgentIdOf = (agentIdx: number): number | undefined =>
    agentMap.get(config.agents[agentIdx]?.name ?? '');

  // The trust slider shifts the whole town's baseline, so it only touches
  // pairs that already exist — it is a calibration, not a relationship source.
  if (scenario.trustDelta !== 0) {
    for (const row of staged.values()) {
      row.trust_ab = clamp(row.trust_ab + scenario.trustDelta, -100, 100);
      row.trust_ba = clamp(row.trust_ba + scenario.trustDelta, -100, 100);
    }
  }

  for (const thread of scenario.romanceThreads) {
    for (const rv of thread.romance_values) {
      const from = idOf(rv.from);
      const to = idOf(rv.to);
      if (from === undefined || to === undefined || from === to) continue;
      const row = relFor(staged, from, to);
      setDirectional(row, from, 'romance', () => clamp(rv.value, 0, 100));
      row.familiarity = Math.max(row.familiarity, 40);
      if (!row.tags.includes('romantic')) row.tags.push('romantic');
    }
    for (const fd of thread.friendship_deltas) {
      const from = idOf(fd.from);
      const to = idOf(fd.to);
      if (from === undefined || to === undefined || from === to) continue;
      setDirectional(relFor(staged, from, to), from, 'friendship', (c) => clamp(c + fd.delta, -100, 100));
    }
    for (const td of thread.trust_deltas) {
      const from = idOf(td.from);
      const to = idOf(td.to);
      if (from === undefined || to === undefined || from === to) continue;
      setDirectional(relFor(staged, from, to), from, 'trust', (c) => clamp(c + td.delta, -100, 100));
    }
  }

  for (const [ai, bi] of scenario.rivalPairs) {
    const a = idOf(ai);
    const b = idOf(bi);
    if (a === undefined || b === undefined || a === b) continue;
    const row = relFor(staged, a, b);
    row.friendship_ab = clamp(Math.min(row.friendship_ab, -35), -100, 100);
    row.friendship_ba = clamp(Math.min(row.friendship_ba, -35), -100, 100);
    row.trust_ab = clamp(Math.min(row.trust_ab, -30), -100, 100);
    row.trust_ba = clamp(Math.min(row.trust_ba, -30), -100, 100);
    row.familiarity = Math.max(row.familiarity, 45);
    row.status = 'rival';
    if (!row.tags.includes('rival')) row.tags.push('rival');
  }

  stageOpeningHookRelationships(scenario, staged, idOf);
}

/** The opening hooks' pairs: the couple and the pull outside it, the feud, the debt, the campaign. */
function stageOpeningHookRelationships(scenario: Scenario, staged: StagedRels, idOf: AgentIdOf): void {
  // The opening hooks (lib/dramaHooks.ts). Applied last so they win over
  // the authored rows and the slider's threads for the pairs they name.
  const { triangle, rivalry, debt, campaign } = scenario.hooks;
  const V = HOOK_VALUES;
  const addTags = (row: StagedRel, ...tags: string[]) => {
    for (const t of tags) if (!row.tags.includes(t)) row.tags.push(t);
  };
  if (triangle) {
    const [a, b] = triangle.spouses.map(idOf);
    const s = idOf(triangle.straying);
    const t = idOf(triangle.admirer);
    if (a !== undefined && b !== undefined && s !== undefined && t !== undefined) {
      // The couple: a marriage (or engagement) is a pair of tags the relationship
      // pass never derives or strips (lib/marriage.ts); `partner` is what code
      // asking "are they together?" reads. Romance over the partnership line so
      // an engaged pair also reads as partners on its numbers.
      const couple = relFor(staged, a, b);
      setDirectional(couple, a, 'romance', (c) => Math.max(c, V.spouseRomance[0]));
      setDirectional(couple, b, 'romance', (c) => Math.max(c, V.spouseRomance[1]));
      setDirectional(couple, a, 'friendship', (c) => Math.max(c, V.spouseMinFriendship));
      setDirectional(couple, b, 'friendship', (c) => Math.max(c, V.spouseMinFriendship));
      couple.familiarity = Math.max(couple.familiarity, 85);
      couple.status = 'partners';
      addTags(couple, triangle.bond, 'partner', 'romantic');
      // The pull outside it: half returned, below the partnership line, so the
      // exclusivity rule leaves them a crush (relationships.ts updateTags).
      const pull = relFor(staged, s, t);
      setDirectional(pull, s, 'romance', (c) => Math.max(c, V.strayRomance));
      setDirectional(pull, t, 'romance', (c) => Math.max(c, V.admirerRomance));
      setDirectional(pull, s, 'friendship', (c) => clamp(Math.max(c + 10, 15), -100, 100));
      setDirectional(pull, t, 'friendship', (c) => clamp(Math.max(c + 10, 15), -100, 100));
      pull.familiarity = Math.max(pull.familiarity, 45);
      pull.status = 'romantic_interest';
      addTags(pull, 'romantic');
    }
  }
  if (rivalry) {
    const [a, b] = rivalry.pair.map(idOf);
    if (a !== undefined && b !== undefined) {
      const row = relFor(staged, a, b);
      for (const from of [a, b]) {
        setDirectional(row, from, 'friendship', (c) => Math.min(c, V.rivalFriendship));
        setDirectional(row, from, 'trust', (c) => Math.min(c, V.rivalTrust));
      }
      row.familiarity = Math.max(row.familiarity, 60);
      row.status = 'rivals';
      // `rival` lapses above −50 (relationships.ts updateTags); `grudge` is
      // never derived, so the feud outlives a thaw until a real reconciliation
      // (conversationBeats.ts) lifts it. confrontationEngine reads both.
      addTags(row, 'rival', 'grudge');
    }
  }
  if (debt) {
    const d = idOf(debt.debtor);
    const c = idOf(debt.creditor);
    if (d !== undefined && c !== undefined) {
      const row = relFor(staged, d, c);
      setDirectional(row, c, 'friendship', (v) => clamp(Math.min(v + V.creditorFriendshipDelta, V.creditorFriendshipMax), -100, 100));
      setDirectional(row, c, 'trust', (v) => clamp(Math.min(v + V.creditorTrustDelta, V.creditorTrustMax), -100, 100));
      setDirectional(row, d, 'friendship', (v) => clamp(v - 5, -100, 100));
      row.familiarity = Math.max(row.familiarity, 40);
    }
  }
  if (campaign) {
    const x = idOf(campaign.challenger);
    const m = idOf(campaign.mayor);
    if (x !== undefined && m !== undefined) {
      const row = relFor(staged, x, m);
      setDirectional(row, x, 'friendship', (v) => clamp(v + V.challengerFriendshipDelta, -100, 100));
      setDirectional(row, x, 'trust', (v) => clamp(v + V.challengerTrustDelta, -100, 100));
      row.familiarity = Math.max(row.familiarity, 40);
    }
  }
}

/** The adults-only rule on the staged rows, in staging order. Also returns the adult ids. */
function sanitizeStagedRelationships(
  ctx: SeedContext,
  staged: StagedRels,
): { stagedRows: StagedRel[]; adultIds: Set<number> } {
  const { config, agentMap } = ctx;

  // The adults-only rule at seed time: whatever fed the staged rows (the wizard's
  // typed romance, the generator's threads, a scenario secret's companion tag) a
  // pair with a minor in it starts with no romance and no romantic tags/status.
  // Runs on the staged rows, before insert, so orientation assignment below reads
  // the sanitised values too (a minor's crush must not fix anyone's orientation).
  const seedAgents = config.agents.map((a) => ({ id: agentMap.get(a.name)!, age: a.age }));
  const stagedRows = sanitizeSeedRomance(seedAgents, [...staged.values()]);
  const adultIds = adultIdSet(seedAgents);
  return { stagedRows, adultIds };
}

/** Insert the sanitised relationship rows, in staging order (row ids are autoincrement). */
function insertStagedRelationships(ctx: SeedContext, stagedRows: ReadonlyArray<StagedRel>): void {
  const { config, now } = ctx;

  for (const row of stagedRows) {
    db.insert(relationships).values({
      ...row,
      interaction_count: 0,
      // Wall-clock column (Date.now()); decay reads the game-minute one below.
      last_interaction: now,
      // The decay clock: game time, starting with the world (inserted below).
      last_interaction_minute: gameMinutes({ day: config.world.startDay, hour: config.world.startHour, minute: 0 }),
      average_interaction_sentiment: 0,
      created_at: now,
      last_updated: now,
    }).run();
  }
}

/**
 * Step 6b (second): each agent's orientation, rolled from the one rng forked off
 * the world seed. Reads the sanitised relationship rows.
 */
export function seedOrientations(ctx: SeedContext, stagedRows: ReadonlyArray<StagedRel>): void {
  const { config, genResult, agentMap } = ctx;

  // 6b. Orientation, now that the romance threads exist: a scenario that pairs
  //     two men has made them each other's crush, and a free roll must not turn
  //     one of them straight afterwards (lib/intimacy/orientation.ts). Seeded from
  //     the world seed so Preview, Start and a later restart give the same town.
  const orientations = assignOrientations(
    config.agents.map((a) => ({ id: agentMap.get(a.name)!, gender: a.gender })),
    stagedRows,
    forkRng(genResult.seed, 'orientation'),
  );
  for (const [agentId, orientation] of orientations) {
    db.update(agents).set({ orientation }).where(eq(agents.id, agentId)).run();
  }
}
