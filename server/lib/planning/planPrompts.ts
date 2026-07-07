import { buildPersonalityDescription } from '../personality';
import type { PersonalityProfile } from '../personality';

function describeMoneyLevel(money: number): string {
  if (money < 10) return 'CRITICAL — nearly broke, avoid spending';
  if (money < 25) return 'LOW — watch your spending';
  if (money < 50) return 'MODERATE';
  if (money < 100) return 'COMFORTABLE';
  return 'WEALTHY — you have savings';
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

export function buildDailyPlanPrompt(params: DailyPlanPromptParams): { system: string; user: string } {
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

  const needsDesc = [
    `Hunger: ${needs.hunger}/100${needs.hunger > 70 ? ' (very hungry)' : needs.hunger > 40 ? ' (peckish)' : ' (satisfied)'}`,
    `Energy: ${needs.energy}/100${needs.energy < 30 ? ' (exhausted)' : needs.energy < 60 ? ' (tired)' : ' (rested)'}`,
    `Social: ${needs.social}/100${needs.social < 30 ? ' (lonely)' : needs.social < 60 ? ' (a bit isolated)' : ' (socially fulfilled)'}`,
    `Mood: ${needs.mood}/100${needs.mood < 30 ? ' (low)' : needs.mood < 60 ? ' (neutral)' : ' (good)'}`,
    `Stress: ${needs.stress}/100${needs.stress > 70 ? ' (very stressed)' : needs.stress > 40 ? ' (somewhat stressed)' : ' (calm)'}`,
  ].join('\n');

  const workInfo = workplace
    ? `You work at ${workplace} from ${workStart}:00 to ${workEnd}:00.`
    : 'You do not have a job today.';

  const goalsList = goals.length > 0
    ? goals.map((g, i) => `${i + 1}. ${g}`).join('\n')
    : 'No particular goals right now.';

  const reflectionsList = reflections.length > 0
    ? reflections.map((r, i) => `${i + 1}. ${r}`).join('\n')
    : 'No recent reflections.';

  const yesterdaySection = yesterdayPlan
    ? `Yesterday's plan:\n${yesterdayPlan}`
    : 'No plan from yesterday.';

  const locationsList = validLocations.join(', ');

  const system = `You are ${name}, a ${age}-year-old on day ${dayNumber} of your life. ${personalityDesc}
${params.selfDescription ? `\nAbout yourself: ${params.selfDescription}` : ''}
Current needs:
${needsDesc}

Home: ${home}
${workInfo}
Wake time: ${wakeTime}:00
Sleep time: ${sleepTime}:00

Your goals:
${goalsList}

Recent reflections:
${reflectionsList}

${yesterdaySection}
${params.economy ? `
Your finances:
- Money: $${Math.round(params.economy.money)} (${describeMoneyLevel(params.economy.money)})
- ${params.economy.jobTitle ? `Job: ${params.economy.jobTitle}, salary $${params.economy.salary}/day` : 'Unemployed'}` : ''}${params.hobbies && params.hobbies.length > 0 ? `
Your hobbies: ${params.hobbies.map(h => `${h.hobby} (lv${h.level})`).join(', ')}` : ''}${params.reputationLabel ? `
Reputation: ${params.reputationLabel}` : ''}${params.moodMomentum && Math.abs(params.moodMomentum) > 3 ? `
Mood trend: ${params.moodMomentum > 0 ? 'getting happier' : 'going through a rough patch'}` : ''}
Available locations: ${locationsList}

Plan your day in 5-8 time blocks from ${wakeTime}:00 to ${sleepTime}:00. Each block should be a meaningful chunk of time. Account for meals, work if applicable, social time, and personal needs based on your current state.

Format each block exactly as:
HH:00-HH:00 | action description | location

Use only locations from the available list. Be specific about what you will do and why it fits your personality and needs. No numbering, no extra commentary.`;

  return {
    system,
    user: 'Plan your day.',
  };
}

export function buildDecompositionPrompt(params: DecompositionPromptParams): { system: string; user: string } {
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

  const durationHours = endHour - startHour;
  const durationMinutes = durationHours * 60;

  const needsDesc = [
    `Hunger: ${needs.hunger}/100`,
    `Energy: ${needs.energy}/100`,
    `Social: ${needs.social}/100`,
  ].join(', ');

  const locationsList = validLocations.join(', ');
  const agentsList = validAgents.length > 0
    ? validAgents.join(', ')
    : 'No one else nearby.';

  const system = `You are ${name}. ${personalityDesc}

You have a ${durationMinutes}-minute block from ${startHour}:00 to ${endHour}:00 to: ${blockAction}
Primary location: ${locationHint}

Current needs: ${needsDesc}
${params.money != null ? `Your money: $${Math.round(params.money)} (${describeMoneyLevel(params.money)})` : ''}
People you know who may be around: ${agentsList}
Available locations: ${locationsList}

Break this block into 2-4 specific actions you will actually perform. Consider your personality, current needs, and who might be nearby.

If you plan to socialize, name the specific person (e.g., "Chat with Rosa Chen about her research"). Use full names from the people list above.

Format each action exactly as:
action description | location | duration in minutes

Durations must sum to ${durationMinutes} minutes. Use only locations from the available list. No numbering, no extra commentary.`;

  return {
    system,
    user: 'What specifically will you do?',
  };
}

export function buildReplanPrompt(params: ReplanPromptParams): { system: string; user: string } {
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

  const needsDesc = [
    `Hunger: ${needs.hunger}/100${needs.hunger > 70 ? ' (very hungry)' : needs.hunger > 40 ? ' (peckish)' : ' (satisfied)'}`,
    `Energy: ${needs.energy}/100${needs.energy < 30 ? ' (exhausted)' : needs.energy < 60 ? ' (tired)' : ' (rested)'}`,
    `Social: ${needs.social}/100${needs.social < 30 ? ' (lonely)' : needs.social < 60 ? ' (a bit isolated)' : ' (socially fulfilled)'}`,
  ].join('\n');

  const originalPlan = remainingBlocks.length > 0
    ? remainingBlocks
        .map(b => `${b.start_hour}:00-${b.end_hour}:00 | ${b.broad_action} | ${b.location_hint}`)
        .join('\n')
    : 'No remaining blocks planned.';

  const locationsList = validLocations.join(', ');

  const system = `You are ${name}. ${personalityDesc}

Something unexpected happened: ${eventDescription}

It is currently ${currentHour}:00. Your original plan for the rest of the day was:
${originalPlan}

Current needs:
${needsDesc}

You need to sleep by ${sleepTime}:00.

Available locations: ${locationsList}

Revise your plan for the rest of the day in 2-8 time blocks from ${currentHour}:00 to ${sleepTime}:00. Take into account what just happened and how your personality would respond.

Format each block exactly as:
HH:00-HH:00 | action description | location

Use only locations from the available list. No numbering, no extra commentary.`;

  return {
    system,
    user: 'Revise your plan.',
  };
}
