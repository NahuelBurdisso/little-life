/**
 * Pure text helpers for turning free text — shared_knowledge content, LLM lines,
 * plan summaries — into sentences the player reads in the feed.
 *
 * Fact content comes from many authors (FACT_GENERATORS, the secrets pool, the
 * setup wizard, LLM quotes) and none of them agree on trailing punctuation, so
 * every builder that splices a fact into a sentence has to normalise it first.
 * Splicing it raw is what produced "…and it ended badly.." in the feed.
 *
 * No DB or Node imports: the client's activityMessage.ts imports this too.
 */

/** Sentence-final punctuation, optionally followed by closing quotes/brackets. */
const TERMINATED = /[.!?…]["'”’»)\]]*$/;

/**
 * Capitalised words that start a fact without being a name. Everything else is
 * left alone because facts almost always open with a person's name, and
 * lowercasing "Marco" would be worse than a stray capital.
 */
const GENERIC_OPENERS = new Set(['There', 'People', 'Everyone', 'Someone', 'Nobody', 'Word', 'It']);

/**
 * Normalise fact content so it can sit after "…that " inside a larger sentence:
 * trimmed, trailing full stops dropped, and a generic opener lowercased.
 * A closing quote is kept as-is — `X said: "I'm leaving."` must stay balanced.
 */
export function asClause(text: string): string {
  let clause = text.trim().replace(/\s+/g, ' ');
  clause = clause.replace(/[\s.!?…]+$/, '');
  // "It's" and "There's" are the same openers with a contraction attached.
  const firstWord = clause.split(' ', 1)[0].replace(/['’][a-z]+$/i, '');
  if (GENERIC_OPENERS.has(firstWord)) {
    clause = clause.charAt(0).toLowerCase() + clause.slice(1);
  }
  return clause;
}

/** Add a full stop unless the text already ends a sentence (possibly inside a quote). */
export function endSentence(text: string): string {
  const trimmed = text.trim();
  return TERMINATED.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Whoever the feed line is about, when their own name may appear in the fact. */
export interface FactSelf {
  name: string;
  /** `agents.gender`: 'female' / 'male'; anything else reads as "they". */
  gender?: string | null;
}

const PRONOUNS: Record<string, { subject: string; object: string; possessive: string }> = {
  female: { subject: 'she', object: 'her', possessive: 'her' },
  male: { subject: 'he', object: 'him', possessive: 'his' },
};
const NEUTRAL_PRONOUNS = { subject: 'they', object: 'them', possessive: 'their' };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace `self`'s own name inside a fact clause with a pronoun, so a feed line
 * about them doesn't name them twice. Playtest G7: "Diego Santos told Marco
 * Rivera that Yuki Tanaka spotted Diego Santos at a secret meeting" read as
 * Diego gossiping about himself in the third person. Now the witness telling
 * her own sighting reads "Yuki told Marco that she spotted Diego…", and the
 * seen man overhearing it reads "Diego overheard that Yuki spotted him…".
 * At the start of the clause the name is the grammatical subject; anywhere
 * else it is an object; "Rosa Chen's" becomes the possessive.
 */
export function withSelfAsPronoun(clause: string, self: FactSelf): string {
  const name = self.name.trim();
  if (!name) return clause;
  const p = PRONOUNS[(self.gender ?? '').toLowerCase()] ?? NEUTRAL_PRONOUNS;
  const escaped = escapeRegExp(name);
  let out = clause.replace(new RegExp(`\\b${escaped}['’]s\\b`, 'g'), p.possessive);
  out = out.replace(new RegExp(`^${escaped}\\b`), p.subject);
  out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), p.object);
  return out;
}

/**
 * "<lead> that <fact>." — the one shape every gossip/drama feed line uses.
 * "that + clause" needs no grammatical agreement with the fact, unlike the old
 * "overheard something about <fact>", which only worked for noun phrases and
 * every fact is a full clause.
 *
 * `selves` are the people the lead names (the teller and listener, the
 * eavesdropper): their own names inside the fact become pronouns — see
 * withSelfAsPronoun.
 */
export function thatSentence(lead: string, factContent: string, selves: FactSelf[] = []): string {
  const trimmed = selves.reduce((text, self) => withSelfAsPronoun(text, self), factContent.trim());
  // A question can't follow "that" ("…overheard that is Marco broke"), and
  // swapping its "?" for "." would state a suspicion as fact. Quote it whole.
  if (/\?["'”’»)\]]*$/.test(trimmed)) {
    const question = trimmed.replace(/^["“]+|["”]+$/g, '').replace(/"/g, "'");
    return `${lead}: "${question}"`;
  }
  return endSentence(`${lead} that ${asClause(trimmed)}`);
}

/**
 * Cut `text` down to one feed-sized phrase: the first sentence when it fits,
 * otherwise the longest prefix that ends on a word boundary, marked with "…".
 * Never cuts mid-word — a truncated word reads as a typo, not as an ellipsis.
 */
export function shortenForFeed(text: string, max = 100): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  const firstSentence = clean.match(/^.+?[.!?…](?=\s|$)/)?.[0] ?? clean;
  if (firstSentence.length <= max) return firstSentence;
  const cut = firstSentence.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(' ');
  const head = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, max)).replace(/[\s,;:—–-]+$/, '');
  return `${head}…`;
}

/**
 * Join list items ("open the bakery", "lunch with Carlos", …) until the next one
 * would push past `max`, then count the rest ("+3 more"). Whole items only, so
 * a plan never shows half an activity; a count rather than a trailing ", …"
 * so the text can sit inside a larger sentence without a stray ellipsis.
 * A single oversized item falls back to `shortenForFeed`.
 */
export function joinForFeed(items: string[], max = 100): string {
  const parts = items.map((i) => asClause(i)).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts[0].length > max) return shortenForFeed(parts[0], max);
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const next = `${out}, ${parts[i]}`;
    if (next.length > max) return `${out}, +${parts.length - i} more`;
    out = next;
  }
  return out;
}

/**
 * Pull something quotable out of an LLM conversation line for a "confided" fact.
 *
 * Model output mixes speech with stage directions — "(My heart gives a little
 * skip…)", "*looks away*" — and used to be cut at a fixed 80 characters, which
 * turned inner narration into a sensitivity-3 secret that then spread through
 * town as a juicy discovery. Here stage directions are removed, only complete
 * sentences count, and the result is cut at a sentence boundary. Returns null
 * when nothing worth repeating is left, so the caller creates no fact at all.
 */
export function extractConfidedQuote(text: string, max = 160): string | null {
  let speech = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\*[^*]*\*/g, ' ');
  // An unclosed "(", "[" or "*" is a stage direction the model never finished
  // (or that a length cap cut off): everything after it is narration.
  speech = speech.replace(/[(*[][\s\S]*$/, ' ');
  speech = speech.replace(/\s+/g, ' ').trim();
  // Surrounding quotes would double up with the ones the fact template adds.
  speech = speech.replace(/^["“”']+|["“”']+$/g, '').replace(/"/g, "'").trim();

  // Only complete sentences: a trailing fragment without end punctuation is
  // where the model (or a token cap) stopped mid-thought.
  const sentences = speech.match(/[^.!?…]+[.!?…]+/g) ?? [];
  let quote = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    const candidate = quote ? `${quote} ${sentence}` : sentence;
    if (candidate.length > max) break;
    quote = candidate;
  }

  // Four words is the floor for a line that says something about the speaker;
  // "Oh. Well." or "Thank you!" are not secrets.
  if (quote.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length < 4) return null;
  return quote;
}
