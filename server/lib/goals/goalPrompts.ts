import type { PersonalityProfile } from '../personality';
import { maturityDirective } from '../../ai/contentRating';
import { TOWN_SETTING } from '../../ai/setting';
import { isAdultContent } from '../worldRules';

interface GoalReviewPromptParams {
  name: string;
  personality: PersonalityProfile;
  traits: string[];
  ambition: { description: string; type: string } | null;
  activeGoals: { id: number; description: string; strategy: string; progress: number; daysActive: number }[];
  recentMemories: string[];
  relationshipHighlights: string[];
  money: number;
  job: string | null;
  dayNumber: number;
  /** How many new goals fit (MAX_LLM_GOALS minus active ones). */
  openSlots: number;
  /** Everyone else in town — the only valid `target_agent` values. */
  otherAgents: string[];
}

interface PivotPromptParams {
  name: string;
  personality: PersonalityProfile;
  goalDescription: string;
  strategy: string;
  progress: number;
  daysActive: number;
  recentMemories: string[];
}

interface AmbitionGenerationParams {
  name: string;
  personality: PersonalityProfile;
  traits: string[];
  recentMemories: string[];
  money: number;
  job: string | null;
  relationshipHighlights: string[];
}

export const AMBITION_CATEGORIES = ['wealth', 'love', 'power', 'freedom', 'justice', 'knowledge', 'legacy', 'pleasure'];
export const GOAL_CATEGORY_HINTS = ['romantic', 'hostile', 'social', 'economic', 'investigative', 'protective', 'custom'];

/**
 * Structured-output schemas (callOllamaChat `format`). Before them the review
 * was free JSON under a template that was not itself valid JSON
 * (`"ambition": "keep" OR {...}`, `"priority": 0.0-1.0`): ~10% of reviews and
 * ~60% of pivots could not be parsed, and a failed pivot abandons the goal.
 * The grammar also pins ids, names and categories to real values and caps the
 * free-text fields, which the model otherwise filled with paragraphs until
 * the token cap cut the JSON in half.
 */
const SHORT = (max: number) => ({ type: 'string', minLength: 3, maxLength: max });

export interface JSONPrompt {
  system: string;
  user: string;
  format: Record<string, unknown>;
}

function goalReviewSchema(goalIds: number[], openSlots: number, otherAgents: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ambition: {
      anyOf: [
        { type: 'string', enum: ['keep'] },
        {
          type: 'object',
          properties: { shift: SHORT(140), category: { type: 'string', enum: AMBITION_CATEGORIES }, reason: SHORT(160) },
          required: ['shift', 'category', 'reason'],
        },
      ],
    },
  };
  const required = ['ambition'];
  if (goalIds.length > 0) {
    properties.reviews = {
      type: 'array',
      maxItems: goalIds.length,
      items: {
        type: 'object',
        properties: {
          goal_id: { type: 'integer', enum: goalIds },
          action: { type: 'string', enum: ['continue', 'adjust', 'abandon'] },
          reason: SHORT(160),
          new_strategy: SHORT(160),
        },
        required: ['goal_id', 'action', 'reason'],
      },
    };
    required.push('reviews');
  }
  if (openSlots > 0) {
    properties.new_goals = {
      type: 'array',
      maxItems: openSlots,
      items: {
        type: 'object',
        properties: {
          description: SHORT(120),
          target_agent: otherAgents.length > 0
            ? { anyOf: [{ type: 'string', enum: otherAgents }, { type: 'null' }] }
            : { type: 'null' },
          category_hint: { type: 'string', enum: GOAL_CATEGORY_HINTS },
          strategy: SHORT(160),
          priority: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['description', 'target_agent', 'category_hint', 'strategy', 'priority'],
      },
    };
    required.push('new_goals');
  }
  return { type: 'object', properties, required };
}

function personalitySummary(p: PersonalityProfile): string {
  const axes: string[] = [];
  if (p.aggression > 60) axes.push('aggressive');
  else if (p.aggression < 30) axes.push('peaceful');
  if (p.warmth > 60) axes.push('warm');
  else if (p.warmth < 30) axes.push('cold');
  if (p.curiosity > 60) axes.push('curious');
  if (p.neuroticism > 60) axes.push('anxious');
  else if (p.neuroticism < 30) axes.push('emotionally stable');
  if (p.impulsiveness > 60) axes.push('impulsive');
  if (p.morality > 60) axes.push('principled');
  else if (p.morality < 30) axes.push('amoral');
  if (p.sensuality > 60) axes.push('sensual');
  if (p.vanity > 60) axes.push('vain');
  if (p.loyalty > 60) axes.push('loyal');
  return axes.length > 0 ? axes.join(', ') : 'balanced';
}

export function buildGoalReviewPrompt(params: GoalReviewPromptParams): JSONPrompt {
  const { name, personality, traits, ambition, activeGoals, recentMemories, relationshipHighlights, money, job, dayNumber, openSlots, otherAgents } = params;
  const pSummary = personalitySummary(personality);
  const traitsList = traits.join(', ');
  const ambitionText = ambition ? `Your life ambition: "${ambition.description}" (${ambition.type})` : 'You do not have a life ambition yet.';
  const goalsText = activeGoals.length > 0
    ? activeGoals.map(g => `- goal ${g.id}: "${g.description}" (strategy: ${g.strategy || 'none yet'}; ${Math.round(g.progress * 100)}% done, ${g.daysActive} days in)`).join('\n')
    : '- none';
  const memoriesText = recentMemories.length > 0 ? recentMemories.map((m) => `- ${m}`).join('\n') : '- Nothing notable recently.';
  const relationshipsText = relationshipHighlights.length > 0 ? relationshipHighlights.map((r) => `- ${r}`).join('\n') : '- No notable relationships.';

  const tasks = [
    'Keep your ambition ("keep") unless recent events truly changed what you want.',
    activeGoals.length > 0 ? 'For each active goal decide: continue, adjust (give a new strategy) or abandon.' : '',
    openSlots > 0
      ? `You may start up to ${openSlots} new goal${openSlots > 1 ? 's' : ''} — things you want over the next few days, driven by your personality, ambition and what just happened; not errands like eating, sleeping or a hangover cure. Use target_agent when a goal is about one person.`
      : 'You have no room for new goals today.',
    'Keep every text field to one short sentence.',
  ].filter(Boolean).join(' ');

  const system = `You are ${name}, living in a small town. Day ${dayNumber}. ${TOWN_SETTING} ${maturityDirective(isAdultContent())}
Personality: ${pSummary}. Traits: ${traitsList}.
Money: $${Math.round(money)}. Job: ${job ?? 'unemployed'}.

${ambitionText}

Active goals:
${goalsText}

Recent memories:
${memoriesText}

Key relationships:
${relationshipsText}

It's morning. ${tasks}

Reply with JSON: {"ambition":"keep" or {"shift":"...","category":"...","reason":"..."}${activeGoals.length > 0 ? ',"reviews":[{"goal_id":N,"action":"continue|adjust|abandon","reason":"...","new_strategy":"..."}]' : ''}${openSlots > 0 ? ',"new_goals":[{"description":"...","target_agent":"Full Name" or null,"category_hint":"...","strategy":"...","priority":0.5}]' : ''}}`;

  const user = 'Review your ambition and goals for today.';
  return { system, user, format: goalReviewSchema(activeGoals.map((g) => g.id), openSlots, otherAgents) };
}

export function buildPivotPrompt(params: PivotPromptParams): JSONPrompt {
  const { name, personality, goalDescription, strategy, progress, daysActive, recentMemories } = params;
  const pSummary = personalitySummary(personality);
  const memoriesText = recentMemories.length > 0 ? recentMemories.map((m) => `- ${m}`).join('\n') : '- Nothing notable recently.';

  const system = `You are ${name}. Personality: ${pSummary}. ${TOWN_SETTING} ${maturityDirective(isAdultContent())}

For ${daysActive} days you have pursued this goal with ${Math.round(progress * 100)}% progress:
Goal: "${goalDescription}"
Strategy: "${strategy}"

It isn't working. Recent memories:
${memoriesText}

Pick a different, concrete approach — something you would actually do in town in the next day or two. One sentence.

Reply with JSON: {"new_strategy":"...","new_category_hint":"${GOAL_CATEGORY_HINTS.join('|')}"}`;

  const user = 'What new approach will you try?';
  return {
    system,
    user,
    format: {
      type: 'object',
      properties: { new_strategy: SHORT(200), new_category_hint: { type: 'string', enum: GOAL_CATEGORY_HINTS } },
      required: ['new_strategy', 'new_category_hint'],
    },
  };
}

export function buildAmbitionGenerationPrompt(params: AmbitionGenerationParams): JSONPrompt {
  const { name, personality, traits, recentMemories, money, job, relationshipHighlights } = params;
  const pSummary = personalitySummary(personality);
  const traitsList = traits.join(', ');
  const memoriesText = recentMemories.length > 0 ? recentMemories.map((m) => `- ${m}`).join('\n') : '- Starting a new life.';
  const relationshipsText = relationshipHighlights.length > 0 ? relationshipHighlights.map((r) => `- ${r}`).join('\n') : '- No close relationships yet.';

  const system = `You are ${name}, living in a small town. ${TOWN_SETTING} ${maturityDirective(isAdultContent())}
Personality: ${pSummary}. Traits: ${traitsList}.
Money: $${Math.round(money)}. Job: ${job ?? 'unemployed'}.

Your memories:
${memoriesText}

Relationships:
${relationshipsText}

What is your deepest life ambition — the one thing you want most? Make it personal and specific to you, in one sentence.

Reply with JSON: {"description":"...","category":"${AMBITION_CATEGORIES.join('|')}","reason":"..."}`;

  const user = 'What is your life ambition?';
  return {
    system,
    user,
    format: {
      type: 'object',
      properties: { description: SHORT(200), category: { type: 'string', enum: AMBITION_CATEGORIES }, reason: SHORT(200) },
      required: ['description', 'category', 'reason'],
    },
  };
}
