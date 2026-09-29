// Marks one resident dead in data/verify.db (never the live DB) so the memorial card can be screenshotted.
import Database from 'better-sqlite3';

const db = new Database('./data/verify.db');
const name = process.argv[2] ?? 'Elena Voss';
const a = db.prepare('SELECT id FROM agents WHERE name = ?').get(name);
if (!a) throw new Error('no agent ' + name);
db.prepare(`UPDATE agents SET is_active = 0, current_action = '{"type":"dead"}' WHERE id = ?`).run(a.id);
const tick = db.prepare('SELECT time FROM world_state LIMIT 1').get();
const total = JSON.parse(tick.time).totalTicks;
db.prepare(`INSERT INTO activity_log (type, category, importance, initiator_id, target_id, agent_ids, template_key, template_data, timestamp, real_timestamp)
  VALUES ('drama', 'drama', 9, ?, NULL, ?, 'drama', ?, ?, ?)`).run(
  a.id, JSON.stringify([a.id]),
  JSON.stringify({ description: `${name} has died. Caught in a fall at the granary. The town mourns.` }),
  Math.max(0, total - 40), Date.now(),
);
console.log('killed', name, a.id);
