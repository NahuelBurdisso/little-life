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

export function buildQuestionPrompt(params: QuestionPromptParams): { system: string; user: string } {
  const { name, age, traits, personality, recentMemories } = params;

  const personalityDesc = buildPersonalityDescription(personality, traits);

  const memoriesList = recentMemories
    .map((m, i) => `${i + 1}. ${m.description} (importance: ${m.importance})`)
    .join('\n');

  const ambitionLine = params.ambition ? `Your life ambition: ${params.ambition}` : '';
  const goalsLine = params.activeGoals?.length ? `Current goals: ${params.activeGoals.join('; ')}` : '';
  const contextLines = [ambitionLine, goalsLine].filter(Boolean).join('\n');

  const system = `You are ${name}, a ${age}-year-old. ${personalityDesc}
${contextLines ? '\n' + contextLines + '\n' : ''}
Here are your recent experiences:
${memoriesList}

Given these experiences, what are the 3 most important questions you'd ask yourself right now? Consider what patterns you notice, what concerns you, what matters most to you given your personality${params.ambition ? ', and how these relate to your ambition' : ''}.

Respond with exactly 3 questions, one per line. No numbering, no explanation.`;

  return {
    system,
    user: 'Reflect on your recent experiences.',
  };
}

export function buildSynthesisPrompt(params: SynthesisPromptParams): { system: string; user: string } {
  const { name, personality, traits, questions, evidence } = params;

  const personalityDesc = buildPersonalityDescription(personality, traits);

  const questionsList = questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join('\n');

  const evidenceList = evidence
    .map((e, i) => `${i + 1}. ${e.description}`)
    .join('\n');

  const system = `You are ${name}. ${personalityDesc}

Based on your memories, reflect on these questions:
${questionsList}

Relevant memories:
${evidenceList}

What insights do you draw about your life? For each insight, cite which memories support it.
Format each insight on its own line, ending with (because of 1, 5, 12)
Give 2-5 insights. Be specific and personal, not generic.`;

  return {
    system,
    user: 'Share your reflections.',
  };
}
