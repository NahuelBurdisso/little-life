import { db } from '../../db';
import { agents, needs, economy, worldState } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { addToInventory } from '../../lib/economyEngine';
import { practiceHobby, getSkillOutputMultiplier, getSkillNeedBonus } from '../../lib/hobbyEngine';

interface ZoneActionEffect {
  // Need values in this codebase are SATISFACTION (0 = starving/exhausted), so a
  // positive delta is a gain and a negative delta is a cost. This is the opposite
  // of the decay-modifier convention used in needs.ts.
  needDeltas: Record<string, number>;
  itemProduced?: { item: string; qty: number };
}

const ZONE_ACTION_EFFECTS: Record<string, () => ZoneActionEffect> = {
  cook:        () => ({ needDeltas: { hunger: 20 } }),
  rest:        () => ({ needDeltas: { energy: 5 } }),
  contemplate: () => ({ needDeltas: { mood: 5, comfort: 3 } }),
  fish:        () => ({ needDeltas: { fun: 4 }, itemProduced: { item: 'food_raw', qty: 1 } }),
  garden:      () => ({ needDeltas: { comfort: 4, mood: 3 } }),
  forage:      () => ({ needDeltas: {}, itemProduced: { item: 'food_raw', qty: 1 } }),
  perform:     () => ({ needDeltas: { fun: 6, social: 3 } }),
  watch:       () => ({ needDeltas: { fun: 3, social: 2 } }),
  browse:      () => ({ needDeltas: { fun: 2 } }),
  jog:         () => ({ needDeltas: { fun: 3, mood: 2, energy: -4 } }),
};

// Need columns that exist in the needs table
const NEED_COLUMNS = ['hunger', 'energy', 'social', 'comfort', 'fun', 'mood', 'stress'] as const;
type NeedColumn = typeof NEED_COLUMNS[number];

function isNeedColumn(key: string): key is NeedColumn {
  return (NEED_COLUMNS as readonly string[]).includes(key);
}

/**
 * Execute a zone-specific action's effects.
 * Returns true if the action was handled, false if unknown.
 */
export function executeZoneAction(actionType: string, agentId: number): boolean {
  const effectFn = ZONE_ACTION_EFFECTS[actionType];
  if (!effectFn) return false;

  const effect = effectFn();

  // Practice hobby and get skill bonuses
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  const currentTick = (world?.time as any)?.totalTicks ?? 0;
  practiceHobby(agentId, actionType, currentTick);
  const skillNeedBonus = getSkillNeedBonus(agentId, actionType);
  const skillOutputMult = getSkillOutputMultiplier(agentId, actionType);

  // Apply need deltas (enhanced by hobby skill)
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) return false;

  const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
  if (agentNeeds) {
    const updates: Partial<Record<NeedColumn, number>> = {};
    for (const [need, delta] of Object.entries(effect.needDeltas)) {
      if (isNeedColumn(need)) {
        const current = agentNeeds[need] as number;
        // Gains (positive deltas) are enhanced by skill; costs are left alone
        const enhancedDelta = delta > 0 ? delta + skillNeedBonus : delta;
        updates[need] = Math.max(0, Math.min(100, current + enhancedDelta));
      }
    }
    if (Object.keys(updates).length > 0) {
      db.update(needs).set(updates).where(eq(needs.agent_id, agentId)).run();
    }
  }

  // Produce items (quantity scaled by skill)
  if (effect.itemProduced) {
    const econ = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();
    if (econ) {
      const scaledQty = Math.max(1, Math.round(effect.itemProduced.qty * skillOutputMult));
      const newInv = addToInventory(
        econ.inventory as { itemId: string; quantity: number; acquiredAt: number }[],
        effect.itemProduced.item,
        scaledQty,
        Date.now(),
      );
      db.update(economy).set({ inventory: newInv }).where(eq(economy.id, econ.id)).run();
    }
  }

  // No activity log here: decisions.ts already writes a feed row for every
  // zone activity when it is chosen, so logging again on arrival double-posts.

  return true;
}
