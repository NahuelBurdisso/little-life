/**
 * One-off: fix sprite_sheet / portrait_sprite columns in agents table.
 * Old setup.ts stored values like "sprites/elena_voss.png"; AgentSprite loader
 * prepends /sprites/agents/ and appends .png → double-wrap 404s.
 * This script rewrites rows to bare seed keys (e.g. "elena_voss").
 */
import { db } from '../server/db';
import { agents } from '../server/db/schema';
import { AGENT_SEEDS } from '../server/data/agents';
import { eq } from 'drizzle-orm';

function fallbackSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/^dr\.?\s+/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const rows = db.select({ id: agents.id, name: agents.name, sprite_sheet: agents.sprite_sheet, portrait_sprite: agents.portrait_sprite }).from(agents).all();

let fixed = 0;
for (const row of rows) {
  const seed = AGENT_SEEDS.find(s => s.name === row.name);
  const slug = fallbackSlug(row.name);
  const newSprite = seed?.spriteSheet ?? slug;
  const newPortrait = seed?.portraitSprite ?? `${slug}_portrait`;
  if (row.sprite_sheet === newSprite && row.portrait_sprite === newPortrait) continue;
  db.update(agents)
    .set({ sprite_sheet: newSprite, portrait_sprite: newPortrait })
    .where(eq(agents.id, row.id))
    .run();
  console.log(`fixed ${row.name}: ${row.sprite_sheet} → ${newSprite}, ${row.portrait_sprite} → ${newPortrait}`);
  fixed++;
}
console.log(`Done. ${fixed}/${rows.length} rows updated.`);
