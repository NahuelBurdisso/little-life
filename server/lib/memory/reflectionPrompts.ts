import { buildPersonalityDescription } from '../personality';
import type { PersonalityProfile } from '../personality';

export interface QuestionPromptParams {
  name: string;
  age: number;
  traits: string[];
  personality: PersonalityProfile;
  recentMemories: Array<{ description: string; importance: number }>;
  ambition?: string | null;
  activeGoals?: string[];
}

export interface SynthesisPromptParams {
  name: string;
  personality: PersonalityProfile;
  traits: string[];
  questions: string[];
  evidence: Array<{ lineNum: number; description: string }>;
}

export interface JSONPrompt {
  system: string;
  user: string;
  /** Structured-output schema for callOllamaChat's `format`. */
  format: Record<string, unknown>;
}

/**
 * Collapse repeated memories into one line with a count. The observation
 * stream repeats itself ("I noticed Diego Santos nearby…" dozens of times a
 * day), and fifty recent memories were often a dozen distinct ones — the rest
 * was the largest prompt in the game spent on duplicates.
 */
function collapseRepeats(descriptions: string[]): string[] {
  const counts = new Map<string, number>();
  for (const d of descriptions) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].map(([d, n]) => (n > 1 ? `${d} (×${n})` : d));
}

export function buildQuestionPrompt(params: QuestionPromptParams): JSONPrompt {
  const { name, age, traits, personality, recentMemories } = params;

  const personalityDesc = buildPersonalityDescription(personality, traits);

  const memoriesList = collapseRepeats(recentMemories.map((m) => m.description))
    .map((d) => `- ${d}`)
    .join('\n');

  const ambitionLine = params.ambition ? `Your life ambition: ${params.ambition}` : '';
  const goalsLine = params.activeGoals?.length ? `Current goals: ${params.activeGoals.join('; ')}` : '';
  const contextLines = [ambitionLine, goalsLine].filter(Boolean).join('\n');

  const system = `You are ${name}, ${age}. ${personalityDesc}
${contextLines ? '\n' + contextLines + '\n' : ''}
Your recent experiences:
${memoriesList}

What are the 3 questions about your life you most need to answer right now? Think about patterns, worries and what matters to someone like you${params.ambition ? ', and how it all bears on your ambition' : ''}. Ask them in your own words, first person, each one short and specific (name people and places).

Reply with JSON: {"questions":["...","...","..."]}`;

  return {
    system,
    user: 'Reflect on your recent experiences.',
    format: {
      type: 'object',
      properties: {
        questions: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 8, maxLength: 160 } },
      },
      required: ['questions'],
    },
  };
}

export function buildSynthesisPrompt(params: SynthesisPromptParams): JSONPrompt {
  const { name, personality, traits, questions, evidence } = params;

  const personalityDesc = buildPersonalityDescription(personality, traits);

  const questionsList = questions.map((q) => `- ${q}`).join('\n');
  const evidenceList = evidence.map((e) => `${e.lineNum}. ${e.description}`).join('\n');
  const lineNums = evidence.map((e) => e.lineNum);

  // Insights are stored as the agent's own memories and later quoted back in
  // conversation and planning prompts, so they must read like private
  // thoughts: first person, plain sentences. Playtest insights came back
  // addressed to "you" (as if advising the player), wrapped in **markdown**,
  // or with an in-character preamble ("Right. Reflections. I suppose…").
  const system = `You are ${name}. ${personalityDesc}

You are thinking about:
${questionsList}

What you remember:
${evidenceList}

Write 2-4 insights you draw about your life and the people in it — what you now believe, suspect or feel. Each is one plain first-person sentence ("I…", "Marco…"), specific, true to your personality, and cites the numbers of the memories behind it.

Reply with JSON: {"insights":[{"insight":"...","because":[1,4]}, ...]}`;

  return {
    system,
    user: 'Share your reflections.',
    format: {
      type: 'object',
      properties: {
        insights: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              insight: { type: 'string', minLength: 10, maxLength: 240 },
              because: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'integer', enum: lineNums } },
            },
            required: ['insight', 'because'],
          },
        },
      },
      required: ['insights'],
    },
  };
}
