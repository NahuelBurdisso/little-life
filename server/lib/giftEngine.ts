import { db } from '../db';
import { agents, economy, economyTransactions, relationships, relationshipEvents, agentStates, worldState } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { getEffectivePersonality } from './states';
import { gameMinutes } from './gameClock';
import { gameMinutesNow } from './worldClock';
import { addToInventory, removeFromInventory, getInventoryCount } from './economyEngine';
import { ITEM_REGISTRY, itemPhrase } from '../data/economyData';

// ─── Gift Engine ──────────────────────────────────────────────────────────────
// After positive conversations, warm/romantic agents may spontaneously gift items.
// Gifts boost friendship and romance. Personality drives gift frequency.

// Gift cooldown: prevent spam (1 gift per agent per game day at most).
// Game minutes from the world clock. It used to compare Date.now() against
// "1440 ticks × 1000 ms", i.e. 24 real minutes — a full game day at tick_speed 1
// but only ~5 game hours at tick_speed 5, so the faster the player ran the game
// the more often the same agent gifted per game day.
const lastGiftMinute = new Map<number, number>();
export const GIFT_COOLDOWN_MINUTES = 1440; // 1 game day

/** Drop per-agent gift cooldowns for a world replace (agent ids are reused). */
export function clearGiftTracking(): void {
  lastGiftMinute.clear();
  lastImpulsiveGift.clear();
}

// ─── Impulsive (state-driven) gifts ───────────────────────────────────────────
// `drunk` and `euphoric` make an agent hand cash to whoever is nearby. The
// states phase used to roll this at 30% EVERY tick with no memory of it, so one
// drunk evening at the tavern was ~14 gifts to the same person — a playtest saw
// Priya go broke in a single episode, and $529 moved this way against $834 of
// salary. None of it reached the activity feed, so for the player the money just
// vanished. The rules below keep it a single, visible, affordable gesture.

/**
 * Minimum game time between two impulsive gifts from the same agent, shared by
 * every state that gives. 4 game hours is longer than a drunk episode at
 * tick_speed 1 (120-240 ticks), and it still spaces gifts out when a faster
 * tick_speed stretches an episode across more game time.
 */
export const IMPULSIVE_GIFT_COOLDOWN_MINUTES = 240;
/** Never give more than this share of what the giver has on hand. */
export const IMPULSIVE_GIFT_MAX_FRACTION = 0.1;
/** Never let an impulsive gift take the giver below this balance. */
export const IMPULSIVE_GIFT_MONEY_FLOOR = 20;
/** Below this the "gift" is pocket change — skip it rather than log noise. */
const IMPULSIVE_GIFT_MIN_AMOUNT = 2;

/**
 * agentId → last impulsive gift. `stateId` makes it one gift per state episode
 * even if a fast tick_speed stretches the episode past the cooldown; `atMinute`
 * is absolute game minutes (world clock, not ticks — a tick is `tick_speed`
 * minutes, so tick-count cooldowns shrink as the player speeds the game up).
 */
const lastImpulsiveGift = new Map<number, { atMinute: number; stateId: number }>();

export type ImpulsiveGiftReason = 'drunk_gift' | 'euphoric_gift';

const IMPULSIVE_GIFT_PHRASES: Record<ImpulsiveGiftReason, (giver: string, receiver: string, amount: number) => string> = {
  drunk_gift: (g, r, a) => `${g}, a few drinks in, pressed $${a} on ${r}`,
  euphoric_gift: (g, r, a) => `${g}, riding a high, gave $${a} to ${r}`,
};

/**
 * Hand `desiredAmount` (capped) from `giver` to `receiver` as a state-driven
 * impulsive gift. Returns the amount actually given, or null when the cooldown,
 * the episode limit or the giver's balance rules it out.
 *
 * Goes through the same ledger as conversation gifts: an `economy_transactions`
 * row (reason = the state, so economy stats can tell them apart), a `gift`
 * activity-feed entry, and `gift:given` so memories, favors and jealousy react
 * exactly as they do to any other gift.
 */
export function giveImpulsiveGift(params: {
  giver: { id: number; name: string; current_location: number | null };
  receiver: { id: number; name: string };
  reason: ImpulsiveGiftReason;
  /** The `agentStates` row driving the gift — one gift per episode. */
  stateId: number;
  desiredAmount: number;
}): number | null {
  const { giver, receiver, reason, stateId } = params;

  const nowMinute = gameMinutesNow();
  const last = lastImpulsiveGift.get(giver.id);
  if (last) {
    if (last.stateId === stateId) return null;
    if (nowMinute - last.atMinute < IMPULSIVE_GIFT_COOLDOWN_MINUTES) return null;
  }

  const giverEcon = db.select().from(economy).where(eq(economy.agent_id, giver.id)).get();
  // Resolve the receiver BEFORE debiting: the old code paid out even when the
  // receiver had no economy row, so the money left the town entirely.
  const receiverEcon = db.select().from(economy).where(eq(economy.agent_id, receiver.id)).get();
  if (!giverEcon || !receiverEcon) return null;

  const amount = Math.floor(Math.min(
    params.desiredAmount,
    giverEcon.money * IMPULSIVE_GIFT_MAX_FRACTION,
    giverEcon.money - IMPULSIVE_GIFT_MONEY_FLOOR,
  ));
  if (amount < IMPULSIVE_GIFT_MIN_AMOUNT) return null;

  db.update(economy).set({ money: giverEcon.money - amount }).where(eq(economy.id, giverEcon.id)).run();
  db.update(economy).set({ money: receiverEcon.money + amount }).where(eq(economy.id, receiverEcon.id)).run();

  db.insert(economyTransactions).values({
    from_agent: giver.id,
    to_agent: receiver.id,
    amount,
    reason,
    items_exchanged: null,
    location_id: giver.current_location,
    timestamp: Date.now(), // ledger timestamps are wall-clock ms everywhere
  }).run();

  lastImpulsiveGift.set(giver.id, { atMinute: nowMinute, stateId });

  logActivity({
    type: 'gift',
    initiator: giver.id,
    target: receiver.id,
    ...(giver.current_location != null ? { location: giver.current_location } : {}),
    templateData: {
      description: IMPULSIVE_GIFT_PHRASES[reason](giver.name, receiver.name, amount),
      agent: giver.name,
      target: receiver.name,
      amount,
    },
  });

  // `reason` lets memory tell an impulse from considered generosity; jealousy
  // and favors react to it like any other gift.
  simEvents.emit('gift:given', { giverId: giver.id, receiverId: receiver.id, amount, reason });
  return amount;
}

// Items suitable for gifting, ordered by value
const GIFT_ITEMS = ['food_cooked', 'food_raw', 'bread', 'ale', 'flowers'];

let initialized = false;

function initGiftSystem(): void {
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

    const sentiment = payload.sentiment ?? 0;
    if (sentiment < 0.2) return; // only after positive conversations

    // Check cooldown (game time). `now` stays wall-clock for the ledger row and
    // inventory `acquiredAt`, which are wall-clock ms everywhere else.
    const now = Date.now();
    const nowMinute = gameMinutesNow();
    const lastMinute = lastGiftMinute.get(payload.agentId);
    if (lastMinute !== undefined && nowMinute - lastMinute < GIFT_COOLDOWN_MINUTES) return;

    // Check personality
    const personality = getEffectivePersonality(payload.agentId);
    if (!personality) return;

    // Gift probability: warmth-driven with romance boost
    const a = Math.min(payload.agentId, otherId);
    const b = Math.max(payload.agentId, otherId);
    const rel = db.select().from(relationships)
      .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
      .get();

    const isA = a === payload.agentId;
    const romance = rel ? (isA ? rel.romance_ab : rel.romance_ba) : 0;
    const friendship = rel ? (isA ? rel.friendship_ab : rel.friendship_ba) : 0;

    let giftChance = personality.warmth * 0.003; // base: 0-30%
    if (romance > 30) giftChance += 0.15; // romantic interest boost
    if (friendship > 50) giftChance += 0.08; // friends boost
    if (personality.vanity > 60) giftChance += 0.05; // vain agents show off
    // Low morality agents don't gift
    if (personality.morality < 30) giftChance *= 0.3;

    if (Math.random() > giftChance) return;

    // Check if agent has money
    const econ = db.select().from(economy).where(eq(economy.agent_id, payload.agentId)).get();
    if (!econ || econ.money < 10) return; // need at least $10 to gift

    // Find best gift item the agent has in inventory
    let giftItem: string | null = null;
    for (const item of GIFT_ITEMS) {
      if (getInventoryCount(econ.inventory as any[], item) > 0) {
        giftItem = item;
        break;
      }
    }

    // If no items in inventory, buy one (spontaneous purchase for gifting)
    if (!giftItem) {
      // Just gift money directly — simpler
      const giftAmount = Math.min(Math.floor(econ.money * 0.15), 15); // 15% of money, max $15
      if (giftAmount < 3) return;

      const recipientEcon = db.select().from(economy).where(eq(economy.agent_id, otherId)).get();
      if (!recipientEcon) return;

      db.update(economy).set({ money: econ.money - giftAmount }).where(eq(economy.id, econ.id)).run();
      db.update(economy).set({ money: recipientEcon.money + giftAmount }).where(eq(economy.id, recipientEcon.id)).run();

      db.insert(economyTransactions).values({
        from_agent: payload.agentId,
        to_agent: otherId,
        amount: giftAmount,
        reason: 'gift',
        items_exchanged: null,
        location_id: null,
        timestamp: now,
      }).run();

      lastGiftMinute.set(payload.agentId, nowMinute);

      // Relationship boost
      applyGiftRelationshipBoost(payload.agentId, otherId, giftAmount);

      const giverName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, payload.agentId)).get()?.name ?? 'Someone';
      const receiverName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, otherId)).get()?.name ?? 'someone';

      logActivity({
        type: 'gift',
        initiator: payload.agentId,
        target: otherId,
        templateData: {
          description: `${giverName} gave $${giftAmount} to ${receiverName} as a gift`,
          agent: giverName,
          target: receiverName,
          amount: giftAmount,
        },
      });

      simEvents.emit('gift:given', { giverId: payload.agentId, receiverId: otherId, amount: giftAmount });
      return;
    }

    // Transfer the item
    const recipientEcon = db.select().from(economy).where(eq(economy.agent_id, otherId)).get();
    if (!recipientEcon) return;

    const newGiverInv = removeFromInventory(econ.inventory as any[], giftItem, 1);
    const newReceiverInv = addToInventory(recipientEcon.inventory as any[], giftItem, 1, now);

    db.update(economy).set({ inventory: newGiverInv }).where(eq(economy.id, econ.id)).run();
    db.update(economy).set({ inventory: newReceiverInv }).where(eq(economy.id, recipientEcon.id)).run();

    lastGiftMinute.set(payload.agentId, nowMinute);

    // Relationship boost
    const itemDef = ITEM_REGISTRY[giftItem];
    const giftValue = itemDef?.basePrice ?? 5;
    applyGiftRelationshipBoost(payload.agentId, otherId, giftValue);

    const giverName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, payload.agentId)).get()?.name ?? 'Someone';
    const receiverName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, otherId)).get()?.name ?? 'someone';

    logActivity({
      type: 'gift',
      initiator: payload.agentId,
      target: otherId,
      templateData: {
        // The id is kept in `item` for anything keyed on it; the sentence
        // gets prose ("gave food_raw to Rosa" was the old line, G9).
        description: `${giverName} gave ${receiverName} ${itemPhrase(giftItem)} as a gift`,
        agent: giverName,
        target: receiverName,
        item: giftItem,
      },
    });

    simEvents.emit('gift:given', { giverId: payload.agentId, receiverId: otherId, item: giftItem });
  });
}

function applyGiftRelationshipBoost(giverId: number, receiverId: number, value: number): void {
  const boostMagnitude = Math.min(15, 3 + value * 0.5);

  db.insert(relationshipEvents).values({
    agent_a: giverId,
    agent_b: receiverId,
    event_type: 'gift',
    description: `Gift given (value: ${value})`,
    friendship_delta_ab: 0,
    friendship_delta_ba: boostMagnitude,
    romance_delta_ab: 0,
    romance_delta_ba: Math.round(boostMagnitude * 0.3),
    trust_delta_ab: 0,
    trust_delta_ba: Math.round(boostMagnitude * 0.5),
    sentiment: 0.8,
    processed: false,
    timestamp: Date.now(),
  }).run();
}

// ─── Jealousy Cascade ─────────────────────────────────────────────────────────
// When agent A gifts agent B, check if any agent C has romantic feelings toward A.
// If C witnesses (is at same location), C becomes jealous.

function checkGiftJealousy(giverId: number, receiverId: number): void {
  const giver = db.select().from(agents).where(eq(agents.id, giverId)).get();
  if (!giver || giver.current_location === null) return;

  // This runs from a simEvents handler, so no tick is threaded in; read it.
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  // State clock: GAME MINUTES (see lib/worldClock.ts).
  const nowMinutes = world?.time ? gameMinutes(world.time) : 0;

  // Find agents at same location with romance toward the giver
  const coLocated = db.select().from(agents)
    .where(eq(agents.is_active, true))
    .all()
    .filter(a => a.id !== giverId && a.id !== receiverId && a.current_location === giver.current_location);

  for (const witness of coLocated) {
    // Check if witness has romantic feelings toward giver
    const a = Math.min(witness.id, giverId);
    const b = Math.max(witness.id, giverId);
    const rel = db.select().from(relationships)
      .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
      .get();

    if (!rel) continue;
    const witnessRomance = a === witness.id ? rel.romance_ab : rel.romance_ba;
    if (witnessRomance < 20) continue; // not romantically interested

    // Check personality — jealousy threshold
    const witnessPersonality = getEffectivePersonality(witness.id);
    const jealousyThreshold = witnessPersonality
      ? 30 - (witnessPersonality.neuroticism - 50) * 0.3 // neurotic agents get jealous easier
      : 30;

    if (witnessRomance < jealousyThreshold) continue;

    // Already jealous of this pair? Skip
    const existingJealousy = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, witness.id), eq(agentStates.type, 'jealous')))
      .get();
    if (existingJealousy) continue;

    // Trigger jealousy!
    db.insert(agentStates).values({
      agent_id: witness.id,
      type: 'jealous',
      severity: Math.min(1.0, witnessRomance / 100),
      target_agent_id: giverId,
      metadata: { rivalId: receiverId, loveInterestId: giverId, trigger: 'gift_witnessed' },
      // agentStates.started_at is in game minutes: states.ts expires with
      // `started_at + duration <= nowMinutes`.
      started_at: nowMinutes,
      duration: 2880, // ~2 game days
      source: 'gift_witnessed',
    }).run();

    const witnessName = witness.name;
    const giverName = giver.name;
    const receiverAgent = db.select({ name: agents.name }).from(agents).where(eq(agents.id, receiverId)).get();
    const receiverName = receiverAgent?.name ?? 'someone';

    logActivity({
      type: 'drama',
      initiator: witness.id,
      templateData: {
        description: `${witnessName} saw ${giverName} giving a gift to ${receiverName} and feels jealous`,
      },
    });

    simEvents.emit('jealousy:triggered', {
      agentId: witness.id,
      loveInterestId: giverId,
      rivalId: receiverId,
      trigger: 'gift_witnessed',
    });
  }
}

// Register jealousy check on gift events
simEvents.on('gift:given', (p: { giverId: number; receiverId: number }) => {
  checkGiftJealousy(p.giverId, p.receiverId);
});

// Auto-initialize on import
initGiftSystem();

export { initGiftSystem };
