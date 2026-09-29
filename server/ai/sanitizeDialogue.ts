/**
 * Dialogue sanitiser — turns raw chat-model output into the words a townsperson
 * actually says aloud.
 *
 * The small local model (gemma e4b) routinely ignores "natural speech, not prose":
 * a playtest of 104 lines found 47 with parenthesised stage directions (often in
 * the second person, reading like leaked prompt text), 15 wrapped in literal
 * quotes, narration around the quoted speech ("I murmur, leaning in slightly,
 * "…""), markdown asterisks, emoji, newlines, "[Your Name]" placeholders and
 * wrong-person vocatives. Speech bubbles, the transcript, the sentiment scorer
 * and — through the conversation history — the *next* prompt all consumed that
 * text verbatim, so every leak also primed the model to repeat it.
 *
 * Pure function, no I/O: the caller supplies the names it needs. It returns ''
 * when nothing speakable is left, and the caller treats that exactly like an
 * empty model reply (retry once, then the canned fallback).
 */

import { firstName, nameVariants } from './names';

export interface DialogueSanitizeOptions {
  /** Full name of the agent speaking. */
  speakerName: string;
  /** Full name of the agent being spoken to. */
  listenerName: string;
  /**
   * Full names of every townsperson. Only used to spot a wrong-person vocative
   * ("Oh, Diego, …" said to Rosa); names are never touched in other positions.
   */
  townNames?: readonly string[];
  /** The model stopped because it hit the token cap (done_reason "length"). */
  truncated?: boolean;
}

// Canned lines used when the model produced nothing usable. They are narration,
// not speech, so anything that mines transcripts for what was *said* (the
// conversation-end memory) has to be able to recognise and skip them.
const FALLBACK_REPLIES: Array<(name: string) => string> = [
  (name) => `${name} smiled and nodded.`,
  (name) => `${name} paused thoughtfully.`,
  (name) => `"Hmm, interesting," ${name} said.`,
  (name) => `${name} shrugged.`,
];
const FALLBACK_REPLY = /^(?:[\p{L}' -]+ (?:smiled and nodded|paused thoughtfully|shrugged)\.|"Hmm, interesting," [\p{L}' -]+ said\.)$/u;

export function fallbackReply(speakerName: string): string {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)](speakerName);
}

function isFallbackReply(text: string): boolean {
  return FALLBACK_REPLY.test(text.trim());
}

/**
 * A stored conversation message that is a canned fallback, not speech. New ones
 * carry `fallback: true`; the text match covers transcripts stored before that.
 */
export function isFallbackMessage(msg: { text?: string; fallback?: boolean }): boolean {
  return msg.fallback === true || (typeof msg.text === 'string' && isFallbackReply(msg.text));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pictographs, regional-indicator flags, skin-tone modifiers and the joiners /
// variation selectors that glue multi-codepoint emoji together.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

// "[Your Name]", "(Name)", "{name}", "{{name}}", "<Their Name>", "[Friend's name]" —
// template-style slots the model emits when it can't place who it is talking to.
// "my" slots mean the speaker; everything else is addressed to the listener.
const PLACEHOLDER =
  /\{\{\s*name\s*\}\}|[[({<]\s*(?:(my|your|their|his|her|the other person'?s?|other person'?s?|listener'?s?|friend'?s?|person'?s?|character'?s?)\s+)?(?:first\s+)?name\s*[\])}>]/gi;

// One- or two-word asterisk spans are usually emphasis ("I *really* mean it") and
// keep their words — unless they are one of the stock gestures the model uses as
// actions ("*sighs*", "*leans in*"). Longer spans are always actions.
const ASTERISK_GESTURE =
  /^(?:\w+ly\s+)?(?:sigh|laugh|chuckle|giggle|smile|grin|wink|shrug|nod|pause|blush|smirk|frown|gasp|cough|groan|snort|scoff|gulp|lean|look|glance|stare|wave|hug|clear)(?:s|es|ed|d|ing)?\b/i;

// Verbs of a dialogue tag or a self-narrated gesture: "I murmur", "Omar grins",
// "I lean closer". Deliberately excludes tell/hear/call — "I heard Diego say…",
// "I told her…" introduce reported speech, not a tag.
const TAG_VERB =
  /^(?:say|says|said|murmur(?:s|ed)?|whisper(?:s|ed)?|ask(?:s|ed)?|repl(?:y|ies|ied)|mutter(?:s|ed)?|add(?:s|ed)?|sigh(?:s|ed)?|laugh(?:s|ed)?|smil(?:e|es|ed)|grin(?:s|ned)?|chuckl(?:e|es|ed)|exclaim(?:s|ed)?|continu(?:e|es|ed)|answer(?:s|ed)?|lean(?:s|ed)?|nod(?:s|ded)?|shrug(?:s|ged)?|purr(?:s|ed)?|teas(?:e|es|ed)|blurt(?:s|ed)?|respond(?:s|ed)?|wink(?:s|ed)?|glanc(?:e|es|ed)|look(?:s|ed)?|paus(?:e|es|ed)|tap(?:s|ped)?|step(?:s|ped)?|turn(?:s|ed)?|wav(?:e|es|ed)|sip(?:s|ped)?|smirk(?:s|ed)?|frown(?:s|ed)?|blush(?:es|ed)?|offer(?:s|ed)?)$/i;

// Words that would start a second clause inside what claims to be a tag
// ("I said "no" and walked away", "Diego said "stay away" so I did").
const CLAUSE_WORD = /^(?:and|but|so|because|that|while|when|if|then|who|which|he|she|they|we|you|it)$/i;

/**
 * One sentence of text outside the quotes, judged as a dialogue tag / gesture of
 * the speaker themself: subject ("I" or the speaker's own name), an optional
 * adverb, a tag verb, then at most a short tail with no second clause
 * ("I murmur, leaning in slightly", "Omar grins", "I say, tapping the table").
 * A third party ("She whispered…", "Diego said…") is never a tag — that is the
 * speaker reporting someone else's words.
 */
function isSelfTag(sentence: string, speakerNames: readonly string[]): boolean {
  const words = sentence.replace(/[,;:—–\-.!?…]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  let i = 0;
  // Subject: "I" or the speaker's (one- or two-word) name.
  if (words[0] === 'I') {
    i = 1;
  } else {
    // Tag words had their punctuation stripped, so compare "Dr. Sofia" as "Dr Sofia".
    const matched = speakerNames
      .map((n) => n.replace(/\./g, '').split(/\s+/))
      .find((parts) => parts.every((p, k) => words[k] === p));
    if (!matched) return false;
    i = matched.length;
  }
  if (words[i] && /ly$/i.test(words[i]) && words[i + 1] && TAG_VERB.test(words[i + 1])) i++;
  if (!words[i] || !TAG_VERB.test(words[i])) return false;
  const tail = words.slice(i + 1);
  return tail.length <= 6 && !tail.some((w) => CLAUSE_WORD.test(w));
}

function replacePlaceholders(text: string, speaker: string, listener: string): string {
  return text.replace(PLACEHOLDER, (_m, owner: string | undefined) =>
    owner && owner.toLowerCase() === 'my' ? speaker : listener,
  );
}

function stripStageDirections(text: string): string {
  let out = text;
  // Asterisk spans first: "*(Marco leans in…)*" wraps a parenthetical.
  out = out.replace(/\*+([^*]+)\*+/g, (_m, inner: string) => {
    const words = inner.trim().split(/\s+/).filter(Boolean);
    if (words.length <= 2 && !/[()]/.test(inner) && !ASTERISK_GESTURE.test(inner.trim())) {
      return inner;
    }
    return ' ';
  });
  out = out.replace(/\*/g, '');
  // Nested parentheticals are rare but cheap to handle: peel innermost first.
  let prev: string;
  do {
    prev = out;
    out = out.replace(/\([^()]*\)/g, ' ').replace(/\[[^[\]]*\]/g, ' ');
  } while (out !== prev);
  // An unclosed "(" or "[" is a direction the token cap cut off mid-way: drop
  // from the first opener that no closer follows. A linear scan, since the
  // equivalent /[([][^)\]]*$/ backtracks quadratically on a run of openers.
  const lastCloser = Math.max(out.lastIndexOf(')'), out.lastIndexOf(']'));
  const tail = out.slice(lastCloser + 1).search(/[([]/);
  if (tail !== -1) out = `${out.slice(0, lastCloser + 1 + tail)} `;
  out = out.replace(/[)\]]/g, ' ');
  return out;
}

/**
 * Keep only the quoted speech when the reply is the speaker narrating around a
 * quote ("I murmur, leaning in slightly, "…"", ""Maybe," Omar said.").
 * Extracts only when EVERY sentence outside the quotes is a short dialogue tag
 * or gesture of the speaker themself (see `isSelfTag`). Anything else — reported
 * speech ("She whispered "I never loved him" and I believed her."), a quote
 * inside a full clause — is left exactly as written.
 */
function extractSpokenWords(text: string, speakerNames: readonly string[]): string {
  const segments: string[] = [];
  const outsides: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') {
      (inQuote ? segments : outsides).push(current);
      current = '';
      inQuote = !inQuote;
    } else {
      current += ch;
    }
  }
  // An unclosed quote runs to the end — typically a reply cut by the token cap.
  (inQuote ? segments : outsides).push(current);

  const spoken = segments.map((s) => s.trim()).filter(Boolean);
  if (spoken.length === 0) return text.replace(/"/g, ' ');

  const allTags = outsides.every((seg) =>
    seg
      // Sentence ends, but not the "." of a title ("Dr. Sofia Petrov sighs.").
      .split(/(?<=[.!?…])(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|Rev|St)\.)\s+/)
      .every((sentence) => !/\p{L}/u.test(sentence) || isSelfTag(sentence, speakerNames)),
  );
  return allTags ? spoken.join(' ') : text;
}

function stripSpeakerPrefix(text: string, speakerNames: readonly string[]): string {
  const names = speakerNames.map(escapeRegExp);
  if (names.length === 0) return text;
  return text.replace(new RegExp(`^\\s*(?:${names.join('|')})\\s*:\\s*`, 'i'), '');
}

function tidy(text: string): string {
  let out = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    // Punctuation orphaned by a removed span: "asking, ." → "asking."
    .replace(/[,;:]+(?=[.!?…])/g, '')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .trim();
  // Leading debris: ", I think…" after a stripped opening direction.
  out = out.replace(/^(?:[,;:\-–—]|\.(?!\.))+\s*/, '');
  // Wrapping single quotes ('Fine, then.') — only when both ends carry one.
  if (/^['‘][\s\S]*['’]$/.test(out) && out.length > 2) out = out.slice(1, -1).trim();
  // A dangling comma left by quote extraction ("Hmm, interesting," Omar said).
  out = out.replace(/[,;:]+$/, '.');
  if (/^\p{Ll}/u.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

// Greetings/interjections that may precede an opening vocative ("Oh, Diego, …",
// "Good morning, Elena…"). Deliberately excludes "yes"/"no": "Yes, Diego." is as
// likely an answer about Diego as a word to him.
const GREETING_PREFIX =
  /^((?:(?:oh|ah|aw|hey|hi|hello|morning|good morning|good afternoon|good evening|evening|afternoon|well|thanks|thank you|sorry|dear|oh my|why|listen|look)[,!.…]*\s+){1,2})/i;

// What follows a name used as a topic or with an appositive rather than as a
// vocative: "Diego, he's been acting strange", "Diego, of all people, told me",
// "Marco, the baker, said so", "Diego, Rosa and I went fishing".
const THIRD_PARTY_FOLLOW =
  /^\s*(?:of all people|the|a|an|my|your|told|said|says|he|she|they|and|or|is|was|has|had|him|her|his|hers|their|them|that|who|whose)\b/i;

// The clause after a real vocative is addressed to the listener.
const SECOND_PERSON = /\b(?:you|your|you're|you've|you'll|you'd|yours|yourself)\b/i;

// First names that are also ordinary English words: too easy to misread as a
// vocative ("Will, you coming?"), so never "corrected".
const WORD_NAMES = new Set([
  'Hope', 'May', 'Will', 'Grace', 'Faith', 'Joy', 'June', 'April', 'Rose', 'Mark', 'Bill',
  'Pat', 'Sue', 'Art', 'Ray', 'Dawn', 'Summer', 'Autumn', 'Frank', 'Jack', 'Rich', 'Chance',
  'Sky', 'Iris', 'Ivy', 'Holly', 'Daisy', 'Violet', 'Lily', 'Ruby', 'Amber', 'Pearl', 'Honey',
  'Sunny', 'Melody', 'Hunter', 'Bob', 'Guy', 'Destiny', 'Harmony', 'Patience', 'Prudence',
]);

/**
 * Repair a vocative that names the wrong townsperson. Conservative on purpose:
 * only an OPENING vocative whose clause is plainly addressed to the listener
 * ("Oh, Diego, you seem deep in thought") and the self-correction
 * "Elena... wait, Carlos" are touched, only for known townsfolk. Names anywhere
 * else — "I ran into your ex, Diego.", "Diego, of all people, told me." — are
 * left alone: an appositive or a third party reads exactly like a misplaced
 * vocative, and rewriting it would put words in the speaker's mouth.
 */
function fixWrongVocatives(
  text: string,
  speaker: string,
  listener: string,
  townNames: readonly string[],
): string {
  if (!listener) return text;
  const allOthers = [...new Set(townNames.map(firstName))].filter(
    (n) => n && n !== listener && n !== speaker,
  );
  if (allOthers.length === 0) return text;
  const allAlt = allOthers.map(escapeRegExp).join('|');
  let out = text;

  // Self-correction: "Morning, Elena... wait, Carlos" → "Morning, Carlos". The
  // model names the listener itself, so this holds even for word-names.
  out = out.replace(
    new RegExp(
      `\\b(?:${allAlt})\\b\\s*(?:\\.{2,}|…|—|–|-|,)\\s*(?:wait|no|sorry|I mean|er|uh|um)\\b[,.!…]*\\s*(?=${escapeRegExp(listener)}\\b)`,
      'g',
    ),
    '',
  );

  const others = allOthers.filter((n) => !WORD_NAMES.has(n));
  if (others.length === 0) return out;
  const otherAlt = others.map(escapeRegExp).join('|');
  const namesAfter = new RegExp(`^\\s*(?:${allAlt}|${escapeRegExp(listener)})\\b`);

  // Opening vocative. Bare at the start it needs a comma or "!" after it; after a
  // greeting, "Morning, Elena… you look tired" counts too. Either way the rest
  // of the clause must address someone ("you", "your").
  const prefix = GREETING_PREFIX.exec(out)?.[1] ?? '';
  const afterPrefix = out.slice(prefix.length);
  const nameMatch = new RegExp(`^(${otherAlt})\\b`).exec(afterPrefix);
  if (nameMatch) {
    const rest = afterPrefix.slice(nameMatch[0].length);
    const punct = /^\s*(,|!|\.{2,}|…|—|–|\.(?=\s|$))/.exec(rest);
    if (punct && (prefix || punct[1] === ',' || punct[1] === '!')) {
      const follow = rest.slice(punct[0].length);
      const clause = follow.split(/[.!?…]/)[0] ?? '';
      if (!THIRD_PARTY_FOLLOW.test(follow) && !namesAfter.test(follow) && SECOND_PERSON.test(clause)) {
        out = prefix + listener + rest;
      }
    }
  }
  return out;
}

const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt)$/;

/**
 * Drop an unfinished trailing sentence from a reply the token cap cut off.
 * A reply with no complete sentence at all is kept and marked as trailing off,
 * since a clipped line still beats a canned fallback.
 */
function trimIncompleteTail(text: string): string {
  if (/[.!?…]["'’)]*$/.test(text) || /[—–]$/.test(text)) return text;
  const boundary = /[.!?…]+["'’)]*(?=\s)/g;
  let cut = -1;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    if (m[0].startsWith('.') && m[0].length === 1 && ABBREVIATION.test(text.slice(0, m.index))) continue;
    cut = m.index + m[0].length;
  }
  if (cut > 0) return text.slice(0, cut).trim();
  return text.replace(/[\s,;:\-–—]+$/, '') + '…';
}

export function sanitizeDialogue(raw: string, opts: DialogueSanitizeOptions): string {
  const speaker = firstName(opts.speakerName);
  const listener = firstName(opts.listenerName);

  let text = raw.replace(/\r\n?/g, '\n').replace(/[“”„‟«»]/g, '"');
  text = replacePlaceholders(text, speaker, listener);
  text = text.replace(EMOJI, '');
  text = stripStageDirections(text);
  text = text.replace(/\s+/g, ' ').trim();
  const speakerNames = nameVariants(opts.speakerName);
  text = stripSpeakerPrefix(text, speakerNames);
  text = extractSpokenWords(text, speakerNames);
  text = tidy(text);
  text = fixWrongVocatives(text, speaker, listener, opts.townNames ?? []);
  if (opts.truncated) text = trimIncompleteTail(text);

  // Nothing speakable left (only punctuation, or a lone letter).
  if (text.replace(/[^\p{L}]/gu, '').length < 2) return '';
  return text;
}
