/**
 * SnapResolver
 *
 * When an agent's tension crosses their snap threshold, makes ONE LLM call
 * to decide how they react (their "snap action").
 */

import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import type { SnapAction } from './cascadeTypes';

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
    tensionSources: Array<{ event: string; description: string; tick: number }>,
    metadata: Record<string, unknown>
  ): Promise<void> {
    // Stub — Task 8 wires up actual DB writes
    console.log(
      `[SnapResolver] executeSnapAction stub: agent=${agentId}, action=${action}, sources=${tensionSources.length}, metadata=${JSON.stringify(metadata)}`
    );
  }
}
