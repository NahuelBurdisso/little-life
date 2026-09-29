import { db } from '../db';
import { agents, relationships, relationshipEvents } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { getEffectivePersonality } from './states';
import { createFact } from './gossip';
import { SECRETS_POOL } from '../data/secretsPool';

// ─── Secret Sharing System ────────────────────────────────────────────────────
// After deep conversations (6+ turns) between trusting agents, there's a chance
// one shares a personal secret. This creates vulnerability and deepens bonds.
// If the secret is later betrayed (spread as gossip), massive trust damage.

// Track which secrets agents have shared (prevent duplicate sharing)
const sharedSecrets = new Map<number, Set<string>>(); // agentId → set of secret IDs

let initialized = false;

/**
 * Drop shared-secret bookkeeping for a world replace (agent ids are reused).
 * Does not reset `initialized` — the simEvents listeners must stay registered
 * exactly once.
 */
export function clearSharedSecrets(): void {
  sharedSecrets.clear();
}

function initSecretSharing(): void {
  if (initialized) return;
  initialized = true;

  simEvents.on('conversation:ended', (payload: {
    agentId: number;
    perpetratorId?: number | null;
    sentiment?: number;
    turns?: number;
  }) => {
    const otherId = payload.perpetratorId;
    if (!otherId || otherId === payload.agentId) return;

    const turns = payload.turns ?? 0;
    const sentiment = payload.sentiment ?? 0;

    // Only deep, positive conversations
    if (turns < 6 || sentiment < 0.3) return;

    // Check trust level between agents
    const a = Math.min(payload.agentId, otherId);
    const b = Math.max(payload.agentId, otherId);
    const rel = db.select().from(relationships)
      .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
      .get();
    if (!rel) return;

    const isA = a === payload.agentId;
    const trust = isA ? rel.trust_ab : rel.trust_ba;
    const friendship = isA ? rel.friendship_ab : rel.friendship_ba;

    // Need high trust and friendship
    if (trust < 40 || friendship < 30) return;

    // Personality check: honest agents share more, secretive less
    const personality = getEffectivePersonality(payload.agentId);
    if (!personality) return;

    let shareChance = 0.08; // base 8%
    shareChance += (personality.honesty - 50) * 0.002;  // honest = shares more
    shareChance += (trust - 40) * 0.002;                // higher trust = shares more
    shareChance += (personality.warmth - 50) * 0.001;    // warm = shares more
    if (personality.neuroticism > 60) shareChance += 0.03; // neurotic = needs to vent

    if (Math.random() > shareChance) return;

    // Pick a secret this agent hasn't shared yet
    const agentSecrets = sharedSecrets.get(payload.agentId) ?? new Set();
    // Only secrets about the sharer alone: a {target} template would put a
    // made-up claim about a third resident into circulation.
    const availableSecrets = SECRETS_POOL.filter(s => !agentSecrets.has(s.id) && s.sensitivity >= 2 && !s.template.includes('{target}'));
    if (availableSecrets.length === 0) return;

    const chosen = availableSecrets[Math.floor(Math.random() * availableSecrets.length)];
    agentSecrets.add(chosen.id);
    sharedSecrets.set(payload.agentId, agentSecrets);

    // Create the shared knowledge fact — only known by the two agents.
    // createFact dedupes on (type, subject, target), so a pair that has already
    // confided returns null. Bail out: otherwise the drama log and the trust boost
    // fire again and again off a fact that was never written, ratcheting trust
    // upward without limit.
    const sharerName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, payload.agentId)).get()?.name ?? 'Someone';
    const listenerName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, otherId)).get()?.name ?? 'someone';

    // The fact carries what was confided. It used to be only "X confided
    // something personal to Y", so when the listener betrayed it the rumor
    // going round town said nothing at all.
    const factId = createFact(
      'secret_shared',
      payload.agentId,
      otherId,
      chosen.sensitivity,
      [payload.agentId, otherId],
      'confided',
      { detail: chosen.template.replace(/\{subject\}/g, sharerName) },
    );
    if (factId === null) return;

    logActivity({
      type: 'drama',
      initiator: payload.agentId,
      target: otherId,
      templateData: {
        description: `${sharerName} confided a personal secret to ${listenerName}`,
      },
      metadata: { beat: 'confession' },
    });

    // Boost trust and friendship from the intimate moment
    db.insert(relationshipEvents).values({
      agent_a: payload.agentId,
      agent_b: otherId,
      event_type: 'secret_shared',
      description: `Secret shared (${chosen.category})`,
      friendship_delta_ab: 5,
      friendship_delta_ba: 8,
      romance_delta_ab: 0,
      romance_delta_ba: 0,
      trust_delta_ab: 3,
      trust_delta_ba: 10,
      sentiment: 0.9,
      processed: false,
      timestamp: Date.now(),
    }).run();

    // `agentId`/`perpetratorId` are what the cascade engine resolves targets from;
    // without them the secret_trust_deepened ripple rule could never fire.
    simEvents.emit('secret:shared', {
      agentId: payload.agentId,
      perpetratorId: otherId,
      sharerId: payload.agentId,
      listenerId: otherId,
      category: chosen.category,
    });
  });
}

// Auto-initialize on import
initSecretSharing();

export { initSecretSharing };
