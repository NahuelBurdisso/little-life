import { simEvents } from './simEvents';
import { getEffectivePersonality } from './states';
import { asId, asNumber, asRecord, type SnapshotStore } from '../engine/snapshotCodec';

// ─── Favor Tracking ──────────────────────────────────────────────────────────
// Tracks favors (gifts, comfort, lending) between agents.
// Agents who owe favors feel obligation. Personality affects repayment.
// Loyal agents always repay. Selfish agents exploit.

interface FavorBalance {
  given: number;    // favors this agent gave to the other
  received: number; // favors this agent received from the other
}

// agentId → Map<otherAgentId, FavorBalance>
const favorLedger = new Map<number, Map<number, FavorBalance>>();

/** Drop the favor ledger for a world replace (agent ids are reused). */
export function clearFavorLedger(): void {
  favorLedger.clear();
}

/**
 * Checkpoint of the ledger (server/engine/simSnapshots.ts). A debt of gratitude
 * is exactly the kind of thing that should outlive a server restart; without
 * this, every restart wiped the town's obligations. Shape:
 * { [agentId]: { [otherId]: { given, received } } }.
 */
export const favorSnapshotStore: SnapshotStore = {
  key: 'favors',
  version: 1,
  serialize() {
    const out: Record<string, Record<string, FavorBalance>> = {};
    for (const [agentId, others] of favorLedger) {
      const entry: Record<string, FavorBalance> = {};
      for (const [otherId, b] of others) entry[otherId] = { given: b.given, received: b.received };
      out[agentId] = entry;
    }
    return out;
  },
  restore(data) {
    favorLedger.clear();
    for (const [key, raw] of Object.entries(asRecord(data) ?? {})) {
      const agentId = asId(key);
      if (agentId === null) continue;
      const others = new Map<number, FavorBalance>();
      for (const [otherKey, rawBalance] of Object.entries(asRecord(raw) ?? {})) {
        const otherId = asId(otherKey);
        const b = asRecord(rawBalance);
        const given = asNumber(b?.given);
        const received = asNumber(b?.received);
        if (otherId === null || given === null || received === null) continue;
        others.set(otherId, { given, received });
      }
      if (others.size > 0) favorLedger.set(agentId, others);
    }
  },
};

function getBalance(agentId: number, otherId: number): FavorBalance {
  let agentMap = favorLedger.get(agentId);
  if (!agentMap) {
    agentMap = new Map();
    favorLedger.set(agentId, agentMap);
  }
  let balance = agentMap.get(otherId);
  if (!balance) {
    balance = { given: 0, received: 0 };
    agentMap.set(otherId, balance);
  }
  return balance;
}

function recordFavor(giverId: number, receiverId: number, magnitude: number): void {
  const giverBalance = getBalance(giverId, receiverId);
  giverBalance.given += magnitude;

  const receiverBalance = getBalance(receiverId, giverId);
  receiverBalance.received += magnitude;
}

/** Get net favor balance: positive = they owe you, negative = you owe them */
export function getNetFavorBalance(agentId: number, otherId: number): number {
  const balance = getBalance(agentId, otherId);
  return balance.given - balance.received;
}

/** Social score modifier based on favor balance */
export function getFavorSocialModifier(agentId: number, otherId: number): number {
  const net = getNetFavorBalance(agentId, otherId);
  const personality = getEffectivePersonality(agentId);
  if (!personality) return 0;

  if (net < -3) {
    // Agent owes favors — loyal agents feel obligated, selfish don't care
    return personality.loyalty > 50 ? 8 : 0;
  }
  if (net > 3) {
    // Agent is owed favors — might feel entitled or generous
    return personality.vanity > 50 ? -3 : 2; // vain agents resent unreciprocated giving
  }
  return 0;
}

let initialized = false;

export function initFavorTracking(): void {
  if (initialized) return;
  initialized = true;

  // Gift = favor
  simEvents.on('gift:given', (p: { giverId: number; receiverId: number }) => {
    recordFavor(p.giverId, p.receiverId, 1);
  });

  // Comfort/helping = favor
  simEvents.on('goal:completed', (p: { agentId: number; goalType: string; victimId?: number }) => {
    if (['protect', 'comfort_grieving'].includes(p.goalType) && p.victimId) {
      recordFavor(p.agentId, p.victimId, 2);
    }
  });

  // Economy transaction (lending) = favor
  simEvents.on('economy:blackmail_paid', (_p: { agentId: number }) => {
    // Being blackmailed is not a favor — it's coercion. No favor recorded.
  });
}
