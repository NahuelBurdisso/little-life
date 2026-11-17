/**
 * Theft as a decision starts, and the constable arrests after the agent loop.
 */

import { db } from '../../../db';
import { agents, economy, relationshipEvents, agentStates } from '../../../db/schema';
import { logActivity } from '../../../lib/activityLogger';
import { eq } from 'drizzle-orm';
import { chancePerTick } from '../../../lib/gameClock';
import { getAgentStates } from '../../../lib/states';
import { createFact } from '../../../lib/gossip';
import {
  arrestableFactsBySubject, DIRECT_CRIME_TYPES, inPostReleaseCooldown, lastSentenceEnds, markFactsPaid,
} from '../../../lib/arrests';
import { simEvents } from '../../../lib/simEvents';
import { shopliftFrom } from '../../../lib/economyTransfers';
import type { AgentRow, LocationRow, ScoredAction, KnowledgeRow } from './types';
import type { DecisionTickContext, AgentTurn } from './context';

/** Resolve a shoplifting or pickpocketing decision as the action starts: the take, and whether they were caught. */
export function executeCrime(t: AgentTurn, decision: ScoredAction, d: DecisionTickContext): void {
  const { agent, agentEcon } = t;
  const { activeAgents, allLocations } = d;
  // Crime execution — resolve theft when agent starts the action
  if (decision.source === 'shoplifting' || decision.source === 'pickpocket') {
    const thief = agent;
    const thiefEcon = agentEcon;
    if (thiefEcon) {
      const stolenAmount = Math.floor(5 + Math.random() * 10); // $5-15
      const caught = Math.random() < 0.35; // 35% chance caught

      if (decision.source === 'pickpocket' && decision.targetAgentId) {
        const victimEcon = db.select().from(economy).where(eq(economy.agent_id, decision.targetAgentId)).get();
        const victimAgent = activeAgents.find(a => a.id === decision.targetAgentId);
        // Fresh, like the victim's: `thiefEcon` is the snapshot loaded at the
        // start of the tick, and `snapshot.money + stolen` overwrote any change
        // made to the thief's money earlier in the same tick.
        const thiefNow = db.select().from(economy).where(eq(economy.agent_id, thief.id)).get();
        if (victimEcon && victimAgent && thiefNow && victimEcon.money >= stolenAmount) {
          db.update(economy).set({ money: victimEcon.money - stolenAmount }).where(eq(economy.id, victimEcon.id)).run();
          db.update(economy).set({ money: thiefNow.money + stolenAmount }).where(eq(economy.id, thiefNow.id)).run();
          if (caught) {
            createFact('theft', thief.id, decision.targetAgentId, 2, [thief.id, decision.targetAgentId], 'witnessed');
            // `item`/`locationName` are what the thief's memory says
            // (MemoryObserver); without them it read "I got caught stealing
            // undefined from undefined".
            simEvents.emit('economy:theft_caught', {
              agentId: thief.id, perpetratorId: thief.id, victimId: decision.targetAgentId,
              locationId: thief.current_location,
              item: `$${stolenAmount}`, locationName: victimAgent.name,
            });
            logActivity({ type: 'drama', initiator: thief.id, target: decision.targetAgentId,
              templateData: { description: `${thief.name} was caught pickpocketing $${stolenAmount} from ${victimAgent.name}!` }, metadata: { beat: 'theft' } });
          } else {
            logActivity({ type: 'drama', initiator: thief.id,
              templateData: { description: `${thief.name} stole $${stolenAmount} from ${victimAgent.name} without being noticed` }, metadata: { beat: 'theft' } });
            simEvents.emit('economy:theft_success', {
              agentId: thief.id, thief: thief.id, victim: decision.targetAgentId, amount: stolenAmount,
              perpetratorId: thief.id, victimId: decision.targetAgentId, locationId: thief.current_location,
              item: `$${stolenAmount}`, locationName: victimAgent.name,
            });
          }
        }
      } else if (decision.source === 'shoplifting') {
        // Steal from the shop: the take comes out of the owner's till, capped
        // at what it holds. It used to be minted — money from outside the
        // treasury loop (economy.ts, townTreasury.ts). An empty till, or a
        // shop without an owner, has nothing to lose.
        const shop = allLocations.find((l) => l.id === decision.targetLocationId);
        const shopOwner = shop?.owner ?? null;
        const taken = shopliftFrom(thief.id, shopOwner, stolenAmount);
        if (taken <= 0) {
          // nothing taken, nothing to report
        } else if (caught) {
          createFact('theft', thief.id, null, 2, [thief.id], 'witnessed');
          // The shop's owner is the victim (theft_confrontation, theft_revenge
          // and the victim's drift read it); an ownerless shop has none.
          simEvents.emit('economy:theft_caught', {
            agentId: thief.id, perpetratorId: thief.id,
            ...(shopOwner != null && shopOwner !== thief.id ? { victimId: shopOwner } : {}),
            locationId: thief.current_location,
            item: `$${taken} worth of goods`, locationName: shop?.name ?? 'the shop',
          });
          logActivity({ type: 'drama', initiator: thief.id,
            templateData: { description: `${thief.name} was caught shoplifting $${taken} worth of goods!` }, metadata: { beat: 'theft' } });
        } else {
          logActivity({ type: 'drama', initiator: thief.id,
            templateData: { description: `${thief.name} shoplifted $${taken} worth of goods` }, metadata: { beat: 'theft' } });
        }
      }
    }
  }
}

/** A constable on duty arrests at most one co-located agent per tick whose record has grown long enough. */
export function constableArrests(d: DecisionTickContext): void {
  const { world, activeAgents, allLocations, econMap, allActiveKnowledge, nowMinutes } = d;
  // --- Constable Arrest Mechanic ---
  // If the constable is at the same location as an agent with 8+ arrestable facts (4+ when
  // they know of a theft or blackmail first-hand), arrest them. What counts is lib/arrests.ts:
  // no earlier arrests, seduction rumors or grudges, nothing already paid for with a sentence,
  // and nobody fresh out of jail.
  const arrestableFacts = arrestableFactsBySubject(allActiveKnowledge);
  const sentenceEnds = lastSentenceEnds(allActiveKnowledge);
  for (const agent of activeAgents) {
    const agentEconRow = econMap.get(agent.id);
    if (!agentEconRow || agentEconRow.job !== 'constable') continue;
    if (agent.current_location == null) continue;
    if (agent.current_action?.type === 'sleeping') continue;

    // Find co-located agents with high negative fact counts
    for (const other of activeAgents) {
      if (other.id === agent.id || other.current_location !== agent.current_location) continue;
      if (other.current_action?.type === 'idle' && other.current_location != null) {
        // Check if already at prison (don't re-arrest)
        const loc = allLocations.find(l => l.id === other.current_location);
        if (loc?.type === 'prison') continue;
      }

      if (getAgentStates(other.id).includes('arrested')) continue;
      if (inPostReleaseCooldown(sentenceEnds, other.id, nowMinutes)) continue;

      const record = arrestableFacts.get(other.id) ?? [];
      const negFacts = record.length;

      // Check if constable has direct knowledge of crimes by this target (from cached data)
      const allKnowledgeFacts = record
        .filter(f => (f.known_by as number[]).includes(agent.id) && DIRECT_CRIME_TYPES.has(f.type));

      const arrestThreshold = allKnowledgeFacts.length > 0 ? 4 : 8;
      if (negFacts < arrestThreshold) continue;

      // 25% per game minute when the constable has direct crime knowledge, 10%
      // otherwise (chancePerTick: the same odds per game minute at any speed).
      const arrestChance = allKnowledgeFacts.length > 0 ? 0.25 : 0.1;
      if (Math.random() > chancePerTick(arrestChance, world.tick_speed)) continue;

      // Find the prison
      const prison = allLocations.find(l => l.type === 'prison');
      if (!prison) continue;

      // Sentence length scales with how much dirt the town has on them:
      // 8h base, +2h per negative fact past the arrest threshold, capped at 2 days.
      const sentence = Math.min(2880, 480 + (negFacts - arrestThreshold) * 120);

      // Everyone in the room when the constable takes them, read before the
      // teleport moves the prisoner (rows are this tick's snapshot).
      const onlookers = activeAgents
        .filter((a) => a.current_location === other.current_location && a.id !== agent.id && a.id !== other.id)
        .map((a) => a.id);
      arrest(agent, other, prison, sentence, record, nowMinutes, onlookers);

      break; // One arrest per tick
    }
  }
}

/**
 * The constable `agent` arrests `other`: to the prison for `sentence` game
 * minutes, with the relationship hit, the feed row, the paid-for record, the
 * gossip and both memories.
 */
function arrest(
  agent: AgentRow,
  other: AgentRow,
  prison: LocationRow,
  sentence: number,
  record: KnowledgeRow[],
  nowMinutes: number,
  /** Who saw it happen: they know of the arrest from the start. */
  onlookers: number[],
): void {
  // Where it happened, before the teleport below moves them to the prison.
  const sceneId = other.current_location;

  // Arrest: teleport criminal to prison, then hold them for the sentence.
  // The `arrested` state is what actually confines them — the guard at the
  // top of the decision loop keeps re-idling them until it expires.
  db.update(agents).set({
    current_action: { type: 'idle' },
    position: { x: prison.entry_point.x, y: prison.entry_point.y },
    current_destination: null,
    current_location: prison.id,
    action_started: nowMinutes,
    action_duration: sentence,
    action_queue: [],
    current_path: null,
  }).where(eq(agents.id, other.id)).run();

  db.insert(agentStates).values({
    agent_id: other.id,
    type: 'arrested',
    severity: Math.min(1, sentence / 2880),
    started_at: nowMinutes,
    duration: sentence,
    target_agent_id: agent.id,
    source: 'arrest',
    metadata: { prison_id: prison.id, sentence },
  }).run();

  // Log the arrest
  const [ordA, ordB] = [Math.min(agent.id, other.id), Math.max(agent.id, other.id)];
  db.insert(relationshipEvents).values({
    agent_a: ordA,
    agent_b: ordB,
    event_type: 'arrested',
    description: `${agent.name} arrested ${other.name}`,
    friendship_delta_ab: agent.id === ordA ? -10 : 0,
    friendship_delta_ba: agent.id === ordA ? 0 : -10,
    romance_delta_ab: 0, romance_delta_ba: 0,
    trust_delta_ab: agent.id === ordA ? -20 : 0,
    trust_delta_ba: agent.id === ordA ? 0 : -20,
    sentiment: -0.8,
    processed: false,
    timestamp: Date.now(),
  }).run();

  logActivity({
    type: 'drama',
    initiator: agent.id,
    target: other.id,
    severity: Math.min(1, sentence / 2880),
    templateData: {
      description: `${agent.name} arrested ${other.name}! Sentence: ${Math.round(sentence / 60)} hours.`,
    },
    metadata: { beat: 'arrest' },
  });

  // The sentence pays for the record it was for: those facts stop counting toward an
  // arrest once it ends (and the cooldown runs from then).
  markFactsPaid(record.map(f => f.id), nowMinutes + sentence);

  // Create arrest gossip fact. The onlookers know it too: it happened in front
  // of them, and the witness rule below only ever picks one of them.
  createFact('arrest', other.id, agent.id, 2, [agent.id, other.id, ...onlookers], 'witnessed', { detail: `arrested by ${agent.name}` });
  // The cast and the scene: the arrested resident is the perpetrator, the
  // constable the other party (so arrest_gossip's fact names them, and they are
  // never picked as their own witness), and `locationId` is where it happened.
  // Without it RippleEngine fell back to the prisoner's current place — the
  // prison they had just been teleported to — and looked for witnesses there.
  simEvents.emit('crime:arrested', {
    agentId: other.id, perpetratorId: other.id, victimId: agent.id,
    locationId: sceneId, constableName: agent.name,
  });

  // Arrest memories
  simEvents.emit('interaction:completed', {
    agentId: agent.id, otherName: other.name,
    action: `arrested ${other.name}`,
  });
  simEvents.emit('interaction:completed', {
    agentId: other.id, otherName: agent.name,
    action: `was arrested by ${agent.name}`,
  });
}
