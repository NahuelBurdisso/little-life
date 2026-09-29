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
 */
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import { firstName } from '../../ai/names';

export interface SummaryLine {
  speaker: string;
  text: string;
}

/** Fewer spoken lines than this and there is nothing to summarise. */
export const MIN_SUMMARY_LINES = 4;

export function buildSummaryPrompt(participants: string[], lines: SummaryLine[]): {
  system: string;
  user: string;
  format: Record<string, unknown>;
} {
  const transcript = lines.map((l) => `${firstName(l.speaker)}: ${l.text}`).join('\n');
  const properties: Record<string, unknown> = {};
  for (const p of participants) properties[p] = { type: 'string', minLength: 10, maxLength: 240 };
  const system = `You write the private memory each person keeps after a conversation in a small town.

Conversation between ${participants.join(' and ')}:
${transcript}

For each person, write one first-person sentence (under 30 words) with what THEY will remember: what they learned, agreed, promised, suspected or felt about the other — concrete, from their own point of view. Skip greetings and goodbyes.

Reply with JSON: {${participants.map((p) => `"${p}":"I ..."`).join(',')}}`;
  return {
    system,
    user: 'Write the memories.',
    format: { type: 'object', properties, required: participants },
  };
}

/** Takeaway per participant name, or null if the reply is unusable. */
export function parseSummary(raw: string, participants: string[]): Map<string, string> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const out = new Map<string, string>();
  for (const p of participants) {
    const v = (data as Record<string, unknown>)[p];
    if (typeof v !== 'string') continue;
    const text = v.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
    if (text.length >= 10) out.set(p, text);
  }
  return out.size > 0 ? out : null;
}

export async function summarizeConversation(participants: string[], lines: SummaryLine[]): Promise<Map<string, string> | null> {
  if (participants.length < 2 || lines.length < MIN_SUMMARY_LINES) return null;
  const prompt = buildSummaryPrompt(participants, lines);
  try {
    const res = await callOllamaChat({
      model: CONFIG.AI.LIGHT_MODEL,
      purpose: 'conversation.summary',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      priority: 'normal',
      format: prompt.format,
      options: { temperature: 0.5, num_predict: 90 * participants.length },
    });
    return parseSummary(res.text, participants);
  } catch {
    return null;
  }
}
