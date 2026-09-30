import type {
  GoalReviewResult,
  GoalReviewAction,
  NewGoalOutput,
  AmbitionShift,
  PivotResult,
  AmbitionGenerationResult,
} from './types';

function extractJSON(raw: string): string {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  // A sentence before or after the object ("Here is my review: {...}") used
  // to fail the whole parse. Structured output makes this rare; backends that
  // ignore `format` still do it.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start > 0 || (end >= 0 && end < cleaned.length - 1)) {
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function safeParse(raw: string): unknown | null {
  try {
    return JSON.parse(extractJSON(raw));
  } catch {
    return null;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const VALID_ACTIONS = new Set(['continue', 'adjust', 'done', 'abandon']);

export function parseGoalReview(raw: string): GoalReviewResult | null {
  const data = safeParse(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;

  let ambition: 'keep' | AmbitionShift;
  if (data.ambition === 'keep') {
    ambition = 'keep';
  } else if (data.ambition && typeof data.ambition === 'object') {
    const a = data.ambition as Record<string, unknown>;
    if (typeof a.shift !== 'string' || typeof a.category !== 'string' || typeof a.reason !== 'string') return null;
    ambition = { shift: a.shift, category: a.category, reason: a.reason };
  } else {
    return null;
  }

  const rawReviews = Array.isArray(data.reviews) ? data.reviews : [];
  const reviews: GoalReviewAction[] = rawReviews
    .filter((r: unknown) => {
      if (!r || typeof r !== 'object') return false;
      const obj = r as Record<string, unknown>;
      // "ID:12" / "12": the prompt used to label goals "[ID:12]" and models
      // echoed the label, which dropped the review silently.
      if (typeof obj.goal_id === 'string') {
        const n = Number(obj.goal_id.replace(/^\s*(?:id|goal)\s*:?\s*/i, ''));
        if (Number.isInteger(n)) obj.goal_id = n;
      }
      return typeof obj.goal_id === 'number' && VALID_ACTIONS.has(obj.action as string) && typeof obj.reason === 'string';
    })
    .map((r: unknown) => {
      const obj = r as Record<string, unknown>;
      return {
        goal_id: obj.goal_id as number,
        action: obj.action as GoalReviewAction['action'],
        reason: obj.reason as string,
        new_strategy: typeof obj.new_strategy === 'string' ? obj.new_strategy : undefined,
      };
    });

  const rawGoals = Array.isArray(data.new_goals) ? data.new_goals : [];
  const new_goals: NewGoalOutput[] = rawGoals
    .filter((g: unknown) => {
      if (!g || typeof g !== 'object') return false;
      const obj = g as Record<string, unknown>;
      return typeof obj.description === 'string' && typeof obj.strategy === 'string';
    })
    .map((g: unknown) => {
      const obj = g as Record<string, unknown>;
      return {
        description: obj.description as string,
        target_agent: typeof obj.target_agent === 'string' ? obj.target_agent : null,
        category_hint: typeof obj.category_hint === 'string' ? obj.category_hint : 'custom',
        strategy: obj.strategy as string,
        priority: typeof obj.priority === 'number' ? clamp(obj.priority, 0, 1) : 0.5,
      };
    });

  return { ambition, reviews, new_goals };
}

export function parsePivotResult(raw: string): PivotResult | null {
  const data = safeParse(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.new_strategy !== 'string' || !data.new_strategy.trim()) return null;
  return {
    new_strategy: data.new_strategy,
    new_category_hint: typeof data.new_category_hint === 'string' ? data.new_category_hint : undefined,
  };
}

export function parseAmbitionGeneration(raw: string): AmbitionGenerationResult | null {
  const data = safeParse(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.description !== 'string' || typeof data.category !== 'string' || typeof data.reason !== 'string') return null;
  return { description: data.description, category: data.category, reason: data.reason };
}
