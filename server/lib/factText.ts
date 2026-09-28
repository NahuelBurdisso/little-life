/**
 * Pure text helpers for turning free text — shared_knowledge content, LLM lines,
 * plan summaries — into sentences the player reads in the feed.
 *
 * Fact content comes from many authors (FACT_GENERATORS, the secrets pool, the
 * setup wizard, LLM quotes) and none of them agree on trailing punctuation, so
 * every builder that splices a fact into a sentence has to normalise it first.
 * Splicing it raw is what produced "…and it ended badly.." in the feed.
 *
 * No DB or Node imports: keep this safe to call from anywhere, tests included.
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
  const firstWord = clause.split(' ', 1)[0];
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

/**
 * "<lead> that <fact>." — the one shape every gossip/drama feed line uses.
 * "that + clause" needs no grammatical agreement with the fact, unlike the old
 * "overheard something about <fact>", which only worked for noun phrases and
 * every fact is a full clause.
 */
export function thatSentence(lead: string, factContent: string): string {
  return endSentence(`${lead} that ${asClause(factContent)}`);
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
