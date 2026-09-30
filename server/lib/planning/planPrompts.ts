import { buildPersonalityDescription } from '../personality';
import type { PersonalityProfile } from '../personality';
import { TOWN_SETTING } from '../../ai/setting';

function describeMoneyLevel(money: number): string {
  if (money < 10) return 'CRITICAL — nearly broke, avoid spending';
  if (money < 25) return 'LOW — watch your spending';
  if (money < 50) return 'MODERATE';
  if (money < 100) return 'COMFORTABLE';
  return 'WEALTHY — you have savings';
}

/**
 * Needs as words. Every need is 0-100 *satisfaction* (the engine eats at
 * hunger < critical), except stress. The plan prompts used to label hunger the
 * other way round — a fed agent read "very hungry" and planned three meals, a
 * starving one read "satisfied" — and printed the raw floats
 * ("73.4830922486441/100"), which cost tokens and invited the model to quote them.
 */
export function describeNeeds(needs: Partial<Record<'hunger' | 'energy' | 'social' | 'mood' | 'stress', number>>): string {
  const band = (v: number, steps: Array<[number, string]>, top: string) =>
    steps.find(([limit]) => v < limit)?.[1] ?? top;
  const parts: string[] = [];
  if (needs.hunger != null) parts.push(`hunger: ${band(needs.hunger, [[20, 'starving'], [40, 'hungry'], [65, 'could eat']], 'well fed')}`);
  if (needs.energy != null) parts.push(`energy: ${band(needs.energy, [[20, 'exhausted'], [45, 'tired']], 'rested')}`);
  if (needs.social != null) parts.push(`social: ${band(needs.social, [[25, 'lonely'], [50, 'a bit isolated']], 'socially fulfilled')}`);
  if (needs.mood != null) parts.push(`mood: ${band(needs.mood, [[30, 'low'], [60, 'okay']], 'good')}`);
  if (needs.stress != null) parts.push(`stress: ${needs.stress > 70 ? 'very stressed' : needs.stress > 40 ? 'somewhat stressed' : 'calm'}`);
  return parts.join(', ');
}

/**
 * What an action should look like. Actions used to come back as whole
 * paragraphs of reasoning ("I need to take a moment to gather my thoughts
 * and…"): 3/4 of daily plans hit the 512-token cap and lost their evening,
 * and every plan was copied into the memory stream, where those paragraphs
 * then filled reflection and goal prompts.
 */
const ACTION_STYLE = `Each action is a short phrase of 3-8 words, no "I" and no reasons — e.g. "Open the shop and restock shelves", "Lunch with Marco Rivera", "Walk by the river to clear my head". Name the person if you plan to meet someone.`;

/** JSON schema for a list of hour blocks; `location` is limited to real places. */
export function planBlocksSchema(validLocations: string[], minBlocks: number, maxBlocks: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        minItems: minBlocks,
        maxItems: maxBlocks,
        items: {
          type: 'object',
          properties: {
            start: { type: 'integer', minimum: 0, maximum: 23 },
            end: { type: 'integer', minimum: 1, maximum: 24 },
            // A safety net, not the target length: the grammar cuts at the
            // limit mid-word. The prompt asks for 3-8 words.
            action: { type: 'string', minLength: 3, maxLength: 90 },
            location: { type: 'string', enum: validLocations },
          },
          required: ['start', 'end', 'action', 'location'],
        },
      },
    },
    required: ['blocks'],
  };
}

export interface PlanPrompt {
  system: string;
  user: string;
  /** Structured-output schema for callOllamaChat's `format`. */
  format: Record<string, unknown>;
}

export interface DailyPlanPromptParams {
  name: string;
  age: number;
  traits: string[];
  personality: PersonalityProfile;
  needs: { hunger: number; energy: number; social: number; mood: number; stress: number };
  home: string;
  workplace: string | null;
  workStart: number;
  workEnd: number;
  wakeTime: number;
  sleepTime: number;
  goals: string[];
  reflections: string[];
  yesterdayPlan: string | null;
  dayNumber: number;
  validLocations: string[];
  economy?: { money: number; job?: string; jobTitle?: string; salary?: number };
  selfDescription?: string;
  hobbies?: Array<{ hobby: string; level: number }>;
  reputationLabel?: string;
  moodMomentum?: number;
  /** One line about children / a baby on the way (lib/familyState.ts `familyPlanLine`). */
  family?: string;
  /**
   * The town calendar for today and tomorrow ("Tomorrow is the Harvest
   * Festival at Town Square…") and a candidate's campaign
   * (lib/townCalendar.ts `planCalendarNote`). Without it residents planned an
   * ordinary day and walked past the fair.
   */
  calendar?: string[];
}

export interface DecompositionPromptParams {
  name: string;
  personality: PersonalityProfile;
  traits: string[];
  blockAction: string;
  locationHint: string;
  needs: { hunger: number; energy: number; social: number };
  money?: number;
  startHour: number;
  endHour: number;
  validLocations: string[];
  validAgents: string[];
}

export interface ReplanPromptParams {
  name: string;
  personality: PersonalityProfile;
  traits: string[];
  eventDescription: string;
  remainingBlocks: Array<{
    start_hour: number;
    end_hour: number;
    broad_action: string;
    location_hint: string;
  }>;
  needs: { hunger: number; energy: number; social: number };
  currentHour: number;
  sleepTime: number;
  validLocations: string[];
}

export function buildDailyPlanPrompt(params: DailyPlanPromptParams): PlanPrompt {
  const {
    name,
    age,
    traits,
    personality,
    needs,
    home,
    workplace,
    workStart,
    workEnd,
    wakeTime,
    sleepTime,
    goals,
    reflections,
    yesterdayPlan,
    dayNumber,
    validLocations,
  } = params;

  const personalityDesc = buildPersonalityDescription(personality, traits);

  const workInfo = workplace
    ? `You work at ${workplace} from ${workStart}:00 to ${workEnd}:00.`
    : 'You do not have a job today.';

  const goalsList = goals.length > 0
    ? goals.map((g) => `- ${g}`).join('\n')
    : '- Nothing in particular.';

  const reflectionsList = reflections.length > 0
    ? `\nOn your mind lately:\n${reflections.map((r) => `- ${r}`).join('\n')}\n`
    : '';

  const yesterdaySection = yesterdayPlan
    ? `\nYesterday: ${yesterdayPlan}\n`
    : '';

  const calendarSection = params.calendar && params.calendar.length > 0
    ? `\nIn town: ${params.calendar.join(' ')}\n`
    : '';

  const extras = [
    params.economy
      ? `Money: $${Math.round(params.economy.money)} (${describeMoneyLevel(params.economy.money)})${params.economy.jobTitle ? `; ${params.economy.jobTitle}, $${params.economy.salary}/day` : '; unemployed'}.`
      : '',
    params.hobbies && params.hobbies.length > 0
      ? `Hobbies: ${params.hobbies.map((h) => `${h.hobby} (lv${h.level})`).join(', ')}.`
      : '',
    params.reputationLabel ? `Reputation: ${params.reputationLabel}.` : '',
    params.family ?? '',
    params.moodMomentum && Math.abs(params.moodMomentum) > 3
      ? `Lately you've been ${params.moodMomentum > 0 ? 'getting happier' : 'going through a rough patch'}.`
      : '',
  ].filter(Boolean).join('\n');

  const system = `You are ${name}, ${age}. It is day ${dayNumber}. ${personalityDesc}
${TOWN_SETTING}
${params.selfDescription ? `\nAbout yourself: ${params.selfDescription}\n` : ''}
Right now — ${describeNeeds(needs)}.
Home: ${home}. ${workInfo} You wake at ${wakeTime}:00 and sleep at ${sleepTime}:00.
${extras}

Your goals:
${goalsList}
${reflectionsList}${yesterdaySection}${calendarSection}
Places in town: ${validLocations.join(', ')}

Plan your day from ${wakeTime}:00 to ${sleepTime}:00 in 5-8 back-to-back blocks of whole hours. Include your work hours if you work, meals, and time for what you need or want today, true to your personality. ${ACTION_STYLE}

Reply with JSON: {"blocks":[{"start":${wakeTime},"end":${wakeTime + 1},"action":"...","location":"..."}, ...]}`;

  return {
    system,
    user: 'Plan your day.',
    format: planBlocksSchema(validLocations, 3, 10),
  };
}

export function buildDecompositionPrompt(params: DecompositionPromptParams): PlanPrompt {
  const {
    name,
    personality,
    traits,
    blockAction,
    locationHint,
    needs,
    startHour,
    endHour,
    validLocations,
    validAgents,
  } = params;

  const personalityDesc = buildPersonalityDescription(personality, traits);
  const durationMinutes = (endHour - startHour) * 60;

  const system = `You are ${name}. ${personalityDesc}
${TOWN_SETTING}

From ${startHour}:00 to ${endHour}:00 (${durationMinutes} minutes) you planned to: ${blockAction}
Where: ${locationHint}
Right now — ${describeNeeds(needs)}.${params.money != null ? ` Money: $${Math.round(params.money)} (${describeMoneyLevel(params.money)}).` : ''}
People in town: ${validAgents.length > 0 ? validAgents.join(', ') : 'nobody else.'}
Places in town: ${validLocations.join(', ')}

Break this time into 2-4 concrete things you actually do, in order, adding up to about ${durationMinutes} minutes. ${ACTION_STYLE}

Reply with JSON: {"actions":[{"action":"...","location":"...","minutes":30}, ...]}`;

  return {
    system,
    user: 'What specifically will you do?',
    format: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', minLength: 3, maxLength: 90 },
              location: { type: 'string', enum: validLocations },
              minutes: { type: 'integer', minimum: 5, maximum: 240 },
            },
            required: ['action', 'location', 'minutes'],
          },
        },
      },
      required: ['actions'],
    },
  };
}

export function buildReplanPrompt(params: ReplanPromptParams): PlanPrompt {
  const {
    name,
    personality,
    traits,
    eventDescription,
    remainingBlocks,
    needs,
    currentHour,
    sleepTime,
    validLocations,
  } = params;

  const personalityDesc = buildPersonalityDescription(personality, traits);

  const originalPlan = remainingBlocks.length > 0
    ? remainingBlocks
        .map((b) => `- ${b.start_hour}:00-${b.end_hour}:00 ${b.broad_action} (${b.location_hint})`)
        .join('\n')
    : '- Nothing planned.';

  const system = `You are ${name}. ${personalityDesc}
${TOWN_SETTING}

Something just happened: ${eventDescription}

It is ${currentHour}:00. The rest of your day was going to be:
${originalPlan}

Right now — ${describeNeeds(needs)}. You need to sleep by ${sleepTime}:00.
Places in town: ${validLocations.join(', ')}

Revise the rest of your day, ${currentHour}:00 to ${sleepTime}:00, in 1-6 back-to-back blocks of whole hours. Keep what still makes sense and change what this event changes for someone like you. ${ACTION_STYLE}

Reply with JSON: {"blocks":[{"start":${currentHour},"end":${Math.min(currentHour + 1, 24)},"action":"...","location":"..."}, ...]}`;

  return {
    system,
    user: 'Revise your plan.',
    format: planBlocksSchema(validLocations, 1, 8),
  };
}
