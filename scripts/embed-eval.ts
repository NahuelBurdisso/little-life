/**
 * Compare two embedding models on this game's own retrieval task.
 *
 *   npx tsx scripts/embed-eval.ts --db data/verify.db --trace data/trace/v5.jsonl \
 *     --a mxbai-embed-large --b qwen3-embedding:0.6b [--b-query-prefix qwen]
 *
 * Queries are real reflection questions from an LLM trace, asked against the
 * asking agent's own memories in the DB. Each model returns its top 5 by
 * cosine; the chat model judges, blind and in random order, which list better
 * answers the question. No ground truth needed, and it measures what matters:
 * what an agent will remember when it thinks about something.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { CONFIG } from '../server/lib/constants';
import { asRetrievalQuery } from '../server/lib/memory/constants';

function arg(n: string, d?: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }
const DB = arg('db', 'data/verify.db')!;
const TRACE = arg('trace')!;
const A = arg('a', 'mxbai-embed-large')!;
const B = arg('b', 'qwen3-embedding:0.6b')!;
const N = Number(arg('n', '40'));
const BASE = CONFIG.AI.EMBED_BASE_URL;
// The game's own query wording (Qwen3-Embedding wants an instruction on the query side).
const prefixFor = (model: string) => (q: string) => asRetrievalQuery(q, model);

async function embed(model: string, input: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < input.length; i += 64) {
    const r = await fetch(`${BASE}/api/embed`, { method: 'POST', body: JSON.stringify({ model, input: input.slice(i, i + 64), keep_alive: '10m' }) });
    const j = await r.json() as { embeddings?: number[][]; error?: string };
    if (!j.embeddings) throw new Error(`${model}: ${j.error ?? r.status}`);
    out.push(...j.embeddings);
  }
  return out;
}
const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };

async function judge(q: string, listA: string[], listB: string[]): Promise<'A' | 'B' | 'tie'> {
  const flip = Math.random() < 0.5;
  const [first, second] = flip ? [listB, listA] : [listA, listB];
  const r = await fetch(`${CONFIG.AI.CHAT_BASE_URL}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: CONFIG.AI.CHAT_MODEL, stream: false, think: false, keep_alive: '30m',
      options: { temperature: 0, num_ctx: CONFIG.AI.NUM_CTX, num_predict: 10 },
      format: { type: 'object', properties: { better: { type: 'string', enum: ['1', '2', 'tie'] } }, required: ['better'] },
      messages: [{ role: 'user', content: `A person asks themselves: "${q}"\n\nWhich set of their memories is more useful for answering it?\n\nSet 1:\n${first.map((m) => `- ${m}`).join('\n')}\n\nSet 2:\n${second.map((m) => `- ${m}`).join('\n')}\n\nReply with JSON {"better":"1"|"2"|"tie"}.` }],
    }),
  });
  const better = (JSON.parse(((await r.json()) as { message: { content: string } }).message.content) as { better: string }).better;
  if (better === 'tie') return 'tie';
  const firstWins = better === '1';
  return firstWins !== flip ? 'A' : 'B';
}

async function main() {
  const db = new Database(DB, { readonly: true });
  const agents = new Map((db.prepare('select id, name from agents').all() as Array<{ id: number; name: string }>).map((a) => [a.name, a.id]));
  const trace = fs.readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cases: Array<{ agentId: number; q: string }> = [];
  for (const e of trace.filter((t: { purpose: string; ok: boolean }) => t.purpose === 'reflection.questions' && t.ok)) {
    const name = (e.system as string).match(/^You are ([^,]+),/)?.[1];
    const id = name ? agents.get(name) : undefined;
    if (!id) continue;
    try { for (const q of JSON.parse(e.text).questions as string[]) cases.push({ agentId: id, q }); } catch { /* skip */ }
  }
  cases.sort(() => Math.random() - 0.5);
  const picked = cases.slice(0, N);
  console.log(`${picked.length} questions`);

  // All embedding work per model first, then all judging: Ollama keeps two
  // models loaded, and interleaving three (two embedders + the judge) reloads
  // one on nearly every call.
  const agentIds = [...new Set(picked.map((c) => c.agentId))];
  const texts = new Map(agentIds.map((id) => [id, [...new Set((db.prepare('select description from memories where agent_id = ? order by id desc limit 300').all(id) as Array<{ description: string }>).map((r) => r.description))]]));
  const vecs: Record<'a' | 'b', { mem: Map<number, number[][]>; q: number[][] }> = { a: { mem: new Map(), q: [] }, b: { mem: new Map(), q: [] } };
  for (const [key, model] of [['a', A], ['b', B]] as const) {
    for (const id of agentIds) vecs[key].mem.set(id, await embed(model, texts.get(id)!));
    vecs[key].q = await embed(model, picked.map((c) => prefixFor(model)(c.q)));
  }

  const tally = { A: 0, B: 0, tie: 0 };
  for (const [ci, c] of picked.entries()) {
    const t = texts.get(c.agentId)!;
    const top = (qv: number[], vs: number[][]) => vs.map((v, i) => [cos(qv, v), i] as const).sort((x, y) => y[0] - x[0]).slice(0, 5).map(([, i]) => t[i]);
    const la = top(vecs.a.q[ci], vecs.a.mem.get(c.agentId)!), lb = top(vecs.b.q[ci], vecs.b.mem.get(c.agentId)!);
    const verdict = JSON.stringify(la) === JSON.stringify(lb) ? 'tie' : await judge(c.q, la, lb);
    tally[verdict]++;
    process.stdout.write(verdict === 'A' ? 'a' : verdict === 'B' ? 'b' : '.');
  }
  console.log(`\n${A}: ${tally.A}  ${B}: ${tally.B}  tie: ${tally.tie}`);
}
main();
