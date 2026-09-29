/**
 * Conversation gist — the one line worth remembering from a finished conversation.
 *
 * End-of-conversation memories used to be pure templates ("X and I wrapped up
 * our conversation", "…talked about flirting"): even after Rosa and Yuki
 * confessed their feelings, neither remembered anything that was said. And the
 * topic label was the only content, so it leaked back into later dialogue as
 * meta-talk ("what we talked about the other day regarding offering comfort").
 *
 * This picks the most emotionally loaded line of the transcript with a cheap
 * heuristic — no extra LLM call — so the memory can quote it. Returns null when
 * nothing clears the bar (small talk, canned fallbacks, template chatter), and
 * the caller keeps the old topic template.
 */

import { sanitizeDialogue, isFallbackMessage } from '../../ai/sanitizeDialogue';

export interface GistLine {
  speakerId: number;
  text: string;
  /** Per-message sentiment in [-1, 1], as stored on the conversation. */
  sentiment?: number;
  /** Canned fallback action, not speech. */
  fallback?: boolean;
}

export interface ConversationGist {
  speakerId: number;
  quote: string;
}

const MAX_QUOTE_CHARS = 110;
const MIN_SCORE = 0.6;

// Words that mark a line as something a person would still think about later.
const LOADED =
  /\b(?:love[sd]?|feel(?:s|ing|ings)?|miss(?:ed)?|sorry|forgive|promise[sd]?|secret|afraid|scared|hate[sd]?|marry|kiss(?:ed)?|trust|li(?:e|ed|ar)|truth|confess(?:ed)?|heart|lonely|alone|pregnant|debt|owe|fired|quit|died|dead|funeral|cheat(?:ed|ing)?|affair|jealous|angry|furious|proud|dream|together|divorce|betray(?:ed)?)\b/i;

// First-person disclosure: "I'm scared", "I've never told anyone", "I need…".
const DISCLOSURE = /\bI(?:'m|'ve|'d| am| was| feel| think| want| need| have| can't| never| wish| love| hate)\b/;

const SMALL_TALK =
  /\bhow are you|how's it going|how have you been|how(?:'re| are) you (?:doing|holding up)|nice (?:weather|day)|good (?:morning|afternoon|evening)|see you (?:around|later|soon)|take care|goodbye|have a good\b/i;

function score(text: string, sentiment: number): number {
  let s = Math.abs(sentiment);
  if (LOADED.test(text)) s += 1;
  if (DISCLOSURE.test(text)) s += 0.4;
  if (SMALL_TALK.test(text)) s -= 1;
  // A bare question ("You okay?") is rarely what stays with someone.
  if (/\?$/.test(text) && !/[.!…]\s/.test(text)) s -= 0.3;
  return s;
}

/** Shorten to the most loaded sentence, then to a word boundary. */
function shorten(text: string): string {
  let out = text;
  if (out.length > MAX_QUOTE_CHARS) {
    const sentences = out.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [out];
    out = sentences.find((s) => LOADED.test(s)) ?? sentences[0];
  }
  if (out.length > MAX_QUOTE_CHARS) {
    out = out.slice(0, MAX_QUOTE_CHARS).replace(/\s+\S*$/, '').replace(/[\s,;:]+$/, '') + '…';
  }
  // The memory wraps the quote in double quotes; keep them from nesting.
  return out.replace(/"/g, "'");
}

/**
 * @param nameOf resolves a speakerId to the agent's full name, so older,
 *   unsanitised lines lose their "Dr. Sofia:" prefixes and self-narrated tags.
 */
export function pickConversationGist(
  lines: readonly GistLine[],
  nameOf: (speakerId: number) => string | undefined = () => undefined,
): ConversationGist | null {
  let best: { line: GistLine; text: string; score: number } | null = null;
  for (const line of lines) {
    if (!line.text || isFallbackMessage(line)) continue;
    // Stored lines are sanitised on the way in now, but older transcripts are
    // not — re-running the (idempotent) sanitiser keeps directions out of memory.
    const text = sanitizeDialogue(line.text, { speakerName: nameOf(line.speakerId) ?? '', listenerName: '' });
    if (text.split(/\s+/).length < 4) continue;
    const s = score(text, line.sentiment ?? 0);
    if (!best || s > best.score) best = { line, text, score: s };
  }
  if (!best || best.score < MIN_SCORE) return null;
  return { speakerId: best.line.speakerId, quote: shorten(best.text) };
}
