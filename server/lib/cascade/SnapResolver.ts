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
import { dominantGrievance } from './TensionTracker';
import { gameMinutesNow } from '../worldClock';
import { addMoodModifier } from '../dailyLife';

/**
 * A snap's mood crash lasts 12 game hours: a modifier, because the needs phase
 * rebuilds `needs.mood` every tick and a direct write was gone a tick later.
 * The stress spike is still written directly and now fades (needs.ts carry-over).
 */
const SNAP_MOOD_MINUTES = 720;

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
  // "lash out" / "self-destruct" (space or hyphen) used to miss the
  // underscore names and silently become 'breakdown'.
  const normalized = response.toLowerCase().trim().replace(/[\s-]+/g, '_');

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
      'Reply with JSON: {"action":"<one of the words above>"}',
    ].join('\n');
  }

  async resolveSnap(ctx: SnapPromptContext): Promise<SnapAction> {
    try {
      const prompt = this.buildSnapPrompt(ctx);

      const response = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        purpose: 'snap',
        system: 'You are roleplaying as a town resident who has reached their emotional breaking point. Choose the action that fits who you are.',
        messages: [{ role: 'user', content: prompt }],
        // Not 'critical': nobody is waiting on this line the way they wait on
        // dialogue, and critical callers may take the slot reserved for it.
        priority: 'normal',
        // The grammar can only produce one of the six actions. The old
        // one-word answer with stop tokens came back empty whenever the model
        // opened with a newline, which also defaulted to 'breakdown'.
        format: {
          type: 'object',
          properties: { action: { type: 'string', enum: VALID_ACTIONS } },
          required: ['action'],
        },
        options: {
          temperature: CONFIG.AI.CHAT_TEMPERATURE,
          top_p: CONFIG.AI.CHAT_TOP_P,
          num_predict: 20,
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
    tensionSources: Array<{ event: string; description: string; tick: number; agentInvolved?: string }>,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const agentRow = db.select({ name: agents.name, home: agents.home, current_location: agents.current_location })
      .from(agents).where(eq(agents.id, agentId)).get();
    const agentName = agentRow?.name ?? `Agent#${agentId}`;
    // Who the grievances were about, if anyone. Every write below is a small sync
    // statement: this runs outside the tick's transaction (after the model's answer),
    // so nothing here may hold one open across an await.
    const culprit = this.findCulprit(agentId, tensionSources);

    switch (action) {
      case 'confront': {
        // Same shape as emitFightBeat (conversationBeats.ts): the doer is the perpetrator and
        // the culprit the victim, which is the direction goals.ts reads to credit a
        // 'fought_target' outcome. Without both ids it drops the event, so a confrontation
        // that named nobody moved no goal and no relationship.
        simEvents.emit('interaction:completed', {
          agentId,
          ...(culprit ? { perpetratorId: agentId, victimId: culprit.id } : {}),
          action: 'confrontation',
          locationId: agentRow?.current_location ?? null,
          _cascade: metadata,
        });
        logActivity({ type: 'drama', initiator: agentId, ...(culprit ? { target: culprit.id } : {}),
          templateData: { description: culprit ? `${agentName} snapped and confronted ${culprit.name}!` : `${agentName} snapped and confronted someone!` },
          metadata: { beat: 'snap' } });
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
          templateData: { description: `${agentName} snapped and fled home in distress` }, metadata: { beat: 'outburst' } });
        break;
      }
      case 'plot': {
        // Create stressed state + emit plot event
        const existingStressed = db.select({ id: agentStates.id, target: agentStates.target_agent_id }).from(agentStates)
          .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, 'angry'))).get();
        if (existingStressed) {
          // An angry state with no target never trips the revenge trigger
          // (goalRegistry: angry + has_target), so aim the one already there.
          if (culprit && existingStressed.target == null) {
            db.update(agentStates).set({ target_agent_id: culprit.id })
              .where(eq(agentStates.id, existingStressed.id)).run();
          }
        } else {
          // `started_at: 0` made the state already 240+ minutes old on insert, so
          // the very next states tick expired it and the plot never happened.
          // State clock is game minutes, not the cascade's tick.
          db.insert(agentStates).values({
            agent_id: agentId, type: 'angry', severity: 0.7,
            started_at: gameMinutesNow(), duration: 240, source: 'snap:plot', metadata: {},
            // The plot is AGAINST someone: this target is what lets goals.ts open a revenge goal.
            target_agent_id: culprit?.id ?? null,
          }).run();
        }
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: culprit ? `${agentName} snapped quietly and began plotting revenge on ${culprit.name}` : `${agentName} snapped quietly and began plotting revenge` },
          metadata: { beat: 'misdeed' } });
        break;
      }
      case 'breakdown': {
        // Public emotional breakdown: stress spike, mood crash
        const agentNeeds = db.select({ stress: needs.stress })
          .from(needs).where(eq(needs.agent_id, agentId)).get();
        if (agentNeeds) {
          db.update(needs).set({
            stress: Math.min(100, agentNeeds.stress + 25),
          }).where(eq(needs.agent_id, agentId)).run();
          addMoodModifier(agentId, -20, 'snap:breakdown', SNAP_MOOD_MINUTES, gameMinutesNow());
        }
        simEvents.emit('state:triggered', { agentId, state: 'stressed', source: 'snap:breakdown' });
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} had a public emotional breakdown!` }, metadata: { beat: 'outburst' } });
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
          templateData: { description: `${agentName} snapped and lashed out at those nearby!` }, metadata: { beat: 'snap' } });
        break;
      }
      case 'self_destruct': {
        // Self-destructive behavior: seek tavern, stress, mood crash
        const agentNeeds2 = db.select({ stress: needs.stress })
          .from(needs).where(eq(needs.agent_id, agentId)).get();
        if (agentNeeds2) {
          db.update(needs).set({
            stress: Math.min(100, agentNeeds2.stress + 15),
          }).where(eq(needs.agent_id, agentId)).run();
          addMoodModifier(agentId, -15, 'snap:self_destruct', SNAP_MOOD_MINUTES, gameMinutesNow());
        }
        logActivity({ type: 'drama', initiator: agentId,
          templateData: { description: `${agentName} snapped and spiraled into self-destructive behavior` }, metadata: { beat: 'outburst' } });
        break;
      }
    }
  }

  /**
   * The active resident the grievances were mostly about, or null (no source named
   * anyone, the name is nobody in town any more, or it is the snapper themself).
   * `agentInvolved` is a NAME, so it is looked up among ACTIVE agents: a departed or
   * dead culprit must not become a revenge target.
   */
  private findCulprit(agentId: number, sources: Array<{ agentInvolved?: string }>): { id: number; name: string } | null {
    const top = dominantGrievance(sources as Parameters<typeof dominantGrievance>[0]);
    if (!top) return null;
    const row = db.select({ id: agents.id, name: agents.name }).from(agents)
      .where(and(eq(agents.name, top.name), eq(agents.is_active, true))).get();
    return row && row.id !== agentId ? row : null;
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
