/**
 * Replay real LLM traffic against candidate models and score it.
 *
 *   # 1. capture: run a server with LLM_TRACE set (never on the live DB)
 *   LLM_TRACE=data/trace/base.jsonl DATABASE_PATH=./data/verify.db SERVER_PORT=3011 npx tsx server/index.ts
 *   # 2. replay
 *   npx tsx scripts/llm-bench.ts --trace data/trace/base.jsonl \
 *       --models huihui_ai/gemma-4-abliterated:e4b,gemma4:26b --per-purpose 12 --concurrency 4
 *
 * Every captured request (system prompt, history, options, format) is sent
 * unchanged to each model, `--concurrency` at a time — the game runs several
 * conversations plus planning at once, so single-request latency flatters a
 * model. Replies are scored with the game's OWN parsers and sanitiser: a plan
 * the planner can't parse, or a line the dialogue validator would reject, is a
 * failure here exactly as it is in play.
 *
 * Writes `<out>/report.md` (table) and `<out>/samples.md` (the same prompts'
 * replies side by side, for reading dialogue quality by eye).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { callOllamaChat } from '../server/ai/ollama';
import { sanitizeDialogue } from '../server/ai/sanitizeDialogue';
import { analyzeSentiment } from '../server/ai/sentiment';
import { parsePlanBlocks, parseDecomposedActions, isUnparsedDecomposition } from '../server/lib/planning/planParser';
import { parseGoalReview, parsePivotResult, parseAmbitionGeneration } from '../server/lib/goals/goalParser';
import { parseQuestions, parseInsights } from '../server/lib/memory/reflectionParser';
import type { LLMTraceEntry, LLMPurpose } from '../server/ai/llmMetrics';

// ─── Args ─────────────────────────────────────────────────────────────────────

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const TRACES = (arg('trace') ?? '').split(',').filter(Boolean);
const MODELS = (arg('models') ?? '').split(',').filter(Boolean);
const PER_PURPOSE = Number(arg('per-purpose', '10'));
const CONCURRENCY = Number(arg('concurrency', '4'));
const ONLY = arg('only')?.split(',');
const DB_PATH = arg('db', 'data/verify.db')!;
const OUT = arg('out', `data/bench/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`)!;
const SEED = Number(arg('seed', '1'));
// Score the replies already in the trace instead of calling any model: the
// capture model's baseline, for free.
const OFFLINE = process.argv.includes('--offline');
if (OFFLINE && MODELS.length === 0) MODELS.push('trace');
if (TRACES.length === 0 || MODELS.length === 0) {
  console.error('usage: llm-bench --trace a.jsonl[,b.jsonl] --models m1,m2 [--per-purpose 10] [--concurrency 4] [--only conversation,plan.daily]');
  process.exit(1);
}

// ─── Corpus ───────────────────────────────────────────────────────────────────

const all: LLMTraceEntry[] = TRACES.flatMap((f) =>
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LLMTraceEntry),
);
// The retry is a reaction to a rejected reply of the capture model: replaying
// it on another model scores that model on someone else's mistake.
const usable = all.filter((e) => e.purpose !== 'conversation.retry' && (!ONLY || ONLY.includes(e.purpose)));

let rng = SEED;
const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const byPurpose = new Map<LLMPurpose, LLMTraceEntry[]>();
for (const e of usable) byPurpose.set(e.purpose, [...(byPurpose.get(e.purpose) ?? []), e]);
const corpus: LLMTraceEntry[] = [];
for (const [, list] of byPurpose) {
  const shuffled = [...list].sort(() => rand() - 0.5);
  corpus.push(...shuffled.slice(0, PER_PURPOSE));
}
console.log(`corpus: ${corpus.length} requests from ${all.length} traced (${[...byPurpose.keys()].join(', ')})`);

// ─── World names for the parsers ──────────────────────────────────────────────

const world = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const agentNames = (world.prepare('select name from agents').all() as Array<{ name: string }>).map((r) => r.name);
const locationNames = (world.prepare('select name from locations').all() as Array<{ name: string }>).map((r) => r.name);
world.close();

// ─── Scoring ──────────────────────────────────────────────────────────────────

interface Score {
  ok: boolean;
  /** Short reason when not ok, or a quality flag worth counting. */
  flags: string[];
  shown: string;
}

const CLICHES = [
  /how are you( doing)?( today)?/i, /^well,/i, /^hey there/i, /^oh,/i, /i should (be going|get going)/i,
  /nice to (meet|see) you/i, /what brings you/i, /it'?s been a while/i, /^ah,/i,
];
const ASSISTANT_ISMS = /\b(as an ai|language model|i can(no|')t (help|assist)|i'm sorry, but|here'?s (a|the|my)|certainly!|user)\b/i;

function speakerFromSystem(system: string): string {
  return system.match(/^You are ([^,]+),/)?.[1] ?? 'Someone';
}
function listenerFromMessages(e: LLMTraceEntry, speaker: string): string {
  const first = e.messages[0]?.content ?? '';
  return agentNames.find((n) => n !== speaker && first.includes(n)) ?? 'Someone';
}

function score(e: LLMTraceEntry, raw: string, truncated: boolean): Score {
  const flags: string[] = [];
  if (truncated) flags.push('truncated');
  switch (e.purpose) {
    case 'conversation': {
      const speaker = speakerFromSystem(e.system);
      const clean = sanitizeDialogue(raw, { speakerName: speaker, listenerName: listenerFromMessages(e, speaker), townNames: agentNames, truncated });
      const lastOther = [...e.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const invalid = clean.trim().length < 2 || (clean.length < 10 && Math.abs(analyzeSentiment(clean)) < 0.2) || lastOther.endsWith(clean);
      if (clean.length < raw.trim().length * 0.8) flags.push('stage-directions');
      if (CLICHES.some((c) => c.test(clean))) flags.push('cliche');
      if (ASSISTANT_ISMS.test(raw)) flags.push('assistant-ism');
      if (clean.split(/\s+/).length > 45) flags.push('long');
      return { ok: !invalid, flags: invalid ? [...flags, 'rejected'] : flags, shown: clean };
    }
    case 'plan.daily':
    case 'plan.revise': {
      const blocks = parsePlanBlocks(raw, locationNames, e.purpose === 'plan.daily' ? 3 : 1);
      return { ok: blocks.length > 0, flags: blocks.length ? flags : [...flags, 'unparsed'], shown: blocks.map((b) => `${b.start_hour}-${b.end_hour} ${b.broad_action} @${b.location_hint}`).join(' / ') || raw };
    }
    case 'plan.decompose': {
      const actions = parseDecomposedActions(raw, locationNames, agentNames);
      const bad = isUnparsedDecomposition(actions);
      return { ok: !bad, flags: bad ? [...flags, 'unparsed'] : flags, shown: actions.map((a) => `${a.description} (${a.duration_minutes}m)`).join(' / ') };
    }
    case 'goal.review': {
      const r = parseGoalReview(raw);
      return { ok: !!r, flags: r ? flags : [...flags, 'unparsed'], shown: r ? JSON.stringify(r) : raw };
    }
    case 'goal.pivot': {
      const r = parsePivotResult(raw);
      return { ok: !!r, flags: r ? flags : [...flags, 'unparsed'], shown: r ? JSON.stringify(r) : raw };
    }
    case 'goal.ambition': {
      const r = parseAmbitionGeneration(raw);
      return { ok: !!r, flags: r ? flags : [...flags, 'unparsed'], shown: r ? JSON.stringify(r) : raw };
    }
    case 'reflection.questions': {
      const q = parseQuestions(raw);
      const ok = q.length === 3 && q.every((x) => x.endsWith('?'));
      return { ok, flags: ok ? flags : [...flags, 'malformed'], shown: q.join(' | ') };
    }
    case 'reflection.insights': {
      const ins = parseInsights(raw);
      const cited = ins.filter((i) => i.citations.length > 0).length;
      const markdown = /\*\*|^#+ /m.test(raw);
      if (markdown) flags.push('markdown');
      if (/\byou\b/i.test(ins.map((i) => i.text).join(' '))) flags.push('second-person');
      const ok = ins.length >= 1 && cited === ins.length;
      return { ok, flags: ok ? flags : [...flags, 'uncited'], shown: ins.map((i) => i.text).join(' | ') };
    }
    case 'snap': {
      const actions = ['confront', 'flee', 'breakdown', 'lash_out', 'self_destruct', 'seek_comfort'];
      const hit = actions.find((a) => raw.toLowerCase().includes(a));
      return { ok: !!hit, flags: hit ? flags : [...flags, 'unparsed'], shown: raw };
    }
    case 'self_description': {
      const preamble = /^(here|sure|okay|based on|as )/i.test(raw.trim());
      if (/\*\*/.test(raw)) flags.push('markdown');
      return { ok: !preamble && raw.length > 10, flags: preamble ? [...flags, 'preamble'] : flags, shown: raw };
    }
    default:
      return { ok: raw.length > 0, flags, shown: raw };
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

interface Result {
  model: string;
  entry: LLMTraceEntry;
  ms: number;
  error?: string;
  raw?: string;
  score?: Score;
}

async function runOne(model: string, e: LLMTraceEntry): Promise<Result> {
  if (OFFLINE) {
    return e.ok && e.text
      ? { model, entry: e, ms: e.totalMs, raw: e.text, score: score(e, e.text, !!e.truncated) }
      : { model, entry: e, ms: e.totalMs, error: e.error ?? 'failed' };
  }
  const t0 = performance.now();
  try {
    const r = await callOllamaChat({
      model,
      system: e.system,
      messages: e.messages as Array<{ role: 'user' | 'assistant'; content: string }>,
      options: e.options as never,
      format: e.format as never,
      purpose: e.purpose,
    });
    return { model, entry: e, ms: performance.now() - t0, raw: r.text, score: score(e, r.text, !!r.truncated) };
  } catch (err) {
    return { model, entry: e, ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results: Result[] = [];
  const wall = new Map<string, number>();
  for (const model of MODELS) {
    process.stdout.write(`\n${model}: loading… `);
    const warm = await runOne(model, corpus[0]);
    if (warm.error) { console.log(`FAILED: ${warm.error}`); continue; }
    process.stdout.write(`running ${corpus.length} × c${CONCURRENCY}… `);
    const t0 = performance.now();
    const rs = await pool(corpus, CONCURRENCY, (e) => runOne(model, e));
    wall.set(model, performance.now() - t0);
    results.push(...rs);
    const ok = rs.filter((r) => r.score?.ok).length;
    console.log(`${(wall.get(model)! / 1000).toFixed(0)} s, ${ok}/${rs.length} ok`);
  }

  // Report
  const purposes = [...new Set(corpus.map((e) => e.purpose))];
  const lines: string[] = [`# LLM bench ${new Date().toISOString()}`, '',
    `Corpus: ${corpus.length} requests (${TRACES.join(', ')}), concurrency ${CONCURRENCY}.`, '',
    '| model | wall s | req/min | ok % | p50 ms | p95 ms | flags |', '|---|---|---|---|---|---|---|'];
  for (const model of MODELS) {
    const rs = results.filter((r) => r.model === model);
    if (!rs.length) continue;
    const flags = new Map<string, number>();
    for (const r of rs) for (const f of r.error ? ['error'] : r.score!.flags) flags.set(f, (flags.get(f) ?? 0) + 1);
    const w = wall.get(model)! / 1000;
    lines.push(`| ${model} | ${w.toFixed(0)} | ${(rs.length / w * 60).toFixed(1)} | ${Math.round(100 * rs.filter((r) => r.score?.ok).length / rs.length)} | ${pct(rs.map((r) => r.ms), 0.5).toFixed(0)} | ${pct(rs.map((r) => r.ms), 0.95).toFixed(0)} | ${[...flags].map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  }
  lines.push('', '## Per purpose (ok % · p50 ms)', '', `| purpose | ${MODELS.join(' | ')} |`, `|---|${MODELS.map(() => '---').join('|')}|`);
  for (const p of purposes) {
    const cells = MODELS.map((m) => {
      const rs = results.filter((r) => r.model === m && r.entry.purpose === p);
      if (!rs.length) return '—';
      const flags = new Map<string, number>();
      for (const r of rs) for (const f of r.error ? ['error'] : r.score!.flags) flags.set(f, (flags.get(f) ?? 0) + 1);
      return `${Math.round(100 * rs.filter((r) => r.score?.ok).length / rs.length)}% · ${pct(rs.map((r) => r.ms), 0.5).toFixed(0)}${flags.size ? ` (${[...flags].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`;
    });
    lines.push(`| ${p} | ${cells.join(' | ')} |`);
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');

  // Side-by-side samples
  const samples: string[] = ['# Samples', ''];
  corpus.forEach((e, i) => {
    samples.push(`## ${i + 1}. ${e.purpose}`, '');
    if (e.purpose === 'conversation') {
      samples.push('> ' + e.messages.slice(-2).map((m) => m.content.replace(/\n/g, ' ').slice(-300)).join('\n> '), '');
    }
    for (const model of MODELS) {
      const r = results.find((x) => x.model === model && x.entry === e);
      if (!r) continue;
      const body = r.error ? `ERROR ${r.error}` : `${r.score!.shown}${r.score!.flags.length ? `  _[${r.score!.flags.join(', ')}]_` : ''}`;
      samples.push(`- **${model}** (${r.ms.toFixed(0)} ms): ${body.replace(/\n/g, ' ').slice(0, 600)}`);
    }
    samples.push('');
  });
  fs.writeFileSync(path.join(OUT, 'samples.md'), samples.join('\n'));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results.map((r) => ({ ...r, entry: { purpose: r.entry.purpose, ts: r.entry.ts } })), null, 1));
  console.log(`\n${lines.join('\n')}\n\nwritten to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
