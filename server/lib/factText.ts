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
