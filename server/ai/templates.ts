/**
 * Template-chat bookkeeping and interpolation.
 *
 * Template conversations are played from topic scripts
 * (server/data/smallTalkScripts.ts, composed by server/lib/templateChat.ts).
 * This module owns their per-pair cooldowns in `template_usage`: one row per
 * chat, `template_category` = `script:<id>`, stamped in GAME minutes. The old
 * per-category picker (selectTemplate) chose each line from an unrelated
 * category and is gone, and so is its catalog: nothing writes or reads the
 * legacy `templates` table any more (see the note on it in db/schema.ts).
 */

import { and, eq, like } from "drizzle-orm";
import { db } from "../db";
import { templateUsage } from "../db/schema";
import { scriptUsageCategory } from "../lib/templateChat";

const SCRIPT_PREFIX = scriptUsageCategory('');

function orderedPair(agentA: number, agentB: number): [number, number] {
  return agentA < agentB ? [agentA, agentB] : [agentB, agentA];
}

/**
 * Game minute each topic script was last used by this pair. A row stamped
 * before `used_game_min` existed has no game-time stamp and is ignored
 * (counts as expired), as the old category cooldown did.
 */
export function scriptLastUsed(agentA: number, agentB: number): Map<string, number> {
  const [a, b] = orderedPair(agentA, agentB);
  const rows = db.select({ category: templateUsage.template_category, at: templateUsage.used_game_min })
    .from(templateUsage)
    .where(and(
      eq(templateUsage.agent_a, a),
      eq(templateUsage.agent_b, b),
      like(templateUsage.template_category, `${SCRIPT_PREFIX}%`),
    ))
    .all();
  const last = new Map<string, number>();
  for (const r of rows) {
    if (r.at == null) continue;
    const id = r.category.slice(SCRIPT_PREFIX.length);
    last.set(id, Math.max(last.get(id) ?? -Infinity, r.at));
  }
  return last;
}

/**
 * Only the latest use matters for a cooldown, so the pair's older row for the
 * same script is replaced: the table stays at most pairs × scripts rows
 * instead of one more row per chat forever (nothing else prunes it).
 */
export function recordScriptUsage(agentA: number, agentB: number, scriptId: string, nowGameMin: number): void {
  const [a, b] = orderedPair(agentA, agentB);
  const category = scriptUsageCategory(scriptId);
  db.delete(templateUsage).where(and(
    eq(templateUsage.agent_a, a),
    eq(templateUsage.agent_b, b),
    eq(templateUsage.template_category, category),
  )).run();
  db.insert(templateUsage).values({
    template_category: category,
    agent_a: a,
    agent_b: b,
    used_at: Date.now(),
    used_game_min: nowGameMin,
  }).run();
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
