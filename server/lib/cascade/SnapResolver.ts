/**
 * SnapResolver
 *
 * When an agent's tension crosses their snap threshold, makes ONE LLM call
 * to decide how they react (their "snap action").
 */

import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import type { SnapAction } from './cascadeTypes';
import { db } from '../../db';
import { agents, needs, agentStates, locations } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { simEvents } from '../simEvents';
import { logActivity } from '../activityLogger';
import { gameMinutesNow } from '../worldClock';

export interface SnapPromptContext {
  agentName: string;
  personalitySummary: string;
  tensionSources: Array<{ event: string; description: string; tick: number }>;
  activeStates: string[];
  activeGoals: string[];
}

const VALID_ACTIONS: SnapAction[] = [
  'confront',
  'flee',
  'plot',
  'breakdown',
  'lash_out',
  'self_destruct',
];

export function parseSnapResponse(response: string): SnapAction {
  const normalized = response.toLowerCase().trim();

  for (const action of VALID_ACTIONS) {
    if (normalized.includes(action)) {
      return action;
    }
  }

  return 'breakdown';
}

export class SnapResolver {
  buildSnapPrompt(ctx: SnapPromptContext): string {
    const states = ctx.activeStates.length > 0 ? ctx.activeStates.join(', ') : 'none';
    const goals = ctx.activeGoals.length > 0 ? ctx.activeGoals.join(', ') : 'none';
    const sourcesText = ctx.tensionSources
      .map((s) => `- ${s.description}`)
      .join('\n');

    return [
      `You are ${ctx.agentName}, a resident of a small town.`,
      `Your personality: ${ctx.personalitySummary}`,
      `Your current emotional states: ${states}`,
      `Your active goals: ${goals}`,
      '',
      'You have been pushed to your breaking point by these recent events:',
      sourcesText,
      '',
      'You can no longer contain yourself. Choose ONE action:',
      '- confront: directly confront the person most responsible',
      '- flee: run home and avoid everyone',
      '- plot: secretly plan revenge',
      '- breakdown: have a public emotional breakdown',
      '- lash_out: take your anger out on whoever is nearby (not the cause)',
      '- self_destruct: engage in self-destructive behavior (drinking, gambling, quitting job)',
      '',
      'Respond with ONLY the action word. Nothing else.',
    ].join('\n');
  }

  async resolveSnap(ctx: SnapPromptContext): Promise<SnapAction> {
    try {
      const prompt = this.buildSnapPrompt(ctx);

      const response = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        system: 'You are roleplaying as a town resident who has reached their emotional breaking point. Respond with exactly one word from the provided list.',
        messages: [{ role: 'user', content: prompt }],
        priority: 'critical',
        options: {
          temperature: CONFIG.AI.CHAT_TEMPERATURE,
          top_p: CONFIG.AI.CHAT_TOP_P,
          num_predict: 10,
          stop: ['\n', '.', ',', '!', '?'],
        },
      });

      return parseSnapResponse(response.text);
    } catch (error) {
      console.error('[SnapResolver] resolveSnap error, defaulting to breakdown:', error);
      return 'breakdown';
    }
  }

  async executeSnapAction(
    agentId: number,
    action: SnapAction,
    _tensionSources: Array<{ event: string; description: string; tick: number }>,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const agentRow = db.select({ name: agents.name, home: agents.home })
      .from(agents).where(eq(agents.id, agentId)).get();
    const agentName = agentRow?.name ?? `Agent#${agentId}`;

    switch (action) {
      case 'confront': {
        // Find the most mentioned agent in tension sources
        simEvents.emit('interaction:completed', {
          agentId,
          action: 'confrontation',
          _cascade: metadata,
        });
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} snapped and confronted someone!` } });
        break;
      }
      case 'flee': {
        // Send agent home
        if (agentRow?.home) {
          const loc = db.select({ entry_point: locations.entry_point })
            .from(locations).where(eq(locations.id, agentRow.home)).get();
          if (loc) {
            const ep = loc.entry_point as { x: number; y: number };
            db.update(agents).set({
              current_action: { type: 'walking', to: ep },
              current_destination: { x: ep.x, y: ep.y, locationId: agentRow.home },
              current_path: null,
            }).where(eq(agents.id, agentId)).run();
          }
        }
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} snapped and fled home in distress` } });
        break;
      }
      case 'plot': {
        // Create stressed state + emit plot event
        const existingStressed = db.select({ id: agentStates.id }).from(agentStates)
          .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, 'angry'))).get();
        if (!existingStressed) {
          // `started_at: 0` made the state already 240+ minutes old on insert, so
          // the very next states tick expired it and the plot never happened.
          // State clock is game minutes, not the cascade's tick.
          db.insert(agentStates).values({
            agent_id: agentId, type: 'angry', severity: 0.7,
            started_at: gameMinutesNow(), duration: 240, source: 'snap:plot', metadata: {},
          }).run();
        }
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} snapped quietly and began plotting revenge` } });
        break;
      }
      case 'breakdown': {
        // Public emotional breakdown: stress spike, mood crash
        const agentNeeds = db.select({ stress: needs.stress, mood: needs.mood })
          .from(needs).where(eq(needs.agent_id, agentId)).get();
        if (agentNeeds) {
          db.update(needs).set({
            stress: Math.min(100, agentNeeds.stress + 25),
            mood: Math.max(0, agentNeeds.mood - 20),
          }).where(eq(needs.agent_id, agentId)).run();
        }
        simEvents.emit('state:triggered', { agentId, state: 'stressed', source: 'snap:breakdown' });
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} had a public emotional breakdown!` } });
        break;
      }
      case 'lash_out': {
        // Take anger out on a nearby agent. Downstream insult rules resolve the
        // victim, so without one the lash-out has no consequences at all.
        const victimId = this.pickNearbyAgent(agentId);
        simEvents.emit('interaction:completed', {
          agentId,
          perpetratorId: agentId,
          victimId,
          action: 'insult',
          _cascade: metadata,
        });
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} snapped and lashed out at those nearby!` } });
        break;
      }
      case 'self_destruct': {
        // Self-destructive behavior: seek tavern, stress, mood crash
        const agentNeeds2 = db.select({ stress: needs.stress, mood: needs.mood })
          .from(needs).where(eq(needs.agent_id, agentId)).get();
        if (agentNeeds2) {
          db.update(needs).set({
            stress: Math.min(100, agentNeeds2.stress + 15),
            mood: Math.max(0, agentNeeds2.mood - 15),
          }).where(eq(needs.agent_id, agentId)).run();
        }
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} snapped and spiraled into self-destructive behavior` } });
        break;
      }
    }
  }

  /** Random active agent sharing the snapping agent's location, or null. */
  private pickNearbyAgent(agentId: number): number | null {
    const self = db.select({ current_location: agents.current_location })
      .from(agents).where(eq(agents.id, agentId)).get();
    if (self?.current_location == null) return null;

    const others = db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.current_location, self.current_location), eq(agents.is_active, true)))
      .all()
      .filter(a => a.id !== agentId);
    if (others.length === 0) return null;

    return others[Math.floor(Math.random() * others.length)].id;
  }
}
