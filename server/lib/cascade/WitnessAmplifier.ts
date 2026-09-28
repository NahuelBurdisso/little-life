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

/** What a bystander could have seen, as a predicate for "<perpetrator> …". */
type ActPhrase = (victim: string | undefined) => string;

const who = (victim: string | undefined) => victim ?? 'someone';

/**
 * `interaction:completed` actions, matched by substring because several are
 * free text ("stole bread from the bakery", "arrested Marco"). First match wins,
 * so the specific keywords sit before the generic ones.
 */
const ACTION_PHRASES: Array<[string, ActPhrase]> = [
  ['insult', (v) => `publicly insulted ${who(v)}`],
  ['confrontation', (v) => (v ? `got into a heated confrontation with ${v}` : 'caused an ugly scene')],
  ['flirt', (v) => `was flirting openly with ${who(v)}`],
  ['secret_meeting', () => 'was seen slipping into a secret meeting'],
  ['scheme', () => 'was seen scheming in a quiet corner'],
  ['smuggle', () => 'was caught smuggling something'],
  ['protest', () => 'led a loud protest against the authorities'],
  ['speech', () => 'gave a fiery speech in public'],
  ['announce', () => 'made a big public announcement'],
  ['confide', (v) => `was whispering secrets with ${who(v)}`],
  ['lock_out', (v) => `locked ${who(v)} out of the house`],
  ['escape', () => 'tried to break out of prison'],
  ['stole', () => 'was seen stealing'],
  ['steal', () => 'was seen stealing'],
  ['arrest', () => 'was dragged off by the constable'],
];

/** `state:triggered` states that show on the outside. Inner states (lonely, confident…) don't. */
const STATE_PHRASES: Record<string, ActPhrase> = {
  drunk: () => 'was stumbling around drunk',
  hungover: () => 'was nursing a brutal hangover',
  angry: () => 'flew into a rage',
  jealous: () => 'was seething with jealousy',
  heartbroken: () => 'was crying their heart out',
  sick: () => 'looked seriously ill',
  grieving: () => 'broke down in grief',
};

const SOURCE_PHRASES: Record<string, (payload: any) => ActPhrase | null> = {
  'economy:theft_caught': () => (v) => `was caught stealing${v ? ` from ${v}` : ''}`,
  'economy:theft_success': () => () => 'was seen stealing',
  'confrontation:occurred': () => (v) => (v ? `got into a heated confrontation with ${v}` : 'caused an ugly scene'),
  'crime:arrested': () => () => 'was dragged off by the constable',
  'economy:gambling': (p) => () => `was gambling at the tavern${p?.won === false ? ' and lost' : ''}`,
  'economy:distress': () => () => 'looked desperate for money',
  'jealousy:triggered': () => () => 'was seething with jealousy',
  'state:triggered': (p) => STATE_PHRASES[String(p?.state)] ?? null,
  'interaction:completed': (p) => {
    const action = typeof p?.action === 'string' ? p.action : '';
    return ACTION_PHRASES.find(([keyword]) => action.includes(keyword))?.[1] ?? null;
  },
};

/**
 * Turn the event a witness just saw into a predicate for its perpetrator —
 * "got into a heated confrontation with Tom" — or null when nothing visible
 * happened (a goal completing, a conversation ending, a birthday).
 *
 * The rumor used to carry only "witnessed by <name>", so the feed and the
 * gossip it seeded read "Rumor about Priya Sharma: witnessed by Ray Kowalski" —
 * a rumor with no content. With nothing describable, a rumor is better not
 * created at all than created empty.
 */
export function describeWitnessedAct(
  source: string,
  payload: unknown,
  victimName?: string,
): string | null {
  const phrase = SOURCE_PHRASES[source]?.(payload);
  return phrase ? phrase(victimName) : null;
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
          // Witness creates a rumor about what they saw — only when there is
          // something to say. `metadata.source`/`metadata.payload` are the
          // event that fired the rule, i.e. what actually happened in front of them.
          if (perpetratorId == null) break;
          const act = describeWitnessedAct(
            String(metadata.source ?? ''),
            metadata.payload,
            victimId != null ? getAgentName(victimId) : undefined,
          );
          if (!act) break;
          createFact(
            'rumor',
            perpetratorId,
            victimId,
            2,
            [witnessId],
            'witness:fast_gossip',
            { detail: act, witness: getAgentName(witnessId) },
          );
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
