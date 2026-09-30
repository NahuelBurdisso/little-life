/**
 * How many plan blocks in an LLM_TRACE would the deterministic decomposer take
 * off the LLM (L2)? Rebuilds each agent's home / workplace / shift from the
 * trace's own `plan.daily` prompts, replays every block of every daily plan and
 * revision through `classifyBlock`, and lists what still goes to the model.
 *
 *   npx tsx scripts/decompose-share.ts --trace data/trace/x.jsonl [--db data/verify.db] [--list 40]
 *
 * Read-only; no DB, no LLM.
 */
import fs from 'node:fs';
import { classifyBlock, type DeterministicContext } from '../server/lib/planning/deterministicDecompose';
import type { PlanBlock } from '../server/lib/planning/types';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const tracePath = arg('--trace');
if (!tracePath) { console.error('usage: --trace <file.jsonl> [--list N]'); process.exit(1); }
const listN = Number(arg('--list') ?? 30);

interface Row { purpose: string; system: string; text: string; ok: boolean }
const rows: Row[] = fs.readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

interface AgentFacts { home: string; workplace: string | null; workStart?: number; workEnd?: number }
const facts = new Map<string, AgentFacts>();
let places: string[] = [];
for (const r of rows) {
  if (r.purpose !== 'plan.daily') continue;
  const name = /^You are (.+?), \d+\./.exec(r.system)?.[1];
  const home = /\nHome: (.+?)\. /.exec(r.system)?.[1];
  const work = /You work at (.+?) from (\d+):00 to (\d+):00/.exec(r.system);
  const pl = /Places in town: (.+)\n/.exec(r.system)?.[1];
  if (pl) places = pl.split(', ');
  if (name && home) {
    facts.set(name, { home, workplace: work?.[1] ?? null, workStart: work ? +work[2] : undefined, workEnd: work ? +work[3] : undefined });
  }
}
// Location types are not in the trace; `--types name=type,...` or `--db <copy>` supplies them
// (the widened kinds need them). Opened read-only.
const types = new Map<string, string>();
const dbPath = arg('--db');
if (dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const tdb = new Database(dbPath, { readonly: true, fileMustExist: true });
  for (const r of tdb.prepare('select name, type from locations').all() as Array<{ name: string; type: string }>) types.set(r.name, r.type);
  tdb.close();
}
const locations = places.map((name, i) => ({ id: i + 1, name, type: types.get(name) }));
const idOf = (name: string | null) => (name ? locations.find((l) => l.name === name)?.id ?? null : null);
const names = [...facts.keys()];

let total = 0;
const byKind: Record<string, number> = {};
const llm: string[] = [];
for (const r of rows) {
  if (r.purpose !== 'plan.daily' && r.purpose !== 'plan.revise') continue;
  if (!r.ok) continue;
  const name = /^You are (.+?)[,.]/.exec(r.system)?.[1];
  const f = name ? facts.get(name) : undefined;
  if (!name || !f) continue;
  let parsed: { blocks?: Array<{ start: number; end: number; action: string; location: string }> };
  try { parsed = JSON.parse(r.text); } catch { continue; }
  const ctx: DeterministicContext = {
    homeId: idOf(f.home),
    workplaceId: idOf(f.workplace),
    locations,
    otherAgentNames: names.filter((n) => n !== name),
    workStart: f.workStart,
    workEnd: f.workEnd,
  };
  for (const b of parsed.blocks ?? []) {
    const block: PlanBlock = {
      id: 'x', start_hour: b.start, end_hour: b.end, broad_action: b.action,
      location_hint: b.location, status: 'pending', decomposed_actions: null,
    } as PlanBlock;
    total++;
    const kind = classifyBlock(block, ctx);
    byKind[kind ?? 'llm'] = (byKind[kind ?? 'llm'] ?? 0) + 1;
    if (kind && kind === arg('--show')) console.log(`  [${kind}] ${b.start}-${b.end} ${b.action} @ ${b.location}`);
    if (!kind) llm.push(`${b.start}-${b.end} ${b.action} @ ${b.location}${b.location === f.home ? ' (home)' : b.location === f.workplace ? ' (work)' : ''}`);
  }
}
const det = total - (byKind.llm ?? 0);
console.log(`agents ${facts.size}, places ${locations.length}, blocks ${total}`);
console.log(`deterministic ${det}/${total} = ${((100 * det) / Math.max(1, total)).toFixed(1)}%`, byKind);
console.log(`\nstill LLM (first ${listN}):`);
for (const l of llm.slice(0, listN)) console.log('  ' + l);
