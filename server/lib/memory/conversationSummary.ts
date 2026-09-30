/**
 * What each participant takes away from a finished LLM conversation.
 *
 * The end-of-conversation memory used to quote the transcript's most loaded
 * line (conversationGist.ts) — often a goodbye or half a thought, and always
 * only one side of it. Generative Agents instead summarises the dialogue from
 * each speaker's point of view; that is what later retrieval, reflection and
 * planning actually need ("Marco admitted he's broke and I promised to lend
 * him $10"). One structured call covers every participant, and its output is
 * short: at ~8 LLM conversations per game day it costs a few hundred tokens.
 *
 * Anything that goes wrong returns null and the caller falls back to the gist.
 *
 * For a two-person talk the same call also judges how it went (`feelings`,
 * -3..+3 per side; lib/conversationFeelings.ts turns it into friendship). The
 * word-list sentiment scorer is the only other judge, and polite 1900-era
 * dialogue scores ~0 on it: a slight or a refusal said courteously moved
 * nothing, so relationships only ever went up. One extra field in a call that
 * already runs is the cheapest reader of tone the game has.
 */
import { callOllamaChat } from '../../ai/ollama';
import type { LLMPriority } from '../../ai/llmSemaphore';
import { CONFIG } from '../constants';
import { firstName } from '../../ai/names';
import { maturityDirective } from '../../ai/contentRating';
import { isAdultContent } from '../worldRules';

export interface SummaryLine {
  speaker: string;
  text: string;
}

/** Fewer spoken lines than this and there is nothing to summarise. */
export const MIN_SUMMARY_LINES = 4;

/**
 * Fewer spoken lines than this and an OFF-SCREEN chat keeps the gist memory
 * (conversationGist.ts, no LLM) instead of a summary. A standard chat runs up
 * to MAX_TURNS_STANDARD (6) lines, and one of 4–5 is mostly greeting, one
 * exchange and a goodbye: the gist quotes its loaded line just as well, and
 * the summary call — one per conversation, in the same chat pool as the
 * dialogue — is better spent on a chat the player is reading. On screen
 * (lib/spotlight.ts) the MIN_SUMMARY_LINES floor applies as before.
 */
export const OFFSCREEN_MIN_SUMMARY_LINES = 6;

/**
 * Whether a finished conversation gets an LLM summary, and at what priority:
 * null = keep the non-LLM gist memory. On screen: from MIN_SUMMARY_LINES, at
 * 'normal'. Off screen: from OFFSCREEN_MIN_SUMMARY_LINES, at 'low' — a
 * takeaway nobody is waiting to read can queue behind plans and dialogue.
 */
export function summaryPriority(spokenLines: number, watched: boolean): LLMPriority | null {
  if (watched) return spokenLines >= MIN_SUMMARY_LINES ? 'normal' : null;
  return spokenLines >= OFFSCREEN_MIN_SUMMARY_LINES ? 'low' : null;
}

/**
 * `allAdults`: every participant is 18 or over. The summary is one call for both sides, so the
 * adult tone needs the whole conversation to be adults; a single minor in it keeps the line chaste.
 * Fails closed: callers that do not know the ages get the chaste line.
 */
export function buildSummaryPrompt(participants: string[], lines: SummaryLine[], allAdults = false, withFeelings = false): {
  system: string;
  user: string;
  format: Record<string, unknown>;
} {
  const transcript = lines.map((l) => `${firstName(l.speaker)}: ${l.text}`).join('\n');
  const properties: Record<string, unknown> = {};
  for (const p of participants) properties[p] = { type: 'string', minLength: 10, maxLength: 240 };
  // Asked only of a pair (conversationFeelings applies nothing else): "the other
  // person" has one meaning, and group chats don't pay the extra tokens.
  const feelings = withFeelings && participants.length === 2;
  if (feelings) {
    const scores: Record<string, unknown> = {};
    for (const p of participants) scores[p] = { type: 'integer', minimum: -FEELING_MAX, maximum: FEELING_MAX };
    properties.feelings = { type: 'object', properties: scores, required: participants };
  }
  const feelingsAsk = feelings
    ? `

Also "feelings": for each person, an integer from -3 to 3 — how they now feel about the other person compared with before the talk (-3 badly hurt or offended, 0 no change, +3 much warmer). Most talks are 0 or ±1. Use a negative when there was a slight, a refusal, an accusation, jealousy, condescension or a sore topic, even if said politely.`
    : '';
  const replyShape = participants.map((p) => `"${p}":"I ..."`).join(',')
    + (feelings ? `,"feelings":{${participants.map((p) => `"${p}":0`).join(',')}}` : '');
  const system = `You write the private memory each person keeps after a conversation in a small town. ${maturityDirective(isAdultContent() && allAdults)}

Conversation between ${participants.join(' and ')}:
${transcript}

For each person, write one first-person sentence (under 30 words) with what THEY will remember: what they learned, agreed, promised, suspected or felt about the other — concrete, from their own point of view. Skip greetings and goodbyes. Mention only people named in the conversation or living in town; never invent anyone.${feelingsAsk}

Reply with JSON: {${replyShape}}`;
  return {
    system,
    user: 'Write the memories.',
    format: { type: 'object', properties, required: feelings ? [...participants, 'feelings'] : participants },
  };
}

/** The outermost JSON object in a reply, or null. Tolerates prose or fences around it. */
function parseReplyObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

/** Takeaway per participant name, or null if the reply is unusable. */
export function parseSummary(raw: string, participants: string[]): Map<string, string> | null {
  const data = parseReplyObject(raw);
  if (!data) return null;
  const out = new Map<string, string>();
  for (const p of participants) {
    const v = (data as Record<string, unknown>)[p];
    if (typeof v !== 'string') continue;
    const text = v.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
    if (text.length >= 10) out.set(p, text);
  }
  return out.size > 0 ? out : null;
}

/** The judged range: -FEELING_MAX (badly hurt) .. +FEELING_MAX (much warmer). */
export const FEELING_MAX = 3;

/**
 * One judged value, or null when there is nothing usable. Numbers, and numeric
 * strings a model without the schema may write ("-2", "+1"); rounded and clamped
 * to the range, so a stray 5 is a 3 rather than a lost verdict.
 */
function readFeeling(v: unknown): number | null {
  const n = typeof v === 'number' ? v
    : typeof v === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(v) ? Number(v)
    : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(-FEELING_MAX, Math.min(FEELING_MAX, Math.round(n)));
}

/**
 * How each participant now feels about the other (`feelings` in the reply), by
 * participant name. Empty when the field is missing or unusable — the takeaways
 * parse on their own, so a reply without it (a model that skipped the field)
 * still gives its memories. Keys are matched exactly, then ignoring case, then
 * by first name (the transcript labels speakers by first name, and a model
 * without the schema may key by it).
 */
export function parseFeelings(raw: string, participants: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const feelings = parseReplyObject(raw)?.feelings;
  if (!feelings || typeof feelings !== 'object' || Array.isArray(feelings)) return out;
  const entries = Object.entries(feelings as Record<string, unknown>);
  for (const p of participants) {
    const hit = entries.find(([k]) => k === p)
      ?? entries.find(([k]) => k.trim().toLowerCase() === p.toLowerCase())
      ?? entries.find(([k]) => k.trim().toLowerCase() === firstName(p).toLowerCase());
    const value = hit ? readFeeling(hit[1]) : null;
    if (value != null) out.set(p, value);
  }
  return out;
}

/** What the summary call gives back: each side's memory and, for a pair, how it went. */
export interface ConversationSummary {
  /** Takeaway per participant name; null if none was usable (the caller keeps the gist). */
  takeaways: Map<string, string> | null;
  /** Judged feeling per participant name (-3..+3). Empty unless asked for and answered. */
  feelings: Map<string, number>;
}

export async function summarizeConversation(
  participants: string[],
  lines: SummaryLine[],
  priority: LLMPriority = 'normal',
  allAdults = false,
  withFeelings = false,
): Promise<ConversationSummary | null> {
  if (participants.length < 2 || lines.length < MIN_SUMMARY_LINES) return null;
  const prompt = buildSummaryPrompt(participants, lines, allAdults, withFeelings);
  const feelings = withFeelings && participants.length === 2;
  try {
    const res = await callOllamaChat({
      model: CONFIG.AI.LIGHT_MODEL,
      purpose: 'conversation.summary',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      priority,
      format: prompt.format,
      // The feelings object is ~20 tokens; room is added so it can't cut a takeaway short.
      options: { temperature: 0.5, num_predict: 90 * participants.length + (feelings ? 40 : 0) },
    });
    return {
      takeaways: parseSummary(res.text, participants),
      feelings: feelings ? parseFeelings(res.text, participants) : new Map(),
    };
  } catch {
    return null;
  }
}
