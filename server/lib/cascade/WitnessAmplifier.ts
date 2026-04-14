// server/lib/cascade/WitnessAmplifier.ts
import type { PersonalityProfile } from '../personality';
import { db } from '../../db';
import { needs, relationships, agents, locations } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { createFact, getAgentName } from '../gossip';
import { simEvents } from '../simEvents';

export type WitnessBehaviorType =
  | 'fast_gossip'
  | 'cover_up'
  | 'exploit'
  | 'intervene'
  | 'panic'
  | 'comfort';

export interface WitnessBehavior {
  type: WitnessBehaviorType;
}

interface WitnessContext {
  isVictimFriend: boolean;
  eventSensitivity: number;
}

export class WitnessAmplifier {
  /**
   * Determine which behaviors a witness exhibits based on their personality
   * and context. Returns at most 2 behaviors, evaluated in priority order.
   */
  getWitnessBehaviors(
    personality: PersonalityProfile,
    ctx: WitnessContext,
  ): WitnessBehavior[] {
    const results: WitnessBehavior[] = [];

    const checks: Array<{ condition: boolean; type: WitnessBehaviorType }> = [
      {
        condition: personality.curiosity > 60,
        type: 'fast_gossip',
      },
      {
        condition: personality.loyalty > 60 && ctx.isVictimFriend,
        type: 'cover_up',
      },
      {
        condition: personality.morality < 40 && ctx.eventSensitivity >= 2,
        type: 'exploit',
      },
      {
        condition: personality.aggression > 60,
        type: 'intervene',
      },
      {
        condition: personality.neuroticism > 60,
        type: 'panic',
      },
      {
        condition: personality.warmth > 60 && ctx.isVictimFriend,
        type: 'comfort',
      },
    ];

    for (const check of checks) {
      if (check.condition) {
        results.push({ type: check.type });
        if (results.length === 2) break;
      }
    }

    return results;
  }

  /**
   * Apply witness behaviors to the simulation state.
   */
  applyBehaviors(
    witnessId: number,
    behaviors: WitnessBehavior[],
    victimId: number | null,
    perpetratorId: number | null,
    metadata: Record<string, unknown>,
  ): void {
    for (const behavior of behaviors) {
      switch (behavior.type) {
        case 'fast_gossip': {
          // Witness creates a rumor about what they saw
          if (perpetratorId != null) {
            createFact(
              'rumor',
              perpetratorId,
              victimId,
              2,
              [witnessId],
              'witness:fast_gossip',
              { detail: `witnessed by ${getAgentName(witnessId)}` },
            );
          }
          break;
        }

        case 'cover_up': {
          // Loyal witness says nothing — no-op (just doesn't gossip)
          break;
        }

        case 'exploit': {
          // Immoral witness creates blackmail leverage
          if (perpetratorId != null) {
            createFact(
              'blackmail',
              witnessId,
              perpetratorId,
              3,
              [witnessId],
              'witness:exploit',
            );
          }
          break;
        }

        case 'intervene': {
          // Aggressive witness steps in — emit interaction:completed
          simEvents.emit('interaction:completed', {
            agentId: witnessId,
            action: 'confrontation',
            perpetratorId: perpetratorId,
            victimId: victimId,
            locationId: metadata.locationId,
            _cascade: {
              chainId: metadata.chainId,
              chainDepth: 1,
              parentRuleId: `witness:intervene:${metadata.ruleId}`,
            },
          });
          break;
        }

        case 'panic': {
          // Neurotic witness panics: stress spike + flee home
          const stressRow = db.select({ stress: needs.stress })
            .from(needs)
            .where(eq(needs.agent_id, witnessId))
            .get();
          if (stressRow) {
            const newStress = Math.min(100, stressRow.stress + 15);
            db.update(needs).set({ stress: newStress }).where(eq(needs.agent_id, witnessId)).run();
          }

          // Set destination to home
          const agentRow = db.select({ home: agents.home })
            .from(agents)
            .where(eq(agents.id, witnessId))
            .get();
          if (agentRow) {
            const loc = db.select({ entry_point: locations.entry_point })
              .from(locations)
              .where(eq(locations.id, agentRow.home))
              .get();
            if (loc) {
              const entryPoint = loc.entry_point as { x: number; y: number };
              db.update(agents)
                .set({ current_destination: { x: entryPoint.x, y: entryPoint.y, locationId: agentRow.home } })
                .where(eq(agents.id, witnessId))
                .run();
            }
          }
          break;
        }

        case 'comfort': {
          // Warm witness comforts the victim: boost social, reduce stress, boost friendship
          if (victimId != null) {
            // Boost victim's social need
            const victimNeeds = db.select({ social: needs.social, stress: needs.stress })
              .from(needs)
              .where(eq(needs.agent_id, victimId))
              .get();
            if (victimNeeds) {
              const newSocial = Math.min(100, victimNeeds.social + 10);
              const newStress = Math.max(0, victimNeeds.stress - 5);
              db.update(needs)
                .set({ social: newSocial, stress: newStress })
                .where(eq(needs.agent_id, victimId))
                .run();
            }

            // Boost friendship between witness and victim
            const a = Math.min(witnessId, victimId);
            const b = Math.max(witnessId, victimId);
            const isA = witnessId === a;
            const rel = db.select().from(relationships)
              .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
              .get();

            if (rel) {
              const friendCol = isA ? 'friendship_ab' : 'friendship_ba';
              const currentFriend = isA ? rel.friendship_ab : rel.friendship_ba;
              db.update(relationships)
                .set({ [friendCol]: Math.min(100, currentFriend + 5) })
                .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
                .run();
            }
          }
          break;
        }
      }
    }
  }
}
