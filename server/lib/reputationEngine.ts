import { db } from '../db';
import { agents, shared_knowledge, relationships } from '../db/schema';
import { eq } from 'drizzle-orm';
import { simEvents } from './simEvents';

// ─── Reputation Engine ────────────────────────────────────────────────────────
// Tracks community-wide reputation per agent.
// Reputation is computed from gossip facts, relationship averages, and events.
// Score range: -100 (pariah) to 100 (beloved).
//
// Positive acts: comfort, nurse, lend_money, protect, honest testimony
// Negative acts: theft, blackmail, fraud, vandalism, pickpocket, fight
// Reputation affects: shop prices, social willingness, conversation tone

const reputationCache = new Map<number, number>();
let initialized = false;

// ─── Event weights ────────────────────────────────────────────────────────────

const FACT_TYPE_REPUTATION: Record<string, number> = {
  theft:            -15,
  blackmail:        -20,
  fraud:            -12,
  vandalism:        -8,
  hoarding:         -6,
  work_issue:       -3,
  affair:           -10,
  fight:            -5,
  financial:        -2,  // being broke — slight sympathy penalty
  // Positive facts
  heroic:           +15,
  generous:         +10,
  honest:           +8,
  helpful:          +5,
};

// ─── Core functions ───────────────────────────────────────────────────────────

function computeReputationFromDB(agentId: number): number {
  // 1. Start from neutral
  let reputation = 0;

  // 2. Factor in gossip facts about this agent
  const facts = db.select().from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();

  for (const fact of facts) {
    if (fact.subject_id !== agentId) continue;
    const weight = FACT_TYPE_REPUTATION[fact.type] ?? 0;
    // Scale by how many people know (more witnesses = bigger reputation impact)
    const knownBy = (fact.known_by as number[])?.length ?? 1;
    const spreadFactor = Math.min(2.0, 1 + knownBy * 0.1);
    reputation += weight * spreadFactor;
  }

  // 3. Factor in average trust others have toward this agent
  const rels = db.select().from(relationships).all();
  let trustSum = 0;
  let trustCount = 0;
  for (const rel of rels) {
    if (rel.agent_a === agentId) {
      trustSum += rel.trust_ba; // how B trusts A
      trustCount++;
    } else if (rel.agent_b === agentId) {
      trustSum += rel.trust_ab; // how A trusts B
      trustCount++;
    }
  }
  if (trustCount > 0) {
    const avgTrust = trustSum / trustCount;
    reputation += avgTrust * 0.3; // trust contributes ~30% weight
  }

  // Clamp to [-100, 100]
  return Math.max(-100, Math.min(100, reputation));
}

export function getReputation(agentId: number): number {
  if (!initialized) initReputationSystem();
  return reputationCache.get(agentId) ?? 0;
}

export function adjustReputation(agentId: number, delta: number): void {
  if (!initialized) initReputationSystem();
  const current = reputationCache.get(agentId) ?? 0;
  reputationCache.set(agentId, Math.max(-100, Math.min(100, current + delta)));
}

export function getReputationLabel(score: number): string {
  if (score >= 60) return 'beloved';
  if (score >= 30) return 'respected';
  if (score >= 10) return 'liked';
  if (score >= -10) return 'neutral';
  if (score >= -30) return 'disliked';
  if (score >= -60) return 'distrusted';
  return 'pariah';
}

/** Price modifier based on reputation: beloved gets 10% discount, pariah pays 20% more */
export function getReputationPriceModifier(agentId: number): number {
  const rep = getReputation(agentId);
  if (rep >= 60) return 0.9;
  if (rep >= 30) return 0.95;
  if (rep <= -60) return 1.2;
  if (rep <= -30) return 1.1;
  return 1.0;
}

/** Social willingness: how eager strangers are to talk to this agent */
export function getReputationSocialModifier(agentId: number): number {
  const rep = getReputation(agentId);
  if (rep >= 60) return 1.4;
  if (rep >= 30) return 1.2;
  if (rep <= -60) return 0.3;
  if (rep <= -30) return 0.6;
  return 1.0;
}

// ─── Initialization & Event Listeners ─────────────────────────────────────────

function initReputationSystem(): void {
  if (initialized) return;
  initialized = true;

  // Compute initial reputation for all agents
  const allAgents = db.select({ id: agents.id }).from(agents).all();
  for (const { id } of allAgents) {
    reputationCache.set(id, computeReputationFromDB(id));
  }

  // Listen for events that affect reputation
  simEvents.on('economy:theft', (p: { thief: number }) => {
    adjustReputation(p.thief, -10);
  });
  simEvents.on('economy:theft_caught', (p: { perpetratorId: number }) => {
    adjustReputation(p.perpetratorId, -15);
  });
  simEvents.on('economy:theft_success', (p: { thief: number }) => {
    adjustReputation(p.thief, -5); // slight hit even if unseen — rumor mill
  });
  simEvents.on('economy:scam', (p: { agentId: number }) => {
    adjustReputation(p.agentId, -8);
  });
  simEvents.on('economy:blackmail_paid', (p: { agentId: number }) => {
    adjustReputation(p.agentId, 3); // victim gets sympathy
  });
  simEvents.on('goal:completed', (p: { agentId: number; goalType: string }) => {
    if (['protect', 'comfort_grieving', 'befriend'].includes(p.goalType)) {
      adjustReputation(p.agentId, 8);
    }
    if (['revenge', 'undermine', 'steal_from'].includes(p.goalType)) {
      adjustReputation(p.agentId, -10);
    }
  });
  simEvents.on('economy:transaction', (p: { agentId: number; amount: number }) => {
    // Regular economic activity slightly boosts reputation (productive citizen)
    if (p.amount > 0) adjustReputation(p.agentId, 0.5);
  });
}

/** Recalculate all reputations from DB (call on day change for accuracy) */
export function refreshAllReputations(): void {
  const allAgents = db.select({ id: agents.id }).from(agents).all();
  for (const { id } of allAgents) {
    reputationCache.set(id, computeReputationFromDB(id));
  }
}
