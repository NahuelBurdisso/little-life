/**
 * What each resident has recently talked about — so they stop saying it.
 *
 * Playtest #3 (sickness wave, 4x): 34 of 57 LLM conversations were "offering
 * help", Yuki raised "the old stone foundation" (one of her goals) in six
 * conversations, Rosa offered "extra flour" twice. Nothing remembered what a
 * speaker had already said to someone else; every conversation started fresh
 * from the same goals and the same perception trigger.
 *
 * Two memories, both in game minutes over a rolling day:
 *  - the conversation topics each resident OPENED (PerceptionSystem scales
 *    down a reaction whose topic the observer already opened today);
 *  - the distinctive words of each resident's own lines, per conversation.
 *    A word they used in two or more conversations today is a subject they
 *    keep returning to ("foundation", "flour", "ledger"), and the dialogue
 *    prompt names it: "You've already talked about … today". Words that
 *    several residents use are the day's shared news (the flu, the festival),
 *    not a personal fixation, and are left alone.
 *
 * In memory only (like the perception cooldowns): a restart forgets a day of
 * small talk, which costs nothing. Cleared on a world replace (worldCaches).
 */

/** How far back "today" reaches, in game minutes. */
export const TOPIC_WINDOW_MINUTES = 1440;
/** Conversations a word must appear in before it counts as a repeated subject. */
const REPEAT_MIN = 2;
/** A word this many residents used in the window is shared news, not a fixation. */
const SHARED_SPEAKERS = 3;
/** Subjects named in the prompt, most repeated first. */
const MAX_SUBJECTS = 3;
const MAX_ENTRIES_PER_AGENT = 16;

interface Entry {
  conversationId: number;
  at: number;
  /** Topic label, when this resident opened the conversation. */
  opened: string | null;
  words: Set<string>;
}

const byAgent = new Map<number, Entry[]>();

/**
 * Common words of five letters or more that say nothing about a subject:
 * function words, feelings, pleasantries, times of day. Tuned on playtest #3's
 * dialogue, where these were the noise above the real repeats.
 */
const STOPWORDS = new Set(('about above after again against almost alone along already alright although always among another anyone anything anyway '
  + 'around asked asking because become before begin behind being believe below beside besides better between beyond bring brings brought '
  + 'cannot careful certain certainly chance clear close comes coming could darling dearest didn doesn doing during early earlier either enough '
  + 'especially every everyone everything exactly first found friend friends getting given gives giving goes going great happen happened '
  + 'happens hardly haven having heard heart hello herself himself hoping however indeed keeping known knows later least leave lately little '
  + 'lives looked looking looks lovely makes making matter maybe means might minds moment morning myself needs never night nothing notice '
  + 'noticed often other others ourselves perhaps place please pretty quite rather really right seems shall should since someone something '
  + 'sometimes sorry still sure taken takes taking telling thank thanks their there these thing things think thinking those though thought '
  + 'through today together tomorrow tonight truly trying under until whole whose wonder wonderful would yesterday yours yourself yourselves '
  + 'evening afternoon simply seeing called calling sound sounds across plenty feeling feels kept sweet beautiful course hands minute minutes '
  + 'hours years weeks always promise heavy troubled trouble strength company instead actually usually appreciate weighing bothering '
  + 'discussing finish promised forget energy harder count divine light quiet while where which there whatever wanted wants since small '
  + 'enjoy glad afraid worry worried happy sorry again every rest fine good kind nice dear honest honestly especially speak spoke talk talking '
  + 'said saying tell told asking wanted maybe').split(/\s+/));

function normalise(word: string): string {
  const w = word.toLowerCase();
  // Crude plural: "stones" → "stone", but not "glass" or "news".
  return w.length > 5 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** The distinctive words of a line: five letters or more, no stopwords, no excluded names. */
export function subjectWords(text: string, exclude: ReadonlySet<string> = new Set()): string[] {
  const out = new Set<string>();
  for (const raw of text.replace(/[’']s\b/g, '').match(/[A-Za-z]+/g) ?? []) {
    const w = normalise(raw);
    if (w.length < 5 || STOPWORDS.has(w) || STOPWORDS.has(raw.toLowerCase()) || exclude.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

export interface FinishedConversation {
  conversationId: number;
  /** In speaking order: participants[0] opened. */
  participants: number[];
  /** Full names of the participants, so nobody's "subject" is the person they talk to. */
  participantNames: string[];
  topic: string | null;
  messages: Array<{ speakerId: number; text: string; fallback?: boolean }>;
  gameMinute: number;
}

/** Remember what each side said in a finished conversation. */
export function recordConversationTopics(c: FinishedConversation): void {
  const exclude = new Set(c.participantNames.flatMap((n) => n.toLowerCase().match(/[a-z]+/g) ?? []).map(normalise));
  const opener = c.messages[0]?.speakerId ?? c.participants[0];
  for (const agentId of c.participants) {
    const own = c.messages.filter((m) => m.speakerId === agentId && !m.fallback);
    const words = new Set(own.flatMap((m) => subjectWords(m.text ?? '', exclude)));
    const entries = byAgent.get(agentId) ?? [];
    if (entries.some((e) => e.conversationId === c.conversationId)) continue;
    entries.push({
      conversationId: c.conversationId,
      at: c.gameMinute,
      opened: agentId === opener ? (c.topic ?? null) : null,
      words,
    });
    byAgent.set(agentId, entries.filter((e) => c.gameMinute - e.at < TOPIC_WINDOW_MINUTES).slice(-MAX_ENTRIES_PER_AGENT));
  }
}

function recent(agentId: number, now: number): Entry[] {
  return (byAgent.get(agentId) ?? []).filter((e) => now - e.at >= 0 && now - e.at < TOPIC_WINDOW_MINUTES);
}

/** How many conversations with this topic `agentId` opened in the last game day. */
export function openedTopicCount(agentId: number, topic: string, now: number): number {
  const t = topic.trim().toLowerCase();
  return recent(agentId, now).filter((e) => e.opened?.trim().toLowerCase() === t).length;
}

/**
 * Words `agentId` keeps coming back to today (two or more conversations),
 * minus the ones half the town is saying too. Most repeated first.
 */
export function repeatedSubjects(agentId: number, now: number): string[] {
  const counts = new Map<string, number>();
  for (const e of recent(agentId, now)) for (const w of e.words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n >= REPEAT_MIN);
  if (repeated.length === 0) return [];
  const speakersOf = new Map<string, number>();
  for (const [id] of byAgent) {
    const said = new Set(recent(id, now).flatMap((e) => [...e.words]));
    for (const [w] of repeated) if (said.has(w)) speakersOf.set(w, (speakersOf.get(w) ?? 0) + 1);
  }
  return repeated
    .filter(([w]) => (speakersOf.get(w) ?? 0) < SHARED_SPEAKERS)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUBJECTS)
    .map(([w]) => w);
}

export function clearTopicMemory(): void {
  byAgent.clear();
}
