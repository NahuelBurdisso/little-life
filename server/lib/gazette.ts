/**
 * The Town Crier — a daily paper the LLM writes from what actually happened.
 *
 * Little Life is a spectator game, and what the town does mostly scrolls past
 * as a flat activity feed. Once a game day (at the day change, or when the
 * player asks) the day's most important feed lines and the chronicle's live
 * story arcs are handed to the model as the only facts it may report, and it
 * writes a short period newspaper: a headline, a few articles and a gossip
 * column. One structured call per game day, at low priority.
 *
 * The prompt forbids inventing events; the schema caps every field. A quiet
 * day (fewer than MIN_ITEMS newsworthy lines) prints nothing.
 */
import { desc, gt, eq } from 'drizzle-orm';
import { db } from '../db';
import { activityLog, gazetteIssues, worldState, type GazetteArticle } from '../db/schema';
import { callOllamaChat } from '../ai/ollama';
import { CONFIG } from './constants';
import { TOWN_SETTING } from '../ai/setting';
import { renderMessage } from './activityMessage';
import { storyKey } from './factText';
import { detectStoryArcs } from './chronicle';
import { emitter } from '../engine/emitter';
import { ACTIVITY_REGISTRY } from '../data/activityRegistry';

export const GAZETTE_NAME = 'The Town Crier';

/** Feed categories that are never news. */
const SKIP_CATEGORIES = new Set(['system', 'error', 'planning']);
/** Feed rows below this importance are routine (meals, salaries, small talk). */
const MIN_IMPORTANCE = 0.45;
const MAX_ITEMS = 24;
const MIN_ITEMS = 3;


export interface GazetteMaterial {
  /** What residents did, oldest first. */
  items: string[];
  /** Town-wide happenings (festivals, storms, markets). */
  events: string[];
  arcs: Array<{ title: string; summary: string }>;
}

/** Newsworthy lines logged after `sinceTick`, oldest first, deduplicated. */
export function gatherMaterial(sinceTick: number): GazetteMaterial {
  const rows = db
    .select()
    .from(activityLog)
    .where(gt(activityLog.timestamp, sinceTick))
    .orderBy(desc(activityLog.importance))
    .limit(200)
    .all()
    .filter((r) =>
      !SKIP_CATEGORIES.has(r.category) &&
      r.importance >= MIN_IMPORTANCE &&
      // Player-facing reports ("Your confrontation: …") are loud on purpose
      // and would name the hand behind the story; see activityRegistry.ts.
      ACTIVITY_REGISTRY[r.type]?.newsworthy !== false,
    );

  // One line per story. A rumor spreading logs a row per retelling ("Ray told
  // Lucia that…", "Diego overheard that…", "The whole town now knows that…"),
  // which buried everything else; lines are keyed on what comes after "that",
  // and the widest telling (the whole town) wins over one person's.
  const byStory = new Map<string, { text: string; ts: number; event: boolean }>();
  for (const r of rows) {
    const text = renderMessage({
      type: r.type,
      template_data: r.template_data,
      metadata: r.metadata,
      timestamp: r.timestamp,
    }).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = storyKey(text);
    const prev = byStory.get(key);
    if (prev) {
      const ts = Math.min(prev.ts, r.timestamp);
      byStory.set(key, { ...prev, text: /^The whole town/i.test(text) ? text : prev.text, ts });
      continue;
    }
    if (byStory.size >= MAX_ITEMS) continue;
    byStory.set(key, { text, ts: r.timestamp, event: r.category === 'world_event' });
  }
  const picked = [...byStory.values()].sort((a, b) => a.ts - b.ts);

  const arcs = detectStoryArcs()
    .slice(0, 4)
    .map((a) => ({ title: a.title, summary: a.summary }));

  return {
    items: picked.filter((p) => !p.event).map((p) => p.text),
    events: picked.filter((p) => p.event).map((p) => p.text),
    arcs,
  };
}

export function buildGazettePrompt(material: GazetteMaterial, day: number, season: string, weather: string): {
  system: string;
  user: string;
  format: Record<string, unknown>;
} {
  const section = (title: string, lines: string[]) =>
    lines.length > 0 ? `\n${title}:\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '';
  const system = `You are the editor of ${GAZETTE_NAME}, the local paper of a small town. ${TOWN_SETTING}

Write the edition for day ${day} (${season}, ${weather}) from these reports — they are the ONLY facts you may use. Do not invent events, people or places; you may add period colour, opinion and wit.
${section('What residents did', material.items)}${section('Ongoing stories', material.arcs.map((a) => `${a.title}: ${a.summary}`))}${section('Town happenings', material.events)}
Write like a small-town paper of the time: a punchy headline, 2-4 short articles (2-4 sentences each) and a gossip column of 3-4 sentences hinting at rumours, naming names. The headline and the first article are about residents — who did what to whom (scandal, romance, crime, feuds, loss). Town happenings and weather share one short article at most. Use residents' full names the first time.

Reply with JSON: {"headline":"...","articles":[{"headline":"...","body":"..."}],"gossip":"..."}`;
  return {
    system,
    user: 'Write today\'s edition.',
    format: {
      type: 'object',
      properties: {
        headline: { type: 'string', minLength: 8, maxLength: 110 },
        articles: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              headline: { type: 'string', minLength: 5, maxLength: 90 },
              body: { type: 'string', minLength: 40, maxLength: 600 },
            },
            required: ['headline', 'body'],
          },
        },
        gossip: { type: 'string', minLength: 20, maxLength: 800 },
      },
      required: ['headline', 'articles', 'gossip'],
    },
  };
}

export interface ParsedIssue {
  headline: string;
  articles: GazetteArticle[];
  gossip: string;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim() : '');

export function parseGazette(raw: string): ParsedIssue | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const headline = clean(data.headline);
  const articles = (Array.isArray(data.articles) ? data.articles : [])
    .map((a: Record<string, unknown>) => ({ headline: clean(a?.headline), body: clean(a?.body) }))
    .filter((a) => a.headline && a.body.length >= 20);
  if (!headline || articles.length === 0) return null;
  return { headline, articles, gossip: clean(data.gossip) };
}

let inFlight: Promise<number | null> | null = null;

/**
 * Write an edition covering everything logged since the previous one. Returns
 * the new issue id, or null (quiet day, LLM failure, world replaced, or an
 * edition already being written).
 */
export function writeIssue(): Promise<number | null> {
  if (inFlight) return Promise.resolve(null);
  inFlight = doWrite().finally(() => { inFlight = null; });
  return inFlight;
}

async function doWrite(): Promise<number | null> {
  const world = db.select({ time: worldState.time, weather: worldState.weather }).from(worldState).limit(1).get();
  if (!world) return null;
  const nowTick = world.time.totalTicks;
  const last = db.select({ covers_to_tick: gazetteIssues.covers_to_tick })
    .from(gazetteIssues).orderBy(desc(gazetteIssues.id)).limit(1).get();
  // A replaced world restarts its clock below the last issue's mark.
  const sinceTick = last && last.covers_to_tick <= nowTick ? last.covers_to_tick : 0;

  const material = gatherMaterial(sinceTick);
  if (material.items.length + material.events.length < MIN_ITEMS) return null;

  // The edition is dated for the day it reports on: at the day change that is
  // yesterday.
  const day = world.time.hour < 6 && world.time.day > 1 ? world.time.day - 1 : world.time.day;
  const prompt = buildGazettePrompt(material, day, world.time.season, world.weather);

  let parsed: ParsedIssue | null = null;
  try {
    const res = await callOllamaChat({
      model: CONFIG.AI.LIGHT_MODEL,
      purpose: 'gazette',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      priority: 'low',
      format: prompt.format,
      options: { temperature: 0.8, num_predict: 1100 },
    });
    parsed = parseGazette(res.text);
  } catch (err) {
    console.warn('[gazette] edition failed:', (err as Error).message);
    return null;
  }
  if (!parsed) return null;

  // World replaced while the model wrote: this edition belongs to a town that
  // no longer exists.
  const after = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  if (!after || after.time.totalTicks < nowTick) return null;

  const row = db.insert(gazetteIssues).values({
    day,
    season: world.time.season,
    headline: parsed.headline,
    articles: parsed.articles,
    gossip: parsed.gossip || null,
    covers_to_tick: nowTick,
    created_at: Date.now(),
  }).returning({ id: gazetteIssues.id }).get();
  emitter.markDirty('gazette');
  console.log(`[gazette] day ${day}: ${parsed.headline}`);
  return row.id;
}

export function listIssues(limit = 30) {
  return db.select({ id: gazetteIssues.id, day: gazetteIssues.day, season: gazetteIssues.season, headline: gazetteIssues.headline })
    .from(gazetteIssues).orderBy(desc(gazetteIssues.id)).limit(limit).all();
}

export function getIssue(id?: number) {
  const q = db.select().from(gazetteIssues);
  return (id != null ? q.where(eq(gazetteIssues.id, id)) : q.orderBy(desc(gazetteIssues.id)).limit(1)).get() ?? null;
}
