/**
 * Closing lines for an LLM conversation the sim has to end before it ran its
 * course (see `conversationPacing.ts`), keyed by why. Said by the participant
 * who is leaving. The need-driven lines give the reason out loud, so the
 * transcript explains why they walked off; `budget` is the clock running out.
 * Not a small-talk script's close: those are on a per-pair cooldown and stay
 * on their topic, and a forced ending must always have a line.
 *
 * Variant text is the spoken line ONLY — no "{speaker.name}: " prefix. The UI
 * already labels each message with its speaker, so a prefixed line rendered as
 * "Priya Sharma: Priya Sharma: ...". `{other.name}` is interpolated by the caller.
 *
 * These were the only live part of the old per-category template catalog
 * (server/data/templates.ts), which the topic scripts (smallTalkScripts.ts)
 * replaced and which was deleted together with its write-only copy into the
 * `templates` table (B19).
 */
export const WRAP_UP_FAREWELLS: Record<'budget' | 'sleep' | 'energy' | 'hunger', Array<{ text: string; sentiment: number }>> = {
  budget: [
    { text: "Oh, look at the time. I should get going, {other.name}.", sentiment: 0.2 },
    { text: "Let's pick this up another time, {other.name}. I have to run.", sentiment: 0.2 },
    { text: "I've kept you long enough. See you around.", sentiment: 0.1 },
  ],
  sleep: [
    { text: "It's getting late. I should head to bed. Goodnight, {other.name}.", sentiment: 0.2 },
    { text: "I need to turn in for the night. Talk tomorrow?", sentiment: 0.2 },
  ],
  energy: [
    { text: "Sorry, {other.name}, I can barely keep my eyes open. I need to rest.", sentiment: 0.0 },
    { text: "I'm completely worn out. I have to go lie down.", sentiment: -0.1 },
  ],
  hunger: [
    { text: "Sorry, {other.name}, I'm starving. I have to go find something to eat.", sentiment: 0.0 },
    { text: "My stomach won't let me think. I need to eat something.", sentiment: -0.1 },
  ],
};
