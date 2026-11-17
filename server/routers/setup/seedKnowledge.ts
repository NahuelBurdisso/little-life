/**
 * Seeding steps 7-7c and 10b: what the town already knows and has been through.
 * Backstory memories, the default cast's secrets, the scenario's secrets, and
 * the opening hooks' history.
 */
import { db } from '../../db';
import { goals, memories, relationshipEvents, shared_knowledge } from '../../db/schema';
import { firstName } from '../../ai/names';
import type { DramaHooks } from '../../lib/dramaHooks';
import { mayKeepSeedSecret } from '../../lib/intimacy/seedRomance';
import type { Scenario, SeedContext, SetupConfig } from './seedContext';

/** Step 7: each agent's authored backstory plus the lines its opening hooks add. */
export function seedBackstoryMemories(ctx: SeedContext): void {
  const { config, scenario, agentMap } = ctx;

  // 7. Insert backstory memories from each agent's backstoryMemories, plus the
  //    lines the opening hooks add (a marriage, a debt, a grudge the authored
  //    backstory does not know about), so the model plays them from turn one.
  for (const [agentIdx, agentCfg] of config.agents.entries()) {
    const agentId = agentMap.get(agentCfg.name)!;
    const lines = [...agentCfg.backstoryMemories, ...(scenario?.hooks.memories[agentIdx] ?? [])];
    const memCount = lines.length;
    for (let i = 0; i < memCount; i++) {
      db.insert(memories).values({
        agent_id: agentId,
        description: lines[i],
        type: 'experience',
        importance: 8,
        emotional_valence: 0.3,
        embedding: null,
        depth: 0,
        created_at: 0 - (memCount - i) * 1000,
        last_accessed: 0,
        metadata: { tags: ['backstory'] },
        is_active: 1,
        parent_ids: [],
      }).run();
    }
  }
}

/** Step 7b: the default cast's authored secrets, written only when the named residents exist. */
export function seedDefaultCastDrama(ctx: SeedContext, adultIds: ReadonlySet<number>): void {
  const { agentMap, now } = ctx;

  // 7b. Seed initial drama shared_knowledge (only if matching agents exist)
  const diegoId = agentMap.get('Diego Santos');
  const luciaId = agentMap.get('Lucia Fernandez');
  const marcoId = agentMap.get('Marco Rivera');
  const rosaId = agentMap.get('Rosa Chen');
  const carlosId = agentMap.get('Carlos Mendez');
  const rayId = agentMap.get('Ray Kowalski');

  // The two crushes name Diego and Lucia; a renamed-in minor of either name keeps neither.
  if (diegoId && luciaId && marcoId && rosaId
    && mayKeepSeedSecret(adultIds, { type: 'crush', subjectId: diegoId, targetId: luciaId })) {
    db.insert(shared_knowledge).values({
      type: 'crush', subject_id: diegoId, target_id: luciaId,
      content: 'Diego Santos has a crush on Lucia Fernandez',
      sensitivity: 2, known_by: [diegoId, marcoId],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
    db.insert(shared_knowledge).values({
      type: 'crush', subject_id: luciaId, target_id: diegoId,
      content: 'Lucia Fernandez has a crush on Diego Santos',
      sensitivity: 2, known_by: [luciaId, rosaId],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  if (carlosId && marcoId) {
    db.insert(shared_knowledge).values({
      type: 'financial', subject_id: carlosId, target_id: null,
      content: 'Carlos Mendez is struggling with money',
      sensitivity: 1, known_by: [carlosId, marcoId],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }

  if (rayId && marcoId) {
    db.insert(shared_knowledge).values({
      type: 'secret_told', subject_id: rayId, target_id: marcoId,
      content: 'Ray Kowalski told Marco he was forced out of the city police after a disciplinary hearing — he hit a suspect during interrogation',
      sensitivity: 3, known_by: [rayId, marcoId],
      created_at: now, is_active: true, source: 'backstory',
    }).run();
  }
}

/** Step 7c: the scenario's secrets (slider secrets, romance-thread secrets, hook secrets), for any cast. */
export function seedScenarioSecrets(ctx: SeedContext, scenario: Scenario, adultIds: ReadonlySet<number>): void {
  const { config, agentMap, now } = ctx;

  // 7c. Scenario secrets. The block above is keyed to the default cast's names
  // and produces nothing for an edited or renamed town; these come from the
  // drama/crime sliders and work for any cast.
  const idOfAgent = (agentIdx: number | null): number | undefined =>
    agentIdx === null ? undefined : agentMap.get(config.agents[agentIdx]?.name ?? '');

  const scenarioSecrets = [
    ...scenario.secrets,
    ...scenario.romanceThreads.flatMap((t) => (t.secret ? [t.secret] : [])),
    ...scenario.hooks.secrets,
  ];

  for (const secret of scenarioSecrets) {
    const subjectId = idOfAgent(secret.subject_index);
    if (subjectId === undefined) continue;
    const targetId = idOfAgent(secret.target_index) ?? null;
    // A romantic secret (crush, affair, a sighting of one) never names a minor.
    // The generator already picks adults for these; this is the backstop for a
    // scenario built any other way.
    if (!mayKeepSeedSecret(adultIds, { ...secret, subjectId, targetId })) continue;

    const knownBy = [
      ...new Set(
        secret.known_by_indices
          .map((i) => idOfAgent(i))
          .filter((id): id is number => id !== undefined),
      ),
    ];
    // The generator decides who knows (setupGenerator.ts): for a sighting —
    // "A saw B sneaking out" — the fact is about B and only A knows, so B must
    // NOT be added here. This used to push the subject unconditionally, which
    // told every person who was seen that they had been seen (B17). Only a
    // secret nobody would know falls back to its subject.
    if (knownBy.length === 0) knownBy.push(subjectId);

    db.insert(shared_knowledge).values({
      type: secret.type,
      subject_id: subjectId,
      target_id: targetId,
      content: secret.content,
      sensitivity: secret.sensitivity,
      known_by: knownBy,
      // `now`, not 0: gossipTick expires theft/rumor/seduction/confession on
      // `Date.now() - created_at`, so a 0 here deactivates the secret on the
      // first pass — it reads as ~57 years old.
      created_at: now,
      is_active: true,
      source: 'backstory',
    }).run();
  }
}

// ─── Helper: the opening hooks' history ──────────────────────────────────────

/** A seeded pair's past as one `relationship_events` row (already applied: the values are in the row). */
const HOOK_HISTORY_EVENT = 'history';

/**
 * What the opening hooks leave behind besides relationships and facts: the
 * challenger's goal, and one already-processed `relationship_events` row per
 * hook pair. Story arcs are built from those events (chronicle.ts drops a pair
 * with none), so without them a town opened with a marriage in trouble and a
 * feud showed an empty Chronicle and no arcs on the Meet-the-town cards until
 * something happened on screen.
 */
export function seedHookHistory(
  config: SetupConfig,
  hooks: DramaHooks,
  agentMap: ReadonlyMap<string, number>,
  now: number,
  startMinute: number,
): void {
  const idOf = (i: number) => agentMap.get(config.agents[i]?.name ?? '');
  const first = (i: number) => firstName(config.agents[i]?.name ?? '');
  const history = (x: number, y: number, description: string, sentiment: number) => {
    const a = idOf(x);
    const b = idOf(y);
    if (a === undefined || b === undefined || a === b) return;
    db.insert(relationshipEvents).values({
      agent_a: Math.min(a, b), agent_b: Math.max(a, b), event_type: HOOK_HISTORY_EVENT, description,
      friendship_delta_ab: 0, friendship_delta_ba: 0, romance_delta_ab: 0, romance_delta_ba: 0,
      trust_delta_ab: 0, trust_delta_ba: 0, sentiment, processed: true, timestamp: now,
    }).run();
  };

  const { triangle, rivalry, debt, campaign } = hooks;
  if (triangle) {
    const [a, b] = triangle.spouses;
    history(a, b, triangle.bond === 'married'
      ? `${first(a)} and ${first(b)} have been married for years`
      : `${first(a)} and ${first(b)} are engaged to be married`, 0.4);
    history(triangle.straying, triangle.admirer,
      `${first(triangle.admirer)} and ${first(triangle.straying)} keep finding reasons to be in the same room`, 0.3);
  }
  if (rivalry) {
    const [a, b] = rivalry.pair;
    history(a, b, `${first(a)} and ${first(b)} have not had a civil word since ${rivalry.reason}`, -0.6);
  }
  if (debt) {
    history(debt.debtor, debt.creditor, `${first(debt.debtor)} owes ${first(debt.creditor)} money and has stopped coming round`, -0.4);
  }
  if (campaign) {
    const challengerId = idOf(campaign.challenger);
    const mayorId = idOf(campaign.mayor);
    if (challengerId !== undefined && mayorId !== undefined) {
      // A custom goal: nothing in the registry abandons it by rule, so it
      // stands until the morning review or the election settles it (the
      // campaign itself opens on its own, townCalendar.ts).
      db.insert(goals).values({
        agent_id: challengerId, type: 'custom', target_id: mayorId,
        motivation: 'ambition:unseat_mayor', priority: 0.8, progress: 0, status: 'active',
        created_at: startMinute, description: campaign.goal,
        strategy: 'Win people over one by one: buy a round, lend a hand, listen for what the mayor gets wrong',
        mapped_interactions: JSON.stringify(['befriend', 'buy_drinks', 'eavesdrop']),
        pivot_count: 0, source: 'backstory',
      }).run();
    }
  }
}
