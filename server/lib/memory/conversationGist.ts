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
// High enough that one keyword alone ("I feel like it might rain") doesn't
// make a line memorable; it also needs emotional charge or a disclosure.
const MIN_SCORE = 1.2;
const CHARGED_SENTIMENT = 0.3;

// Words that mark a line as something a person would still think about later.
// Ambiguous everyday words are pinned to their loaded sense: "lie" only as
// "lie(d) to"/"liar" (not "lie down"), "feel" only with an emotion or "about
// you" (not "feel like it might rain"). together/dream/alone were dropped:
// "let's get together", "dream job", "alone at the shop" are small talk.
const LOADED = new RegExp(
  [
    String.raw`\b(?:love[sd]?|feelings|miss(?:ed)?|sorry|forgive|promise[sd]?|secret|afraid|scared|hate[sd]?|marry|kiss(?:ed)?|trust|truth|confess(?:ed)?|heart|lonely|pregnant|debt|owe|fired|quit|died|dead|funeral|cheat(?:ed|ing)?|affair|jealous|angry|furious|proud|divorce|betray(?:ed)?)\b`,
    String.raw`\b(?:lied?|lying) to\b|\bliar\b`,
    String.raw`\bfeel(?:s|ing)?\b[^.!?]{0,20}?\b(?:about you|the same|sad|happy|lonely|scared|afraid|guilty|terrible|awful|hurt|angry|betrayed|lost|safe|jealous|ashamed|sorry|alone|used|empty)\b`,
  ].join('|'),
  'i',
);

// First-person disclosure: "I'm scared", "I've never told anyone", "I need…".
const DISCLOSURE = /\bI(?:'m|'ve|'d| am| was| feel| think| want| need| have| can't| never| wish| love| hate)\b/;

const SMALL_TALK =
  /\bhow are you|how's it going|how have you been|how(?:'re| are) you (?:doing|holding up)|nice (?:weather|day)|good (?:morning|afternoon|evening)|see you (?:around|later|soon)|take care|goodbye|have a good\b/i;

/** Null when the line doesn't qualify at all, else its salience score. */
function score(text: string, sentiment: number): number | null {
  const charged = Math.abs(sentiment) >= CHARGED_SENTIMENT;
  const loaded = LOADED.test(text);
  const disclosure = DISCLOSURE.test(text);
  // Either real emotional charge, or two content signals together.
  if (!charged && !(loaded && disclosure)) return null;
  let s = Math.abs(sentiment);
  if (loaded) s += 1;
  if (disclosure) s += 0.4;
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
  const best = pickLoadedLine(lines, nameOf);
  return best ? { speakerId: best.speakerId, quote: shorten(best.text) } : null;
}

/**
 * The most loaded line itself (sanitised, not shortened), or null when nothing
 * clears the gist's bar. Confided secrets use it: they used to take the
 * speaker's latest line with four words in it, so a canned "Lucia Fernandez
 * smiled and nodded." and a goodbye ("I will see you at the house later this
 * evening.") became sensitivity-3 secrets that the town then passed around.
 */
export function pickLoadedLine(
  lines: readonly GistLine[],
  nameOf: (speakerId: number) => string | undefined = () => undefined,
): { speakerId: number; text: string } | null {
  let best: { line: GistLine; text: string; score: number } | null = null;
  for (const line of lines) {
    if (!line.text || isFallbackMessage(line, nameOf(line.speakerId))) continue;
    // Stored lines are sanitised on the way in now, but older transcripts are
    // not — re-running the (idempotent) sanitiser keeps directions out of memory.
    const text = sanitizeDialogue(line.text, { speakerName: nameOf(line.speakerId) ?? '', listenerName: '' });
    if (text.split(/\s+/).length < 4) continue;
    const s = score(text, line.sentiment ?? 0);
    if (s !== null && (!best || s > best.score)) best = { line, text, score: s };
  }
  if (!best || best.score < MIN_SCORE) return null;
  return { speakerId: best.line.speakerId, text: best.text };
}
