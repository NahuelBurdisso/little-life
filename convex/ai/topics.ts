/**
 * Keyword-based Topic Extractor
 *
 * Scans message texts against keyword categories and returns matched topics.
 * Can be called from any Convex function (no I/O).
 */

const TOPIC_KEYWORDS: Record<string, string[]> = {
  work: ["work", "job", "farm", "shop", "harvest", "busy", "salary"],
  food: ["eat", "hungry", "cook", "bread", "meal", "dinner", "lunch"],
  weather: ["rain", "sun", "storm", "cold", "warm", "weather"],
  relationships: ["friend", "love", "like", "hate", "miss", "together"],
  health: ["sick", "tired", "doctor", "medicine", "sleep", "rest"],
  money: ["coin", "money", "buy", "sell", "price", "afford", "expensive"],
  town: ["town", "festival", "event", "mayor", "community"],
  feelings: ["happy", "sad", "angry", "worried", "scared", "excited"],
  plans: ["tomorrow", "going to", "want to", "plan", "hope", "wish"],
};

export function extractTopics(
  messages: Array<{ text: string }>
): string[] {
  const combined = messages
    .map((m) => m.text)
    .join(" ")
    .toLowerCase();

  const matched: string[] = [];

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const keyword of keywords) {
      if (combined.includes(keyword)) {
        matched.push(topic);
        break;
      }
    }
  }

  return matched.length > 0 ? matched : ["general"];
}
