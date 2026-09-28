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

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
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

// Dialogue-tag verbs that mark text outside quotes as narration rather than
// part of the utterance ("I murmur, leaning in", "Omar smiles.").
const NARRATION_VERB =
  /\b(?:say|says|said|murmur(?:s|ed)?|whisper(?:s|ed)?|ask(?:s|ed)?|repl(?:y|ies|ied)|mutter(?:s|ed)?|add(?:s|ed)?|sigh(?:s|ed)?|laugh(?:s|ed)?|smil(?:e|es|ed)|grin(?:s|ned)?|chuckl(?:e|es|ed)|exclaim(?:s|ed)?|continu(?:e|es|ed)|answer(?:s|ed)?|lean(?:s|ed|ing)?|nod(?:s|ded)?|shrug(?:s|ged)?|purr(?:s|ed)?|teas(?:e|es|ed)|blurt(?:s|ed)?|respond(?:s|ed)?|wink(?:s|ed)?|glanc(?:e|es|ed))\b/i;

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
  // An unclosed "(" or "[" is a direction the token cap cut off mid-way.
  out = out.replace(/[([][^)\]]*$/, ' ');
  out = out.replace(/[)\]]/g, ' ');
  return out;
}

/**
 * Keep only the quoted speech when the reply is narration around a quote.
 * Declines (returns the text unchanged) when the quote looks like part of the
 * utterance itself — "She said "never again" and left." — i.e. the outside text
 * dominates and doesn't read as the speaker narrating themself.
 */
function extractSpokenWords(text: string, speaker: string): string {
  const segments: string[] = [];
  let outside = '';
  let current = '';
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') {
      if (inQuote) {
        segments.push(current);
        current = '';
      }
      inQuote = !inQuote;
    } else if (inQuote) {
      current += ch;
    } else {
      outside += ch;
    }
  }
  // An unclosed quote runs to the end — typically a reply cut by the token cap.
  if (inQuote && current.trim()) segments.push(current);

  const spoken = segments.map((s) => s.trim()).filter(Boolean);
  if (spoken.length === 0) return text.replace(/"/g, ' ');

  const letters = (s: string) => s.replace(/[^\p{L}]/gu, '').length;
  const outsideLetters = letters(outside);
  const quotedLetters = letters(spoken.join(''));

  // The speaker narrating themself: "Omar smiles, …" or "I murmur, leaning in, …".
  const selfNarration =
    (speaker !== '' && new RegExp(`\\b${escapeRegExp(speaker)}\\b`).test(outside)) ||
    (/\bI\s+(?:\w+ly\s+)?\w+/.test(outside) && NARRATION_VERB.test(outside));

  if (outsideLetters === 0 || quotedLetters >= outsideLetters || selfNarration) {
    return spoken.join(' ');
  }
  return text;
}

function stripSpeakerPrefix(text: string, speakerFull: string, speaker: string): string {
  const names = [speakerFull.trim(), speaker].filter(Boolean).map(escapeRegExp);
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

// What follows a name used as a topic rather than as a vocative:
// "Diego, he's been acting strange", "Diego, Rosa and I went fishing".
const THIRD_PARTY_FOLLOW = /^\s*(?:and|or|he|she|they|him|her|his|hers|their|them|that|who|whose|is|was|has|had)\b/i;

/**
 * Repair a vocative that names the wrong townsperson. Conservative on purpose:
 * only the opening vocative ("Oh, Diego, you seem…", "Morning, Elena…") and a
 * sentence-final ", Diego!" are rewritten, only for known townsfolk, and never a
 * name mentioned as a third party ("I saw Diego at the tavern", "Diego? He left").
 */
function fixWrongVocatives(
  text: string,
  speaker: string,
  listener: string,
  townNames: readonly string[],
): string {
  if (!listener) return text;
  const others = [...new Set(townNames.map(firstName))].filter(
    (n) => n && n !== listener && n !== speaker,
  );
  if (others.length === 0) return text;
  const otherAlt = others.map(escapeRegExp).join('|');
  const namesAfter = new RegExp(`^\\s*(?:${otherAlt}|${escapeRegExp(listener)})\\b`);
  let out = text;

  // Self-correction: "Morning, Elena... wait, Carlos" → "Morning, Carlos".
  out = out.replace(
    new RegExp(
      `\\b(?:${otherAlt})\\b\\s*(?:\\.{2,}|…|—|–|-|,)\\s*(?:wait|no|sorry|I mean|er|uh|um)\\b[,.!…]*\\s*(?=${escapeRegExp(listener)}\\b)`,
      'g',
    ),
    '',
  );

  // Opening vocative. Bare at the start it needs a comma or "!" after it; after a
  // greeting, "Morning, Elena." / "Oh, Diego…" count too.
  const prefix = GREETING_PREFIX.exec(out)?.[1] ?? '';
  const afterPrefix = out.slice(prefix.length);
  const nameMatch = new RegExp(`^(${otherAlt})\\b`).exec(afterPrefix);
  if (nameMatch) {
    const rest = afterPrefix.slice(nameMatch[0].length);
    const punct = /^\s*(,|!|\.{2,}|…|—|–|\.(?=\s|$))/.exec(rest);
    if (punct && (prefix || punct[1] === ',' || punct[1] === '!')) {
      const follow = rest.slice(punct[0].length);
      if (!THIRD_PARTY_FOLLOW.test(follow) && !namesAfter.test(follow)) {
        out = prefix + listener + rest;
      }
    }
  }

  // Sentence-final vocative: "…good to see you, Diego!". Needs a real clause
  // before the comma — "Yes, Diego." may well be an answer about Diego.
  out = out.replace(
    new RegExp(`,\\s*(?:${otherAlt})(?=\\s*[!.…]+(?:\\s|$))`, 'g'),
    (match: string, offset: number, whole: string) => {
      const clause = whole.slice(0, offset).split(/[.!?…]\s+/).pop() ?? '';
      return clause.trim().split(/\s+/).length >= 3 ? `, ${listener}` : match;
    },
  );
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
  text = stripSpeakerPrefix(text, opts.speakerName, speaker);
  text = extractSpokenWords(text, speaker);
  text = tidy(text);
  text = fixWrongVocatives(text, speaker, listener, opts.townNames ?? []);
  if (opts.truncated) text = trimIncompleteTail(text);

  // Nothing speakable left (only punctuation, or a lone letter).
  if (text.replace(/[^\p{L}]/gu, '').length < 2) return '';
  return text;
}
