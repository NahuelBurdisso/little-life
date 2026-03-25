/**
 * Template Selection and Interpolation
 *
 * Selects conversation templates from the DB based on category and conditions,
 * respects cooldowns per agent pair, and interpolates variables.
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { templates, templateUsage } from "../db/schema";

interface CurrentState {
  friendship: number;
  mood: number;
  timeOfDay: string;
  locationType: string | null;
  weather: string;
}

function conditionsMatch(
  conditions: any,
  state: CurrentState
): boolean {
  if (!conditions || Object.keys(conditions).length === 0) return true;

  if (conditions.minFriendship != null && state.friendship < conditions.minFriendship) {
    return false;
  }
  if (conditions.maxFriendship != null && state.friendship > conditions.maxFriendship) {
    return false;
  }
  if (conditions.minMood != null && state.mood < conditions.minMood) {
    return false;
  }
  if (conditions.maxMood != null && state.mood > conditions.maxMood) {
    return false;
  }
  if (conditions.timeOfDay && conditions.timeOfDay !== state.timeOfDay) {
    return false;
  }
  if (conditions.locationType && state.locationType && conditions.locationType !== state.locationType) {
    return false;
  }
  if (conditions.weather && conditions.weather !== state.weather) {
    return false;
  }

  return true;
}

export async function selectTemplate(
  category: string,
  agentA: number,
  agentB: number,
  currentState: CurrentState
): Promise<{ text: string; sentiment: number } | null> {
  // 1. Query templates for this category
  const categoryTemplates = await db
    .select()
    .from(templates)
    .where(eq(templates.category, category));

  if (categoryTemplates.length === 0) return null;

  // 2. Filter by conditions
  const matching = categoryTemplates.filter((t) =>
    conditionsMatch(t.conditions, currentState)
  );

  if (matching.length === 0) return null;

  // 3. Check cooldown — ensure consistent pair ordering (smaller ID first)
  const [orderedA, orderedB] =
    agentA < agentB ? [agentA, agentB] : [agentB, agentA];

  const recentUsage = await db
    .select()
    .from(templateUsage)
    .where(
      and(
        eq(templateUsage.agent_a, orderedA),
        eq(templateUsage.agent_b, orderedB),
        eq(templateUsage.template_category, category)
      )
    )
    .orderBy(desc(templateUsage.used_at))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const now = Date.now();

  // Filter out templates whose cooldown hasn't expired
  const available = matching.filter((t) => {
    if (!recentUsage) return true;
    return now - recentUsage.used_at >= t.cooldown_per_pair;
  });

  if (available.length === 0) return null;

  // 4. Pick a random template, then a random variant
  const template = available[Math.floor(Math.random() * available.length)];
  const variants = template.variants;

  if (!variants || variants.length === 0) return null;

  const variant = variants[Math.floor(Math.random() * variants.length)];

  // 5. Record usage
  await db.insert(templateUsage).values({
    template_category: category,
    agent_a: orderedA,
    agent_b: orderedB,
    used_at: now,
  });

  return { text: variant.text, sentiment: variant.sentiment };
}

export function interpolateTemplate(
  text: string,
  vars: Record<string, string>
): string {
  return text.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const trimmedKey = key.trim();
    if (trimmedKey in vars) {
      return vars[trimmedKey];
    }
    // Leave unmatched placeholders as-is
    return match;
  });
}
