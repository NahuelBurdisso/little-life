/**
 * Rule-based Sentiment Analyzer
 *
 * Returns a score from -1 (very negative) to 1 (very positive).
 * Can be called from any Convex function (no I/O).
 */

const POSITIVE_WORDS = new Set([
  "happy", "great", "wonderful", "love", "enjoy", "beautiful", "kind",
  "friend", "laugh", "smile", "thank", "appreciate", "glad", "amazing",
  "fun", "excited", "delicious", "perfect", "help", "care",
]);

const NEGATIVE_WORDS = new Set([
  "hate", "angry", "upset", "terrible", "awful", "annoyed", "frustrated",
  "sad", "lonely", "sick", "tired", "argue", "fight", "rude", "boring",
  "worse", "never", "problem", "worry", "afraid", "hurt",
]);

const INTENSIFIERS = new Set([
  "very", "really", "extremely", "so", "incredibly",
]);

const NEGATORS = new Set([
  "not", "don't", "doesn't", "didn't", "won't", "never", "no",
]);

export function analyzeSentiment(text: string): number {
  // Lowercase and remove punctuation, split on whitespace
  const words = text
    .toLowerCase()
    .replace(/[^\w\s']/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return 0;

  let score = 0;
  let multiplier = 1;
  let negate = false;

  for (const word of words) {
    if (INTENSIFIERS.has(word)) {
      multiplier = 1.5;
      continue;
    }

    if (NEGATORS.has(word)) {
      negate = true;
      continue;
    }

    const isPositive = POSITIVE_WORDS.has(word);
    const isNegative = NEGATIVE_WORDS.has(word);

    if (isPositive || isNegative) {
      let wordScore = isPositive ? 1 : -1;
      wordScore *= multiplier;
      if (negate) wordScore *= -1;
      score += wordScore;

      // Reset after scoring
      multiplier = 1;
      negate = false;
    }
  }

  // Normalize to [-1, 1]
  const normalizer = Math.max(words.length * 0.1, 1);
  return Math.max(-1, Math.min(1, score / normalizer));
}
