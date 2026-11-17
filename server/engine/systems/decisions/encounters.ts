/**
 * Chance conversations between people who happen to share a social location.
 */

import { db } from '../../../db';
import { conversationQueue } from '../../../db/schema';
import { chancePerTick } from '../../../lib/gameClock';
import { PersonalityProfile, selectPersonalityTopic } from '../../../lib/personality';
import { getAgentStates } from '../../../lib/states';
import { chooseTier, hasDramaticState } from '../../../lib/conversationTier';
import { isAnyWatched } from '../../../lib/spotlight';
import { queueMaxWait } from '../../../lib/conversationPacing';
import { getRelationshipValues } from './helpers';
import type { DecisionTickContext } from './context';

/**
 * Chance meetings: at most one new chat per social location per tick, between
 * two random people there who are free and not already talking or queued.
 */
export function queueLocationEncounters(d: DecisionTickContext): void {
  const {
    world, activeAgents, allLocations, allRelationships, needsMap, allQueuedConvos, allActiveConvos, pairOnCooldown, tierBudget,
  } = d;
  // --- Tavern/Location Encounter: queue conversations between co-located agents ---
  // Groups agents by location, then queues conversations for pairs that aren't already talking
  const locationGroups = new Map<number, typeof activeAgents>();
  const socialLocTypes = new Set(['tavern', 'town_square', 'park']);
  for (const agent of activeAgents) {
    if (agent.current_location == null) continue;
    const action = agent.current_action;
    if (action?.type === 'talking' || action?.type === 'sleeping' || action?.type === 'working') continue;
    // A private evening (lib/intimacy/tryst.ts) is not a spare pair for a chance chat.
    if (action?.zoneActivity === 'tryst') continue;

    const group = locationGroups.get(agent.current_location) ?? [];
    group.push(agent);
    locationGroups.set(agent.current_location, group);
  }

  for (const [locId, group] of locationGroups) {
    if (group.length < 2) continue;
    const loc = allLocations.find(l => l.id === locId);
    if (!loc || !socialLocTypes.has(loc.type)) continue;

    // Pick a random pair from the group (max 1 new conversation per location per tick).
    // 15% per GAME MINUTE per social location: rolled once per tick it left the
    // tavern a quarter as chatty at 4x (chancePerTick compounds it over the tick).
    if (Math.random() > chancePerTick(0.15, world.tick_speed)) continue;
    const shuffled = group.sort(() => Math.random() - 0.5);
    const a = shuffled[0];
    const b = shuffled[1];

    // Check if this pair already has a queued or active conversation (from cached data)
    const existingQueue2 = allQueuedConvos.filter(q => {
      const p = q.participants as number[];
      return p.includes(a.id) && p.includes(b.id);
    });
    if (existingQueue2.length > 0) continue;

    const existingActive2 = allActiveConvos.filter(c => {
      const p = c.participants as number[];
      return p.includes(a.id) && p.includes(b.id);
    });
    if (existingActive2.length > 0) continue;

    // Cooldown check (from cached data)
    if (pairOnCooldown(a.id, b.id)) continue;

    const rel = getRelationshipValues(allRelationships, a.id, b.id);
    const friendship = rel?.friendship ?? 0;
    const romance = rel?.romance ?? 0;

    // Same tier logic as regular socializing (lib/conversationTier.ts), with
    // the signals an encounter has: no topic yet, hostility counts as drama.
    const aStates = getAgentStates(a.id);
    const bStates = getAgentStates(b.id);
    // Skip if either agent is depressed — they avoid conversations
    if ((aStates as string[]).includes('depressed') || (bStates as string[]).includes('depressed')) continue;

    const aNeeds = needsMap.get(a.id);
    const aMood = aNeeds?.mood ?? 50;

    const { tier, priority: encounterPriority, maxWaitGameMin: encounterWait } = chooseTier({
      ...tierBudget,
      source: 'encounter',
      friendship,
      romance,
      mood: aMood,
      dramaticState: hasDramaticState(aStates, bStates),
      watched: isAnyWatched([a.id, b.id]),
      basePriority: 50,
    });

    const aPersonality = a.personality as PersonalityProfile | null;
    let topic: string | null = null;
    if (aPersonality) {
      const others = activeAgents.filter(x => x.id !== a.id && x.id !== b.id);
      topic = selectPersonalityTopic(aPersonality, aMood, friendship, romance, others.map(x => ({ name: x.name })));
    }

    db.insert(conversationQueue).values({
      participants: [a.id, b.id],
      tier,
      priority: encounterPriority,
      trigger_reason: `location_encounter:${loc.type}`,
      topic,
      queued_at: Date.now(),
      max_wait: queueMaxWait(encounterWait),
    }).run();
  }
}
