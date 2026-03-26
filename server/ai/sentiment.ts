/**
 * Rule-based Sentiment Analyzer
 *
 * Returns a score from -1 (very negative) to 1 (very positive).
 * Uses expanded vocabulary, emoji detection, punctuation cues,
 * and context patterns for more accurate scoring.
 */

const POSITIVE_WORDS = new Set([
  // Emotions
  "happy", "glad", "delighted", "thrilled", "excited", "overjoyed", "ecstatic",
  "grateful", "thankful", "blessed", "content", "satisfied", "pleased",
  "cheerful", "joyful", "elated",
  // Social
  "love", "adore", "cherish", "appreciate", "admire", "respect", "trust",
  "friend", "buddy", "pal", "companion", "darling", "sweetheart", "dear",
  // Actions
  "laugh", "smile", "grin", "chuckle", "giggle", "hug", "embrace",
  "celebrate", "enjoy", "relish", "savor",
  // Qualities
  "wonderful", "amazing", "fantastic", "incredible", "brilliant", "excellent",
  "perfect", "beautiful", "gorgeous", "lovely", "magnificent", "superb",
  "great", "good", "nice", "fine", "cool", "awesome", "sweet",
  // Help/care
  "help", "care", "support", "comfort", "encourage", "inspire",
  "kind", "gentle", "warm", "generous", "thoughtful", "considerate",
  // Agreement
  "yes", "absolutely", "definitely", "certainly", "exactly", "agreed",
  // Food/drink positive
  "delicious", "tasty", "yummy", "refreshing",
  // Relief
  "relief", "relieved", "safe", "peaceful", "calm", "relaxed",
  // Compliments
  "talented", "smart", "clever", "brave", "strong", "beautiful",
]);

const NEGATIVE_WORDS = new Set([
  // Emotions
  "hate", "despise", "loathe", "detest", "angry", "furious", "enraged",
  "upset", "frustrated", "annoyed", "irritated", "agitated", "bitter",
  "sad", "miserable", "depressed", "gloomy", "heartbroken", "devastated",
  "lonely", "isolated", "abandoned", "rejected", "betrayed",
  "scared", "afraid", "terrified", "anxious", "worried", "nervous",
  "jealous", "envious", "resentful", "suspicious", "distrustful",
  "guilty", "ashamed", "embarrassed", "humiliated", "pathetic",
  // Actions
  "argue", "fight", "yell", "scream", "shout", "slam", "punch", "hit",
  "steal", "cheat", "lie", "betray", "manipulate", "exploit", "deceive",
  "cry", "weep", "sob", "groan", "sigh", "grumble", "complain",
  "ignore", "avoid", "reject", "abandon", "dismiss",
  // Qualities
  "terrible", "awful", "horrible", "dreadful", "disgusting", "revolting",
  "ugly", "hideous", "pathetic", "worthless", "useless", "stupid",
  "rude", "mean", "cruel", "vicious", "nasty", "hostile", "toxic",
  "boring", "dull", "tedious", "exhausting", "draining",
  // Situations
  "problem", "trouble", "disaster", "crisis", "mess", "chaos",
  "pain", "suffering", "agony", "torment",
  "worse", "worst", "terrible", "unbearable",
  "sick", "ill", "nauseous",
  // Conflict
  "fault", "blame", "accuse", "confront", "threaten", "warn",
  "grudge", "revenge", "spite",
]);

const STRONG_POSITIVE = new Set([
  "love", "adore", "incredible", "amazing", "wonderful", "ecstatic",
  "thrilled", "overjoyed", "magnificent", "brilliant", "fantastic",
]);

const STRONG_NEGATIVE = new Set([
  "hate", "despise", "furious", "enraged", "devastated", "terrified",
  "betray", "disgusting", "revolting", "horrible", "unbearable",
]);

const INTENSIFIERS = new Set([
  "very", "really", "extremely", "so", "incredibly", "absolutely",
  "totally", "completely", "utterly", "deeply", "truly", "genuinely",
]);

const NEGATORS = new Set([
  "not", "don't", "doesn't", "didn't", "won't", "never", "no",
  "can't", "couldn't", "shouldn't", "wouldn't", "barely", "hardly",
]);

export function analyzeSentiment(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s'*]/g, "")
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
      // Strong words have more impact
      let wordScore = isPositive ? 1 : -1;
      if (STRONG_POSITIVE.has(word)) wordScore = 2;
      if (STRONG_NEGATIVE.has(word)) wordScore = -2;

      wordScore *= multiplier;
      if (negate) wordScore *= -0.7; // negation doesn't fully flip

      score += wordScore;
      multiplier = 1;
      negate = false;
    } else {
      // Reset negation after 2 non-sentiment words
      if (negate) {
        negate = false;
      }
    }
  }

  // Punctuation cues from original text
  if (text.includes('!')) score += 0.3 * Math.sign(score || 1);
  if (text.includes('...')) score -= 0.2; // ellipsis often indicates hesitation/negativity
  if (text.includes('?!') || text.includes('!!')) score += 0.3 * Math.sign(score || 1);

  // Emoji-like patterns (agents use action text like *laughs*, *sighs*)
  const lowerText = text.toLowerCase();
  if (lowerText.includes('*laugh') || lowerText.includes('*smile') || lowerText.includes('*grin') || lowerText.includes('*chuckle')) score += 1;
  if (lowerText.includes('*sigh') || lowerText.includes('*frown') || lowerText.includes('*groan')) score -= 0.5;
  if (lowerText.includes('*cry') || lowerText.includes('*sob') || lowerText.includes('*scowl')) score -= 1;
  if (lowerText.includes('*hug') || lowerText.includes('*kiss') || lowerText.includes('*wink')) score += 1.5;
  if (lowerText.includes('*glare') || lowerText.includes('*sneer') || lowerText.includes('*scoff')) score -= 1;

  // Normalize: use sqrt scaling instead of linear division
  // This preserves signal in long messages while preventing extreme scores
  const normalizer = Math.sqrt(Math.max(words.length, 1)) * 0.8;
  return Math.max(-1, Math.min(1, score / normalizer));
}
