/**
 * Template Selection and Interpolation
 *
 * Selects conversation templates from the DB based on category and conditions,
 * respects cooldowns per agent pair, and interpolates variables.
 */

import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

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
  ctx: MutationCtx,
  category: string,
  agentA: Id<"agents">,
  agentB: Id<"agents">,
  currentState: CurrentState
): Promise<{ text: string; sentiment: number } | null> {
  // 1. Query templates for this category
  const allTemplates = await ctx.db
    .query("templates")
    .collect();

  const categoryTemplates = allTemplates.filter(
    (t: Doc<"templates">) => t.category === category
  );

  if (categoryTemplates.length === 0) return null;

  // 2. Filter by conditions
  const matching = categoryTemplates.filter((t: Doc<"templates">) =>
    conditionsMatch(t.conditions, currentState)
  );

  if (matching.length === 0) return null;

  // 3. Check cooldown — query templateUsage for this pair + category
  // Ensure consistent ordering: smaller ID first
  const [orderedA, orderedB] =
    agentA < agentB ? [agentA, agentB] : [agentB, agentA];

  const recentUsage = await ctx.db
    .query("templateUsage")
    .withIndex("by_pair_category", (q: any) =>
      q.eq("agentA", orderedA).eq("agentB", orderedB).eq("templateCategory", category)
    )
    .order("desc")
    .first();

  const now = Date.now();

  // Filter out templates whose cooldown hasn't expired
  const available = matching.filter((t: Doc<"templates">) => {
    if (!recentUsage) return true;
    return now - recentUsage.usedAt >= t.cooldownPerPair;
  });

  if (available.length === 0) return null;

  // 4. Pick a random template, then a random variant
  const template = available[Math.floor(Math.random() * available.length)];
  const variants = template.variants;

  if (!variants || variants.length === 0) return null;

  const variant = variants[Math.floor(Math.random() * variants.length)];

  // 5. Record usage
  await ctx.db.insert("templateUsage", {
    templateCategory: category,
    agentA: orderedA,
    agentB: orderedB,
    usedAt: now,
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
