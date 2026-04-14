import type { PersonalityProfile } from '../personality';

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

export function buildGoalReviewPrompt(params: GoalReviewPromptParams): { system: string; user: string } {
  const { name, personality, traits, ambition, activeGoals, recentMemories, relationshipHighlights, money, job, dayNumber } = params;
  const pSummary = personalitySummary(personality);
  const traitsList = traits.join(', ');
  const ambitionText = ambition ? `Your life ambition: "${ambition.description}" (category: ${ambition.type})` : 'You do not have a life ambition yet.';
  const goalsText = activeGoals.length > 0
    ? activeGoals.map(g => `- [ID:${g.id}] "${g.description}" (strategy: ${g.strategy}, progress: ${Math.round(g.progress * 100)}%, ${g.daysActive} days active)`).join('\n')
    : 'No active goals.';
  const memoriesText = recentMemories.length > 0 ? recentMemories.map((m, i) => `${i + 1}. ${m}`).join('\n') : 'Nothing notable recently.';
  const relationshipsText = relationshipHighlights.length > 0 ? relationshipHighlights.join('\n') : 'No notable relationships.';

  const system = `You are ${name}, a person living in a small town. Day ${dayNumber}.
Personality: ${pSummary}. Traits: ${traitsList}.
Money: ${money}. Job: ${job ?? 'unemployed'}.

${ambitionText}

Your active goals:
${goalsText}

Recent memories:
${memoriesText}

Key relationships:
${relationshipsText}

It's morning. Review your life ambition and goals. Decide what matters today.

Respond ONLY with valid JSON (no markdown, no explanation) in this exact format:
{
  "ambition": "keep" OR {"shift": "new ambition text", "category": "wealth|love|power|freedom|justice|knowledge|legacy|pleasure", "reason": "why"},
  "reviews": [{"goal_id": N, "action": "continue|adjust|abandon", "reason": "why", "new_strategy": "optional new approach"}],
  "new_goals": [{"description": "what you want", "target_agent": "Name or null", "category_hint": "romantic|hostile|social|economic|investigative|protective|custom", "strategy": "how you plan to do it", "priority": 0.0-1.0}]
}`;

  const user = 'Review your ambition and goals. Generate new goals if you have open slots (max 3 LLM goals). Think about what matters to you given your personality and recent experiences.';
  return { system, user };
}

export function buildPivotPrompt(params: PivotPromptParams): { system: string; user: string } {
  const { name, personality, goalDescription, strategy, progress, daysActive, recentMemories } = params;
  const pSummary = personalitySummary(personality);
  const memoriesText = recentMemories.length > 0 ? recentMemories.map((m, i) => `${i + 1}. ${m}`).join('\n') : 'Nothing notable recently.';

  const system = `You are ${name}. Personality: ${pSummary}.

You have been pursuing this goal for ${daysActive} days with ${Math.round(progress * 100)}% progress:
Goal: "${goalDescription}"
Strategy: "${strategy}"

Your approach isn't working. Think about why and come up with a different strategy.

Recent memories:
${memoriesText}

Respond ONLY with valid JSON:
{"new_strategy": "your new approach", "new_category_hint": "romantic|hostile|social|economic|investigative|protective|custom"}`;

  const user = 'What new approach will you try?';
  return { system, user };
}

export function buildAmbitionGenerationPrompt(params: AmbitionGenerationParams): { system: string; user: string } {
  const { name, personality, traits, recentMemories, money, job, relationshipHighlights } = params;
  const pSummary = personalitySummary(personality);
  const traitsList = traits.join(', ');
  const memoriesText = recentMemories.length > 0 ? recentMemories.map((m, i) => `${i + 1}. ${m}`).join('\n') : 'Starting a new life.';
  const relationshipsText = relationshipHighlights.length > 0 ? relationshipHighlights.join('\n') : 'No close relationships yet.';

  const system = `You are ${name}, starting life in a small town.
Personality: ${pSummary}. Traits: ${traitsList}.
Money: ${money}. Job: ${job ?? 'unemployed'}.

Your memories:
${memoriesText}

Relationships:
${relationshipsText}

What is your deepest life ambition? What do you truly want most?

Respond ONLY with valid JSON:
{"description": "your life ambition in one sentence", "category": "wealth|love|power|freedom|justice|knowledge|legacy|pleasure", "reason": "why this matters to you"}`;

  const user = 'What is your life ambition?';
  return { system, user };
}
