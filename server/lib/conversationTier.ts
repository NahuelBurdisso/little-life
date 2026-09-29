/**
 * Which kind of conversation a pair gets: a template exchange, a standard LLM
 * chat (MAX_TURNS_STANDARD) or a deep one (MAX_TURNS_DEEP) — and how early in
 * the queue it stands.
 *
 * Two layers:
 *
 * 1. The SIGNAL tier: what the pair has to talk about. This is the logic that
 *    used to be written out twice in engine/systems/decisions.ts (the socialize
 *    decision and the tavern/square encounter), kept rule for rule — including
 *    where the two producers differ (only an encounter treats open hostility as
 *    drama; only a socialize decision weighs the topic, a first meeting, gossip
 *    to share and a lonely initiator). With nothing watched and no pressure on
 *    the model the result is exactly what those two blocks produced; the table
 *    tests in __tests__/conversationTier.test.ts pin it.
 *
 * 2. The BUDGET: where the LLM goes when it can't go everywhere. With 4 slots a
 *    20–32 resident town can't give every pair a live chat; the surplus used to
 *    age out of the queue into templates in whatever order it drained, the pair
 *    on screen included. Now:
 *      - a WATCHED pair (lib/spotlight.ts: either participant on screen) jumps
 *        the queue, is never a template, and anything with real content in it
 *        (drama or a notable signal) gets the long form;
 *      - OFF-SCREEN small talk (nothing special to say) becomes a template
 *        exchange whenever the model is under pressure — requests backed up
 *        behind the slots, a town past POPULATION_THRESHOLD, or measured turns
 *        slower than SLOW_TURN_MS — and off-screen "warm" chats (friends, a
 *        lonely or low initiator) join it once the backlog is heavy;
 *      - off-screen drama and notable chats keep their tier: they make the
 *        stories the player later reads about in the feed and the Journal.
 *    Player nudges and milestone proposals are never downgraded (they are
 *    requests, not budget decisions), and a comfort visit never drops below a
 *    standard chat — the walk across town was the whole point.
 *
 * Pure: every input arrives in the context, so the simulation in
 * scripts/spotlight-sim.ts can replay a day of choices without a database.
 */
import { CONFIG } from './constants';

export type ConversationTier = 'template' | 'llm_standard' | 'llm_deep';

/**
 * Why the signal layer picked its tier, most to least interesting. `small_talk`
 * is the bottom branch (acquaintances with nothing special to say), `warm` the
 * branch above it (friends, a crush, a low or lonely initiator).
 */
export type TierSignal = 'dramatic' | 'notable' | 'warm' | 'small_talk';

/** States that make any exchange between the pair dramatic. */
export const DRAMATIC_STATES: readonly string[] = [
  'jealous', 'heartbroken', 'angry', 'alcoholic', 'in_debt', 'depressed', 'drunk', 'infatuated',
];

/** Topic fragments (substring match) that make a socialize decision dramatic. */
export const DRAMATIC_TOPICS: readonly string[] = ['gossip', 'flirting', 'confrontation', 'venting', 'seeking comfort'];

export function hasDramaticState(...stateLists: ReadonlyArray<readonly string[]>): boolean {
  return stateLists.some((states) => states.some((s) => DRAMATIC_STATES.includes(s)));
}

export function isDramaticTopic(topic: string | null | undefined): boolean {
  return topic ? DRAMATIC_TOPICS.some((t) => topic.includes(t)) : false;
}

export const TIER_BUDGET = {
  /**
   * Residents above which off-screen small talk is always a template. The
   * default cast is ~13 and never crosses it; a 20+ town produces more
   * socialize intents per game hour than 4 slots can voice.
   */
  POPULATION_THRESHOLD: 20,
  /**
   * WALL-CLOCK MS. A measured median turn this slow means the model is
   * struggling (Gemma 4 26B measures ~1.3–1.8 s p50 with 4 slots): spare it the
   * small talk even before a backlog shows.
   */
  SLOW_TURN_MS: 5_000,
  /**
   * Backlog (see `conversationBacklog`) at which off-screen warm chats are
   * templated too: a full pool's worth of requests already waiting.
   */
  HEAVY_BACKLOG: 4,
  /**
   * Added to a watched entry's queue priority. Socialize priorities run 0–120
   * and encounters sit at 50, so this lifts a watched chat over every ordinary
   * one without reaching the protected band (see `watchedPriority`).
   */
  WATCHED_PRIORITY_BOOST: 60,
} as const;

export interface TierContext {
  /**
   * Which producer is asking. 'social': an agent decided to talk to someone
   * (decisions.ts socialize). 'encounter': two people idling at a tavern,
   * square or park. They read slightly different signals — see the header.
   */
  source: 'social' | 'encounter';
  friendship: number;
  romance: number;
  /** The initiator's mood (0–100). */
  mood: number;
  /** The initiator's social need (0–100); only a socialize decision weighs it. */
  social?: number;
  /** Either participant is in a DRAMATIC_STATES state. */
  dramaticState: boolean;
  /** The chosen topic; only a socialize decision has one when the tier is picked. */
  topic?: string | null;
  /** No relationship row yet, or familiarity < 5 (socialize only). */
  firstMeeting?: boolean;
  /** The initiator has a shareable fact about someone (socialize only). */
  hasGossip?: boolean;
  /** A comfort visit (lonelinessEngine): never below a standard chat. */
  comfortVisit?: boolean;
  /**
   * A request rather than a budget decision: a player nudge or a milestone
   * proposal. `requestedTier` is returned untouched.
   */
  request?: 'nudge' | 'milestone';
  requestedTier?: ConversationTier;
  /** Either participant is in the spotlight (lib/spotlight.ts). */
  watched: boolean;
  /** Requests waiting on the model (see `conversationBacklog`). */
  backlog: number;
  /** Living residents. */
  population: number;
  /** Median measured conversation turn (conversationPacing.ts), or null. */
  latencyMs: number | null;
  /** Queue priority the producer computed; the choice may raise it. */
  basePriority: number;
  /** CONFIG.CONVERSATIONS.SMALL_TALK_TIER; injectable so tests pin both settings. */
  smallTalkTier?: 'llm_standard' | 'template';
}

export interface TierChoice {
  tier: ConversationTier;
  priority: number;
  /** What the pair had to say (signal layer), for diagnostics and the simulation. */
  signal: TierSignal;
  /** The budget layer changed the signal tier. */
  budget: 'none' | 'watched' | 'offscreen_downgrade';
}

/** The signal layer alone: the tier decisions.ts used to compute inline. */
export function signalTier(ctx: TierContext): { tier: ConversationTier; signal: TierSignal } {
  const smallTalk = ctx.smallTalkTier ?? CONFIG.CONVERSATIONS.SMALL_TALK_TIER;
  const { friendship, romance, mood } = ctx;
  const emotionalExtreme = mood < 25 || mood > 85;

  let result: { tier: ConversationTier; signal: TierSignal };
  if (ctx.source === 'social') {
    if (ctx.dramaticState || isDramaticTopic(ctx.topic) || ctx.firstMeeting) {
      result = { tier: 'llm_deep', signal: 'dramatic' }; // dramatic moments
    } else if (romance > 30 || emotionalExtreme || ctx.hasGossip) {
      result = { tier: 'llm_standard', signal: 'notable' }; // notable situations
    } else if (friendship > 40 || romance > 10 || mood < 40 || (ctx.social ?? 100) < 30) {
      result = { tier: 'llm_standard', signal: 'warm' }; // friends talking, lonely/sad agents
    } else {
      result = { tier: smallTalk, signal: 'small_talk' }; // acquaintances with nothing special to say
    }
  } else {
    if (ctx.dramaticState || friendship < -20) {
      result = { tier: 'llm_deep', signal: 'dramatic' };
    } else if (romance > 30 || emotionalExtreme) {
      result = { tier: 'llm_standard', signal: 'notable' };
    } else if (friendship > 40 || romance > 10 || mood < 40) {
      result = { tier: 'llm_standard', signal: 'warm' };
    } else {
      result = { tier: smallTalk, signal: 'small_talk' };
    }
  }
  // A comfort visit is the whole point of the walk over — never let it
  // collapse into a one-line template exchange.
  if (ctx.comfortVisit && result.tier === 'template') result = { ...result, tier: 'llm_standard' };
  return result;
}

/**
 * The model is under pressure: requests are queued behind the slots, the town
 * is bigger than 4 slots can voice, or measured turns are slow.
 */
export function underPressure(ctx: Pick<TierContext, 'backlog' | 'population' | 'latencyMs'>): boolean {
  return ctx.backlog > 0
    || ctx.population > TIER_BUDGET.POPULATION_THRESHOLD
    || (ctx.latencyMs != null && ctx.latencyMs >= TIER_BUDGET.SLOW_TURN_MS);
}

/**
 * A watched entry's priority: boosted, but kept below the protected band
 * (PLAYER_NUDGE_PRIORITY - 10 and up, conversations.ts `isProtectedEntry`) —
 * entering it would change how the scheduler treats the entry (needs can't cut
 * it, it waits out a busy partner), which is the player's privilege, not the
 * camera's.
 */
export function watchedPriority(basePriority: number): number {
  const ceiling = CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 11;
  return Math.min(ceiling, Math.max(basePriority, basePriority + TIER_BUDGET.WATCHED_PRIORITY_BOOST));
}

export function chooseTier(ctx: TierContext): TierChoice {
  const { tier, signal } = signalTier(ctx);

  if (ctx.request) {
    return { tier: ctx.requestedTier ?? tier, priority: ctx.basePriority, signal, budget: 'none' };
  }

  if (ctx.watched) {
    // On screen: never a canned line, and anything with content in it gets the
    // long form — the player is reading this one.
    const watchedTier: ConversationTier =
      signal === 'dramatic' || signal === 'notable' ? 'llm_deep' : tier === 'template' ? 'llm_standard' : tier;
    return {
      tier: watchedTier,
      priority: watchedPriority(ctx.basePriority),
      signal,
      budget: 'watched',
    };
  }

  if (tier !== 'template' && !ctx.comfortVisit) {
    const downgrade =
      (signal === 'small_talk' && underPressure(ctx))
      || (signal === 'warm' && ctx.backlog >= TIER_BUDGET.HEAVY_BACKLOG);
    if (downgrade) {
      return { tier: 'template', priority: ctx.basePriority, signal, budget: 'offscreen_downgrade' };
    }
  }
  return { tier, priority: ctx.basePriority, signal, budget: 'none' };
}

/**
 * How many requests are waiting on the model, as the tier choice sees it: the
 * chat semaphore's waiters (llmSemaphore `getLLMBacklog`) plus, once every LLM
 * conversation slot is taken, the LLM-tier entries already queued — each of
 * those will wait for a slot and age out into a template if none frees in time.
 * Queued entries are not counted while slots are free: most of them are pairs
 * still walking over (staging), not a backlog.
 */
export function conversationBacklog(p: {
  semaphoreWaiting: number;
  activeLLMConversations: number;
  maxConcurrentLLM: number;
  queuedLLMEntries: number;
}): number {
  const slotsFull = p.activeLLMConversations >= p.maxConcurrentLLM;
  return p.semaphoreWaiting + (slotsFull ? p.queuedLLMEntries : 0);
}
