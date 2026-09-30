/**
 * Send one of each structured prompt (built by the real prompt builders from a
 * fixed fake agent) to a model and show what comes back and what the game's
 * parser makes of it. A fast check after editing a prompt or schema, and a
 * quick look at how a new model handles them — no server, and no live database: the prompt builders
 * read the live rules, so `throwawayDb.ts` points them at a scratch copy of the test schema.
 *
 *   npx tsx scripts/llm-smoke.ts [--model gemma4:26b] [--only plan.daily,goal.review]
 */
import './throwawayDb'; // first: the prompt builders reach server/db, which must never be the live world
import { callOllamaChat } from '../server/ai/ollama';
import { CONFIG } from '../server/lib/constants';
import type { LLMPurpose } from '../server/ai/llmMetrics';
import { buildDailyPlanPrompt, buildDecompositionPrompt, buildReplanPrompt } from '../server/lib/planning/planPrompts';
import { parsePlanBlocks, parseDecomposedActions } from '../server/lib/planning/planParser';
import { buildGoalReviewPrompt, buildPivotPrompt, buildAmbitionGenerationPrompt } from '../server/lib/goals/goalPrompts';
import { parseGoalReview, parsePivotResult, parseAmbitionGeneration } from '../server/lib/goals/goalParser';
import { buildQuestionPrompt, buildSynthesisPrompt } from '../server/lib/memory/reflectionPrompts';
import { parseQuestions, parseInsights } from '../server/lib/memory/reflectionParser';
import { buildConsentPrompt, parseConsent } from '../server/lib/intimacy/consentPrompt';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const MODEL = arg('model') ?? CONFIG.AI.LIGHT_MODEL;
const ONLY = arg('only')?.split(',');

const personality = { honesty: 40, aggression: 65, warmth: 30, impulsiveness: 70, vanity: 55, curiosity: 60, loyalty: 45, morality: 35, sensuality: 50, neuroticism: 60 };
const traits = ['sharp-tongued', 'ambitious', 'restless'];
const locations = ['Town Square', 'The Rusty Lantern', "Priya's Bakery", "Rosa's General Store", 'Riverside Park', 'The Pawnshop', 'Back Alley', 'Home 4'];
const people = ['Rosa Chen', 'Marco Rivera', 'Priya Sharma', 'James O\'Brien'];
const memories = [
  'Marco Rivera laughed at me in front of the whole tavern.',
  'I lost $20 at cards at The Rusty Lantern.',
  'Rosa Chen refused to extend my credit at the store.',
  'I saw Marco Rivera slip something into his coat at the pawnshop.',
  'Priya Sharma gave me a free loaf when I was broke.',
  'I noticed Marco Rivera nearby and struck up a conversation.',
  'I noticed Marco Rivera nearby and struck up a conversation.',
];

type Case = { purpose: LLMPurpose; prompt: { system: string; user: string; format: Record<string, unknown> }; numPredict: number; parse: (t: string) => unknown };

const cases: Case[] = [
  {
    purpose: 'plan.daily', numPredict: 700,
    prompt: buildDailyPlanPrompt({
      name: 'Diego Santos', age: 29, traits, personality, needs: { hunger: 30, energy: 70, social: 20, mood: 35, stress: 75 },
      home: 'Home 4', workplace: 'The Pawnshop', workStart: 9, workEnd: 17, wakeTime: 7, sleepTime: 23,
      goals: ['Get back at Marco Rivera for the humiliation'], reflections: ['Marco thinks he is better than me.'],
      yesterdayPlan: null, dayNumber: 4, validLocations: locations, economy: { money: 12, jobTitle: 'Pawnbroker', salary: 20 },
    }),
    parse: (t) => parsePlanBlocks(t, locations),
  },
  {
    purpose: 'plan.decompose', numPredict: 360,
    prompt: buildDecompositionPrompt({
      name: 'Diego Santos', age: 29, personality, traits, blockAction: 'Hang out at the tavern and watch Marco', locationHint: 'The Rusty Lantern',
      needs: { hunger: 30, energy: 70, social: 20 }, money: 12, startHour: 18, endHour: 21, validLocations: locations, validAgents: people,
    }),
    parse: (t) => parseDecomposedActions(t, locations, people),
  },
  {
    purpose: 'plan.revise', numPredict: 600,
    prompt: buildReplanPrompt({
      name: 'Diego Santos', age: 29, personality, traits, eventDescription: 'Marco Rivera accused you of theft in the town square.',
      remainingBlocks: [{ start_hour: 15, end_hour: 17, broad_action: 'Mind the pawnshop', location_hint: 'The Pawnshop' }, { start_hour: 17, end_hour: 23, broad_action: 'Drinks at the tavern', location_hint: 'The Rusty Lantern' }],
      needs: { hunger: 30, energy: 60, social: 20 }, currentHour: 15, sleepTime: 23, validLocations: locations,
    }),
    parse: (t) => parsePlanBlocks(t, locations, 1),
  },
  {
    purpose: 'goal.review', numPredict: 700,
    prompt: buildGoalReviewPrompt({
      name: 'Diego Santos', age: 29, personality, traits, ambition: { description: 'Own the biggest shop in town', type: 'wealth' },
      activeGoals: [{ id: 17, description: 'Get back at Marco Rivera', strategy: 'Spread rumors about him', progress: 0.1, daysActive: 2 }],
      recentMemories: memories, relationshipHighlights: ['Marco Rivera: friendship=-45', 'Priya Sharma: friendship=35'],
      money: 12, job: 'pawnbroker', dayNumber: 4, openSlots: 2, otherAgents: people,
    }),
    parse: parseGoalReview,
  },
  {
    purpose: 'goal.pivot', numPredict: 200,
    prompt: buildPivotPrompt({ name: 'Diego Santos', age: 29, personality, goalDescription: 'Win Priya Sharma\'s trust', strategy: 'Buy bread every day', progress: 0, daysActive: 2, recentMemories: memories }),
    parse: parsePivotResult,
  },
  {
    purpose: 'goal.ambition', numPredict: 250,
    prompt: buildAmbitionGenerationPrompt({ name: 'Diego Santos', age: 29, personality, traits, recentMemories: memories, money: 12, job: 'pawnbroker', relationshipHighlights: ['Marco Rivera: friendship=-45'] }),
    parse: parseAmbitionGeneration,
  },
  {
    purpose: 'reflection.questions', numPredict: 256,
    prompt: buildQuestionPrompt({ name: 'Diego Santos', age: 29, traits, personality, recentMemories: memories.map((description) => ({ description, importance: 5 })), ambition: 'Own the biggest shop in town' }),
    parse: parseQuestions,
  },
  {
    purpose: 'reflection.insights', numPredict: 512,
    prompt: buildSynthesisPrompt({ name: 'Diego Santos', personality, traits, questions: ['Why does Marco keep humiliating me?', 'Can I afford to stay in this town?', 'Who here is actually on my side?'], evidence: memories.slice(0, 5).map((description, i) => ({ lineNum: i + 1, description })) }),
    parse: parseInsights,
  },
  {
    // Adult layer: did the one who was asked say yes? Two transcripts (a warm yes and a polite no)
    // so a model that answers "accepted" for both shows up as a wrong answer, not an OK. The prompt
    // module is pure (no database), like the other builders here.
    purpose: 'intimacy.consent', numPredict: 80,
    prompt: buildConsentPrompt({
      lines: [
        { speakerId: 1, speaker: 'Diego Santos', text: 'Lucia, would you spend the evening with me, somewhere quiet?' },
        { speakerId: 2, speaker: 'Lucia Fernandez', text: 'I would like that very much, Diego. Come by the house after supper.' },
      ],
      initiatorName: 'Diego Santos', answererId: 2, answererName: 'Lucia Fernandez', willingness: 0.8,
    }),
    parse: (t) => { const r = parseConsent(t); return r?.accepted === true ? r : null; },
  },
  {
    purpose: 'intimacy.consent', numPredict: 80,
    prompt: buildConsentPrompt({
      lines: [
        { speakerId: 1, speaker: 'Diego Santos', text: 'Lucia, would you spend the evening with me, somewhere quiet?' },
        { speakerId: 2, speaker: 'Lucia Fernandez', text: 'That is kind of you, Diego, but no. I am not ready for that.' },
      ],
      initiatorName: 'Diego Santos', answererId: 2, answererName: 'Lucia Fernandez', willingness: 0.5,
    }),
    parse: (t) => { const r = parseConsent(t); return r?.accepted === false ? r : null; },
  },
];

async function main() {
  console.log(`model: ${MODEL}\n`);
  for (const c of cases) {
    if (ONLY && !ONLY.includes(c.purpose)) continue;
    const t0 = performance.now();
    try {
      const r = await callOllamaChat({
        model: MODEL, purpose: c.purpose, system: c.prompt.system,
        messages: [{ role: 'user', content: c.prompt.user }], format: c.prompt.format,
        options: { temperature: 0.7, num_predict: c.numPredict },
      });
      const parsed = c.parse(r.text);
      const ok = Array.isArray(parsed) ? parsed.length > 0 : parsed != null;
      console.log(`── ${c.purpose}  ${Math.round(performance.now() - t0)} ms  ${ok ? 'OK' : 'PARSE FAIL'}${r.truncated ? ' TRUNCATED' : ''}`);
      console.log(r.text.replace(/\s+/g, ' ').slice(0, 900), '\n');
    } catch (e) {
      console.log(`── ${c.purpose}  ERROR ${(e as Error).message}\n`);
    }
  }
}

main();
