import type { NewGoalOutput, MappedGoal } from './types';

interface CategoryMapping {
  type: string;
  interactions: string[];
}

const CATEGORY_MAP: Record<string, CategoryMapping> = {
  romantic: { type: 'seduce', interactions: ['flirt', 'date', 'hookup', 'compliment'] },
  hostile: { type: 'revenge', interactions: ['fight', 'spread_rumor', 'vandalism', 'blackmail', 'pickpocket'] },
  social: { type: 'befriend', interactions: ['comfort', 'buy_drinks', 'lend_money', 'befriend'] },
  economic: { type: 'custom', interactions: ['work'] },
  investigative: { type: 'investigate', interactions: ['eavesdrop', 'interrogate'] },
  protective: { type: 'protect', interactions: ['comfort', 'nurse', 'lend_money'] },
  criminal: { type: 'steal_from', interactions: ['pickpocket', 'burglary', 'fraud', 'blackmail'] },
};

const CUSTOM_FALLBACK: CategoryMapping = {
  type: 'custom',
  interactions: ['comfort', 'buy_drinks', 'lend_money', 'befriend', 'work', 'eavesdrop'],
};

export class GoalMapper {
  mapCategory(categoryHint: string): CategoryMapping {
    const lower = categoryHint.toLowerCase().trim();
    return CATEGORY_MAP[lower] ?? CUSTOM_FALLBACK;
  }

  resolveAgentName(name: string | null, allAgents: { id: number; name: string }[]): number | null {
    if (!name) return null;
    const lower = name.toLowerCase().trim();

    // Exact match (case-insensitive)
    const exact = allAgents.find(a => a.name.toLowerCase() === lower);
    if (exact) return exact.id;

    // Substring match (case-insensitive)
    const partial = allAgents.find(a => a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase()));
    if (partial) return partial.id;

    return null;
  }

  map(goal: NewGoalOutput, allAgents: { id: number; name: string }[]): MappedGoal {
    const { type, interactions } = this.mapCategory(goal.category_hint);
    const target_id = this.resolveAgentName(goal.target_agent, allAgents);
    return { type, mapped_interactions: interactions, target_id };
  }
}
