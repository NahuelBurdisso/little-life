// server/lib/cascade/WitnessAmplifier.ts
import type { PersonalityProfile } from '../personality';

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
   * Stub — DB writes not yet implemented.
   */
  applyBehaviors(
    _witnessId: number,
    _behaviors: WitnessBehavior[],
    _victimId: number | null,
    _perpetratorId: number | null,
    _metadata: Record<string, unknown>,
  ): void {
    // TODO: implement DB writes for each behavior type
  }
}
