/**
 * Prompt Builders for Agent Conversations
 *
 * Constructs system prompts and conversation prompts for LLM calls.
 * Pure apart from two reads the intimacy layer needs: the `adultContent` rule
 * (once per build, for the maturity line) and the speaker's private history with
 * the listener (ai/intimacyContext.ts). Neither writes anything.
 */

import { PersonalityProfile } from '../lib/personality';
import { generateVoiceDirective } from './voiceDirective';
import { selectConversationContext, ContextItem } from './contextSelector';
import { BANNED_OPENERS, isFallbackMessage } from './sanitizeDialogue';
import { addressName, firstName } from './names';
import { TOWN_SETTING } from './setting';
import { maturityDirective } from './contentRating';
import { intimacyLinesFor } from './intimacyContext';
import { isAdultContent } from '../lib/worldRules';
import { isAdultAge } from '../lib/intimacy/eligibility';

/**
 * Conversation topic of a marriage proposal (queued by lib/milestonesEngine.ts,
 * which also reads the answer back). Shared so the queue, the prompt and the
 * outcome agree on one label.
 */
export const PROPOSAL_TOPIC = 'proposal';

/**
 * Conversation topic of a lover's invitation to spend the evening somewhere
 * private (queued by lib/intimacy/rendezvous.ts, adult layer only, which also
 * reads the answer back). Like a proposal it has a real answer, so it is
 * exempted from the "be flirty" push below: the listener has to be free to say
 * no. The wording stays discreet on purpose: an invitation, never a scene.
 */
export const RENDEZVOUS_TOPIC = 'a private evening';

/**
 * Topic of the conversation lib/intimacy/suspicion.ts queues when a husband, wife
 * or partner has noticed one night too many of an empty bed: they open it, facing
 * the one who was away. Its own label so the opener gets an intent written for
 * that scene (`topicIntent`); the outcome is read from the conversation's tone.
 */
export const SUSPICION_TOPIC = 'where you were last night';

/**
 * Topics only the sim may queue, each with the one `conversation_queue.trigger_reason` that
 * may carry it (lib/intimacy/rendezvous.ts, suspicion.ts). They are plain phrases, so a
 * player can type one into `suggest_talk`, and the prompt keys its special scene on the
 * topic text alone: a typed "a private evening" between a minor and an adult would get
 * the invitation scene (the age gate lives in the rendezvous pass, not in the prompt).
 * The nudge router rejects them and the conversation scheduler drops them from any queue
 * entry that did not come from its own producer (`queuedTopic`), so the scene can only
 * ever be one the eligibility-gated pass asked for.
 */
export const SIM_ONLY_TOPICS: Readonly<Record<string, string>> = {
  [RENDEZVOUS_TOPIC]: 'rendezvous',
  [SUSPICION_TOPIC]: 'suspicion',
};

/** Whether a (player-typed or otherwise) topic reads as one of the sim-only topics, ignoring case and spacing. */
export function isSimOnlyTopic(topic: string | null | undefined): boolean {
  const t = (topic ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return Object.keys(SIM_ONLY_TOPICS).some((k) => k.toLowerCase() === t);
}

/**
 * The topic a queue entry's conversation is held on: the entry's own, except that a
 * sim-only topic survives only on the trigger reason of the producer that owns it.
 * Anything else (a player's nudge, autoplay, a future path) talks with no set topic.
 */
export function queuedTopic(entry: { topic: string | null; trigger_reason: string }): string | null {
  if (!isSimOnlyTopic(entry.topic)) return entry.topic;
  return SIM_ONLY_TOPICS[entry.topic ?? ''] === entry.trigger_reason ? entry.topic : null;
}

/**
 * Topic of the conversation lib/family.ts queues when a husband learns the
 * baby may be another man's: he opens it, facing the man. Its own label so
 * the opener gets an intent written for that scene (`topicIntent`), not the
 * generic "something they did has been eating at you".
 */
export const PATERNITY_TOPIC = "the baby's real father";

/** Topic a friend brings to new parents (engine/systems/decisions.ts). */
export function congratsTopic(childName: string): string {
  return `congratulations on baby ${childName}`;
}

// ---------------------------------------------------------------------------
// Row types (matching server/db/schema.ts column names)
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: number;
  name: string;
  bio: string;
  self_description?: string | null;
  traits: string[];
  age: number;
  gender: string;
  /** `agents.orientation`; missing reads as straight (ai/intimacyContext.ts). */
  orientation?: string | null;
  personality: {
    honesty: number;
    aggression: number;
    warmth: number;
    impulsiveness: number;
    vanity: number;
    curiosity: number;
    loyalty: number;
    morality: number;
    sensuality: number;
    neuroticism: number;
  } | null;
}

export interface NeedsRow {
  mood: number;
  energy: number;
  hunger: number;
  social: number;
}

export interface EconomyRow {
  job: string;
  job_title: string;
  money: number;
}

export interface RelationshipRow {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  romance_ab: number;
  romance_ba: number;
  trust_ab: number;
  trust_ba: number;
  familiarity: number;
  interaction_count: number;
  tags: string[];
}

export interface ConversationRow {
  id: number;
  messages: Array<Record<string, any>>;
  trigger_reason: string;
  topic: string | null;
  sentiment: number;
  max_turns?: number;
}

export interface MemoryRow {
  id: number;
  description: string;
  importance: number;
  created_at: number;
  emotional_valence: number;
  metadata: Record<string, unknown>;
}

export interface WorldStateRow {
  time: {
    day: number;
    hour: number;
    minute: number;
    totalTicks: number;
    season: string;
  };
  weather: string;
}

export interface LocationRow {
  id: number;
  name: string;
  description: string;
}

export interface AgentEnrichment {
  reputationLabel: string;
  reputationScore: number;
  hobbies: Array<{ hobby: string; level: number }>;
  moodMomentum: number;
  drinkCount: number;
  /**
   * One line about the speaker's children and any baby on the way
   * (lib/familyState.ts `familyPromptLine`); '' or absent for everyone else.
   */
  family?: string;
  /** "Facts about you (keep them straight): …" — helpers/selfFactsStore.ts. */
  selfFacts?: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function describeFinancialStatus(money: number): string {
  if (money < 10) return 'desperate';
  if (money < 25) return 'struggling';
  if (money < 50) return 'getting by';
  return 'comfortable';
}

function formatTimeOfDay(hour: number): string {
  if (hour >= 5 && hour < 7) return 'Dawn';
  if (hour >= 7 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour <= 20) return 'Evening';
  return 'Night';
}

function buildTraitsLine(traits: string[]): string {
  if (traits.length === 0) return '';
  if (traits.length === 1) return `People describe you as ${traits[0]}.`;
  if (traits.length === 2) return `People describe you as ${traits[0]} and ${traits[1]}.`;
  const last = traits[traits.length - 1];
  const rest = traits.slice(0, -1);
  return `People describe you as ${rest.join(', ')}, and ${last}.`;
}

function buildMoodLine(mood: number): string {
  if (mood < 15) return "You're miserable right now.";
  if (mood < 35) return "You're in a bad mood.";
  if (mood > 90) return "You're in a great mood.";
  if (mood > 75) return "You're in a good mood.";
  return '';
}

function buildCriticalNeedsLine(needs: NeedsRow, money: number): string {
  const parts: string[] = [];
  if (needs.hunger < 15) parts.push('starving');
  if (needs.energy < 15) parts.push('exhausted');
  if (needs.social < 15) parts.push('desperately lonely');

  const moneyWarning = money < 10 ? `You have $${Math.round(money)}.` : '';

  if (parts.length === 0 && !moneyWarning) return '';

  let line = '';
  if (parts.length === 1) {
    line = `You're ${parts[0]}.`;
  } else if (parts.length === 2) {
    line = `You're ${parts[0]} and ${parts[1]}.`;
  } else if (parts.length > 2) {
    const last = parts[parts.length - 1];
    const rest = parts.slice(0, -1);
    line = `You're ${rest.join(', ')}, and ${last}.`;
  }

  return [line, moneyWarning].filter(Boolean).join(' ');
}

function buildSettingLine(world: WorldStateRow, locationName: string): string {
  const timeOfDay = formatTimeOfDay(world.time.hour);
  const season = world.time.season.charAt(0).toUpperCase() + world.time.season.slice(1);
  return `${timeOfDay}, day ${world.time.day}. ${season}, ${world.weather}. At ${locationName}.`;
}

/**
 * How the two stand on a first real conversation. `by-sight`: townsfolk who
 * have never really talked but know each other by sight and reputation — in a
 * town this small that is everyone. `speaker-new` / `listener-new`: one of them
 * arrived recently (lib/newcomers.ts), the only case where anyone introduces
 * themselves. Null once they have properly talked.
 */
export type FirstMeeting = 'by-sight' | 'speaker-new' | 'listener-new' | null;

export type RomanceLevel = 'none' | 'spark' | 'courting' | 'in love' | 'partners' | 'engaged' | 'married';

/** The speaker's romantic standing with the listener: their own feeling, or the couple's tags. */
export function romanceLevel(romance: number, tags: readonly string[]): RomanceLevel {
  if (tags.includes('married')) return 'married';
  if (tags.includes('engaged')) return 'engaged';
  if (tags.includes('partner')) return 'partners';
  if (romance > 60) return 'in love';
  if (romance > 35) return 'courting';
  if (romance > 15) return 'spark';
  return 'none';
}

const NO_PET_NAMES = 'no pet names like "my love", "my dear" or "darling"';

function buildRomanceLine(level: RomanceLevel, otherName: string, romanticScene: boolean): string {
  switch (level) {
    // Couples: the tag line already says so, and endearments are theirs.
    case 'married': case 'engaged': case 'partners': return '';
    case 'in love': return `You're in love with ${otherName}, but you're not a couple — ${NO_PET_NAMES}.`;
    case 'courting': return `You're sweet on ${otherName}, nothing declared — ${NO_PET_NAMES}.`;
    case 'spark': return `A spark of attraction to ${otherName}, nothing more — ${NO_PET_NAMES}.`;
    default: return romanticScene ? `No romance on your side — ${NO_PET_NAMES}.` : '';
  }
}

function buildRelationshipTag(
  relationship: RelationshipRow | null,
  speakerId: number,
  otherName: string,
  meeting: FirstMeeting = null,
  /** A flirt topic or feelings from the other side: worth saying there are none here. */
  romanticScene = false,
  /** What the pair has shared and what it would cost (ai/intimacyContext.ts): already capped at two lines. */
  intimacy: readonly string[] = [],
): string {
  if (!relationship) {
    return meeting === 'speaker-new' || meeting === 'listener-new'
      ? `You've never met ${otherName}.`
      : `You know ${otherName} only by sight and reputation.`;
  }

  const isA = relationship.agent_a === speakerId;
  const friendship = isA ? relationship.friendship_ab : relationship.friendship_ba;
  const romance = isA ? relationship.romance_ab : relationship.romance_ba;
  const trust = isA ? relationship.trust_ab : relationship.trust_ba;

  const parts: string[] = [];

  // Friendship tier
  if (friendship > 70) {
    parts.push(`You're close with ${otherName}. You'd do anything for them.`);
  } else if (friendship > 40) {
    parts.push(`You like ${otherName}.`);
  } else if (friendship >= 0) {
    parts.push(`You know ${otherName}. No strong feelings.`);
  } else if (friendship > -30) {
    parts.push(`You don't like ${otherName}. They annoy you.`);
  } else if (friendship > -60) {
    parts.push(`You can't stand ${otherName}. You don't hide your contempt.`);
  } else {
    parts.push(`You hate ${otherName}. Seeing them makes your blood boil.`);
  }

  // Structural tags
  const tagMap: Record<string, string> = {
    coworkers: 'You work together.',
    housemate: 'You live together.',
    roommate: 'You live together.',
    crush: 'You have a crush on them.',
    grudge: 'You hold a grudge against them.',
    drinking_buddy: 'You drink together.',
    antagonist: "They're your antagonist.",
    partner: "You're together.",
    // Life milestones (lib/milestonesEngine.ts, lib/marriage.ts).
    engaged: "You're engaged to be married.",
    married: "You're married to them.",
  };
  // A set: `housemate` and `roommate` both mapped to "You live together." and
  // playtest #3 prompts said it twice.
  for (const mapped of new Set(relationship.tags.map((t) => tagMap[t]).filter(Boolean))) {
    parts.push(mapped);
  }

  // Romance, as a level the model can't overshoot. Playtest #3: Rosa and Yuki
  // called each other "my love" and "my dear" while Yuki's romance was 26.6
  // and they weren't a couple — "You have deep feelings for Yuki" read as
  // licence. Pet names belong to couples; below that the line says so.
  const romanceLine = buildRomanceLine(romanceLevel(romance, relationship.tags), otherName, romanticScene);
  if (romanceLine) parts.push(romanceLine);
  parts.push(...intimacy);

  // Trust
  if (trust > 50) {
    parts.push(`You trust ${otherName} deeply.`);
  } else if (trust < -50) {
    parts.push(`You deeply distrust ${otherName}. Watch what you say.`);
  } else if (trust < -30) {
    parts.push(`You're wary of ${otherName}.`);
  }

  // Asymmetric awareness: hint at other's feelings toward you
  const otherFriendship = isA ? relationship.friendship_ba : relationship.friendship_ab;
  const otherRomance = isA ? relationship.romance_ba : relationship.romance_ab;
  if (otherFriendship > 60 && friendship < 30) {
    parts.push(`${otherName} seems to like you more than you like them.`);
  } else if (otherFriendship < -30 && friendship > 0) {
    parts.push(`You sense ${otherName} doesn't like you much.`);
  }
  if (otherRomance > 40 && romance < 15) {
    parts.push(`You think ${otherName} might have feelings for you.`);
  }

  // Interaction history
  if (relationship.interaction_count > 20) {
    parts.push(`You've talked many times before.`);
  } else if (relationship.interaction_count === 0) {
    parts.push(`You've never really talked.`);
  }

  return parts.join(' ');
}

/**
 * What the speaker wants from this conversation, in words the model can act
 * on. `topic` is a mode label from the scheduler ("catching up", "celebrating",
 * "offering comfort"…), and the prompt used to say "You want to discuss
 * catching up with Yuki" — which the model repeated back literally ("I was
 * thinking about our talk regarding catching up"). Unknown topics (drama
 * strings, "gossip about X", a player's nudge) are passed through as a subject.
 */
export function topicIntent(topic: string, other: string): string {
  const t = topic.trim().toLowerCase();
  const gossip = topic.trim().match(/^gossip about (.+)$/i);
  if (gossip) return `You heard something about ${gossip[1]} and can't keep it to yourself.`;
  const congrats = topic.trim().match(/^congratulations on baby (.+)$/i);
  if (congrats) return `${other} just had a baby, little ${congrats[1]}. Congratulate them warmly and ask after the child.`;
  if (t.startsWith('checking on')) return `You want to see how ${other} is really doing — ask about the specific thing you know is going on with them, not a general "how are you".`;
  const intents: Record<string, string> = {
    'flirting': `You're drawn to ${other}. Flirt a little: tease, compliment something specific, or hint at how you feel.`,
    'romance': `You're drawn to ${other}. Let it show.`,
    'confrontation': `Something ${other} did has been eating at you. Call it out.`,
    'tension': `Things are tense between you and ${other}, and it shows.`,
    'venting worries': `Something is worrying you and you need to get it off your chest.`,
    'seeking comfort': `You're having a rough time and want some sympathy.`,
    'celebrating': `You're in great spirits — share the good thing that happened to you.`,
    'reminiscing': `Bring up a specific moment you and ${other} shared.`,
    'sharing secrets': `You want to confide something personal to ${other} that you haven't told others.`,
    'making plans': `Propose a concrete plan with ${other}: what, where and when.`,
    'deep conversation': `Ask ${other} something that really matters — about their life, fears or hopes.`,
    'town news': `Share a piece of town news you know.`,
    'local rumors': `Share a rumor you've heard around town.`,
    'asking questions': `You're curious about ${other}'s life or work — ask something specific.`,
    'checking in': `You want to see how ${other} is really doing — ask about the specific thing you know is going on with them, not a general "how are you".`,
    'offering help': `You think ${other} could use a hand — offer something concrete.`,
    'offering comfort': `You sense ${other} is having a hard time and want to comfort them.`,
    'complimenting': `Compliment ${other} on something specific.`,
    'bragging': `Brag a little about something you did or have.`,
    'seeking validation': `You want ${other} to tell you that you did the right thing about something.`,
    'comparing lives': `Compare your life with ${other}'s — a little competitive.`,
    'community values': `Something happening in town strikes you as right or wrong — say what you think.`,
    'right and wrong': `Something happening in town strikes you as right or wrong — say what you think.`,
    'spontaneous idea': `You just had a spontaneous idea and want ${other} in on it.`,
    'wild story': `Tell ${other} a wild story, true or a bit exaggerated.`,
    'dare': `Dare ${other} to do something.`,
    // "Ask what's new" produced exactly the "what's new with you?" opener the
    // opener rule bans (G6); name the thing instead.
    'catching up': `Ask about one specific thing going on in ${other}'s life, and share a bit of your own news.`,
    'inside joke': `Bring up a joke only the two of you would get.`,
    'friendly greeting': `Say hello to ${other} in a word or two, then the one thing on your mind — something that happened, a person, a plan.`,
    'casual greeting': `Say hello to ${other} in a word or two, then the one thing on your mind — something that happened, a person, a plan.`,
    // Queued by lib/milestonesEngine.ts. The proposer always opens; the answer
    // comes from the turn instruction below (PROPOSAL_TOPIC).
    [PROPOSAL_TOPIC]: `You've made up your mind: ask ${other} to marry you, today. Do it your own way, in the manner of the time, and ask the question plainly.`,
    // Queued by lib/intimacy/rendezvous.ts (adult layer). The lover who feels more opens;
    // the answer comes from the turn instruction below (RENDEZVOUS_TOPIC).
    [RENDEZVOUS_TOPIC]: `You would like to spend the evening with ${other} somewhere private, just the two of you. Ask them, warmly and discreetly, in the manner of the time — ${other} may accept or decline.`,
    // Queued by lib/intimacy/suspicion.ts; the suspicious partner opens.
    [SUSPICION_TOPIC]: `You have noticed ${other} away from home at night, more than once, and you want to know where they were last night. Ask them plainly, and listen to whether the answer rings true.`,
    // Queued by lib/family.ts; the husband opens.
    [PATERNITY_TOPIC]: `You've just learned your wife's baby may be ${other}'s, not yours. Face ${other} with it — demand the truth.`,
  };
  if (intents[t]) return intents[t];
  const smallTalk = ['weather', 'daily life', 'food', 'work', 'weekend plans', 'memories', 'the farm'];
  if (smallTalk.includes(t)) return `Make small talk about ${t}, with one specific detail from your day.`;
  return `You want to talk about ${topic} — bring it up naturally, as if it's been on your mind.`;
}

/**
 * Whether a conversation topic gives the opener something to say beyond hello.
 * Greetings and an absent topic don't: for those a plain "Good to see you,
 * Yuki!" is the conversation, and regenerating it would only spend a slot.
 */
export function hasConcreteTopic(topic: string | null | undefined): boolean {
  const t = (topic ?? '').trim().toLowerCase();
  return t !== '' && t !== 'friendly greeting' && t !== 'casual greeting';
}

function buildTurnInstruction(
  messageCount: number,
  maxTurns: number,
  otherName: string,
  topic: string | null,
  friendship: number,
  meeting: FirstMeeting,
  romance?: number,
  lastMessageSentiment?: number,
  goalContext?: string | null,
): string {
  const parts: string[] = [];

  if (topic === PROPOSAL_TOPIC && messageCount > 0) {
    // The proposal: whoever did not open is the one being asked. Their answer
    // (the second line) is what lib/milestonesEngine.ts reads, so it has to be
    // a clear yes or no, and the model has to feel free to say no — a romance
    // that has soured, low trust or cold feet should show.
    if (messageCount === 1) {
      parts.push(`${otherName} has just asked you to marry them. Answer now, in your own words: say yes or no plainly, as your heart, your trust in them and your situation truly say.`);
    } else if (messageCount >= maxTurns - 2) {
      parts.push(`The question has been asked and answered. Close the moment the way you would.`);
    } else {
      parts.push(`Respond to ${otherName} about the proposal and its answer — stay in the moment, don't change the subject.`);
    }
  } else if (topic === RENDEZVOUS_TOPIC && messageCount > 0) {
    // The invitation: whoever did not open is the one being asked, and the answer
    // (read back by lib/intimacy/rendezvous.ts) is free to be no. Nothing is
    // narrated past the door: the reply is only yes, no or something in between.
    if (messageCount === 1) {
      parts.push(`${otherName} has just asked you to spend the evening with them somewhere private. Answer in your own words, discreetly: accept or decline plainly, as your heart, your trust in them, your conscience and your situation truly say. You are free to say no.`);
    } else if (messageCount >= maxTurns - 2) {
      parts.push(`The invitation has been made and answered. Close the moment the way you would.`);
    } else {
      parts.push(`Respond to ${otherName} about the invitation and its answer — stay in the moment, don't change the subject.`);
    }
  } else if (messageCount === 0) {
    // Opening turn
    const introducing = meeting === 'speaker-new' || meeting === 'listener-new';
    if (meeting === 'listener-new') {
      parts.push(`${otherName} is new in town and you've never met. Introduce yourself and welcome them, in your own way.`);
    } else if (meeting === 'speaker-new') {
      parts.push(`You're new in town and have never met ${otherName}. Introduce yourself.`);
    } else if (meeting === 'by-sight') {
      // Playtest #3: "Introduce yourself… You haven't really talked before"
      // on pairs who had lived in the same dozen houses for years gave "Well,
      // I am Thomas Park, the Mayor" and "I am Yuki Tanaka, though I think you
      // knew that already". They know each other; they just haven't talked.
      parts.push(friendship >= 0
        ? `You and ${otherName} know each other by sight and reputation, as everyone in a small town does, but have never really talked. Don't introduce yourself — they know who you are.`
        : `You know ${otherName} by sight and reputation but have never really talked, and what you've heard doesn't impress you. Don't introduce yourself — size them up.`);
      if (topic) parts.push(topicIntent(topic, otherName));
    } else if (topic) {
      parts.push(`Start talking to ${otherName}. ${topicIntent(topic, otherName)}`);
    } else {
      parts.push(`Start talking to ${otherName}. Be authentic to your personality and mood.`);
    }
    // Playtest openers were mostly vague pleasantries ("we should really
    // celebrate something soon", "we should catch up properly sometime"):
    // nothing for the other side to answer and nothing for the chronicle.
    parts.push('Say something concrete — a person, place or event from your [Memory] entries — not a vague "we should catch up sometime".');
    // Playtest #2 (G6): openers still led with "how are you doing today" even
    // with a concrete topic. Named outright, the model stops reaching for them;
    // generateResponse strips any that slip through (stripGenericOpener).
    // Only a newcomer's introduction keeps its greeting: introducing yourself
    // IS the topic there. Townsfolk meeting properly for the first time open
    // with "Good morning, how are you?" as readily as anyone (playtest #3).
    if (!introducing) {
      parts.push(`Skip the small talk: don't open with ${BANNED_OPENERS.map((o) => `"${o}"`).join(', ')} or the like — start with the thing itself.`);
    }
  } else if (messageCount >= maxTurns - 2) {
    // Wrapping up
    parts.push(`Start wrapping up naturally. Say goodbye, make plans to meet again, or leave a lasting impression.`);
  } else if (messageCount >= maxTurns - 4) {
    // Winding down
    parts.push(`Continue with ${otherName}. The conversation is winding down — make your point if you have one.`);
  } else {
    // Mid-conversation
    parts.push(`Respond to ${otherName}. Build on what was just said — don't change topic abruptly.`);
  }

  // Emotional reaction to last message
  if (lastMessageSentiment !== undefined && messageCount > 0) {
    if (lastMessageSentiment > 0.5) {
      parts.push('They seemed happy. React to their energy.');
    } else if (lastMessageSentiment < -0.5) {
      parts.push('They seemed upset. Your personality decides if you comfort or dismiss them.');
    }
  }

  // Date mode. Not during a proposal: "be flirty" on the answering turn leans
  // the model toward yes, and the answer has to be free to be no.
  if (romance && romance > 30 && messageCount > 0 && topic !== PROPOSAL_TOPIC && topic !== RENDEZVOUS_TOPIC) {
    parts.push('This is a romantic moment. Be flirty, vulnerable, or playful — whatever fits you.');
  }

  // Goal stakes
  if (goalContext) {
    parts.push(goalContext);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildAgentSystemPrompt(
  agent: AgentRow,
  needs: NeedsRow,
  economy: EconomyRow,
  effectivePersonality?: PersonalityProfile | null,
  statePrompts?: string[],
  enrichment?: AgentEnrichment | null,
  /** The listener's age, when known: a scene with a minor in it is always chaste. */
  otherAge?: number,
): string {
  const resolvedPersonality = effectivePersonality ?? agent.personality;

  // Identity line
  const identity = `You are ${agent.name}, ${agent.age}, ${economy.job_title}.`;

  // Traits
  const traitsLine = buildTraitsLine(agent.traits);

  // Voice directive
  const voiceDirective = resolvedPersonality
    ? generateVoiceDirective(agent.id, resolvedPersonality as PersonalityProfile)
    : '';

  // Self-description: use evolving self-concept if available, fall back to static bio
  const agentDescription = agent.self_description || agent.bio || '';
  const descriptionLine = agentDescription ? `About you: ${agentDescription}` : '';

  // Mood + momentum
  const moodLine = buildMoodLine(needs.mood);
  let momentumLine = '';
  if (enrichment) {
    if (enrichment.moodMomentum > 5) momentumLine = "You've been feeling increasingly happy lately.";
    else if (enrichment.moodMomentum < -5) momentumLine = "You've been going through a rough patch.";
  }

  // States — dramatize for LLM
  let stateLines = '';
  if (statePrompts?.length) {
    stateLines = 'Right now:\n' + statePrompts.map(s => `• ${s}`).join('\n');
  }

  // Drink state
  let drinkLine = '';
  if (enrichment && enrichment.drinkCount >= 5) {
    drinkLine = "You're drunk. Your words slur and your filter is gone.";
  } else if (enrichment && enrichment.drinkCount >= 3) {
    drinkLine = `You've had ${enrichment.drinkCount} drinks and you're feeling tipsy.`;
  }

  // Critical needs
  const criticalNeedsLine = buildCriticalNeedsLine(needs, economy.money);

  // Financial status
  const econLine = `Your financial situation: ${describeFinancialStatus(economy.money)} ($${Math.round(economy.money)}).`;

  // Reputation. "…consider you neutral" said nothing in most prompts; its
  // tokens now pay for the self-facts line below.
  let repLine = '';
  if (enrichment && enrichment.reputationScore !== 0 && enrichment.reputationLabel !== 'neutral') {
    repLine = `The townspeople consider you ${enrichment.reputationLabel}.`;
  }
  // Stable numbers (tenure, years in town, household): a self-description
  // replaces the bio above and tends to drop them, and the model then invents
  // new ones (Thomas: mayor "twelve years", next day "five years").
  const factsLine = enrichment?.selfFacts ?? '';

  // Hobbies
  let hobbyLine = '';
  if (enrichment && enrichment.hobbies.length > 0) {
    const hobbyParts = enrichment.hobbies.slice(0, 3).map(h => `${h.hobby} (lv${h.level})`);
    hobbyLine = `Your hobbies: ${hobbyParts.join(', ')}.`;
  }

  // Family: children and a baby on the way, one line (lib/familyState.ts).
  const familyLine = enrichment?.family ?? '';

  // Build prompt parts, filtering empties
  // The maturity line follows the setting. It is the chaste text unless the rule
  // is on AND everyone in the scene is an adult (the listener's age is passed
  // by buildConversationPrompt), so a child never reads "desire and temptation".
  const adultTone = isAdultContent() && isAdultAge(agent.age) && (otherAge === undefined || isAdultAge(otherAge));
  const header = [identity, traitsLine, voiceDirective].filter(Boolean).join(' ') + `\n${TOWN_SETTING} ${maturityDirective(adultTone)}`;
  const middle = [descriptionLine, factsLine, familyLine, moodLine, momentumLine, stateLines, drinkLine, criticalNeedsLine, econLine, repLine, hobbyLine].filter(Boolean).join('\n');
  // Adaptive instruction based on personality extremes
  const p = resolvedPersonality as { impulsiveness?: number; warmth?: number; aggression?: number } | null;
  let toneHint = '';
  if (p) {
    if (p.impulsiveness && p.impulsiveness > 70) toneHint = ' Keep it raw and unfiltered.';
    else if (p.warmth && p.warmth > 70) toneHint = ' Be genuine and caring.';
    else if (p.aggression && p.aggression > 60) toneHint = " Don't hold back.";
  }
  // Spelled out because "natural speech, not prose" alone didn't hold: the model
  // spent much of its 80-token cap on "(You shift slightly…)" directions, quotes
  // and emoji, then got cut off mid-sentence. The sanitiser strips what slips
  // through, but every token spent on a direction is one not spent on speech.
  const instruction = `Reply in 1-2 sentences. Only the words you say aloud: no actions, no parentheses, no asterisks, no quotes, no emoji. You can be rude, evasive, flirty, or dismissive — whatever fits your personality.${toneHint}`;

  const sections = [header, middle, instruction].filter(Boolean);
  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Conversation prompt builder
// ---------------------------------------------------------------------------

export interface ConversationPromptParams {
  speaker: AgentRow;
  speakerNeeds: NeedsRow;
  speakerEcon: EconomyRow;
  conversation: ConversationRow;
  relationship: RelationshipRow | null;
  otherAgent: AgentRow;
  memories: MemoryRow[];
  world: WorldStateRow;
  location: LocationRow;
  effectivePersonality?: PersonalityProfile | null;
  statePrompts?: string[];
  gossipFacts?: Array<{ content: string; sensitivity: number }>;
  situationalPrompt?: string | null;
  enrichment?: AgentEnrichment | null;
  /** Which side, if either, arrived in town recently (lib/newcomers.ts). */
  newcomer?: 'speaker' | 'listener' | null;
  /** The listener's job title ("Town Mayor"), for the "You're talking to" line. */
  otherJobTitle?: string | null;
  /** Words the speaker kept returning to in other conversations today (lib/topicMemory.ts). */
  recentSubjects?: string[];
}

/**
 * "You're talking to Thomas Park (Thomas to you), the mayor — whatever you
 * know about the mayor is about him."
 */
export function buildListenerLine(other: Pick<AgentRow, 'name' | 'gender'>, jobTitle: string | null): string {
  const spoken = addressName(other.name);
  const who = spoken === other.name.trim() ? other.name : `${other.name} (${spoken} to you)`;
  const title = jobTitle?.trim().toLowerCase();
  if (!title || /^(?:unemployed|none)$/.test(title)) return `You're talking to ${who}.`;
  const pronoun = other.gender === 'female' ? 'her' : other.gender === 'male' ? 'him' : 'them';
  return `You're talking to ${who}, the ${title} — whatever you know about the ${title} is about ${pronoun}.`;
}

/**
 * The first-meeting framing for this pair (see FirstMeeting). Shared with
 * generateResponse, whose opener check exempts only a newcomer's introduction.
 */
export function firstMeetingOf(
  relationship: Pick<RelationshipRow, 'familiarity'> | null | undefined,
  newcomer: 'speaker' | 'listener' | null | undefined,
): FirstMeeting {
  const neverTalked = relationship ? relationship.familiarity < 5 : true;
  if (!neverTalked) return null;
  if (newcomer === 'speaker') return 'speaker-new';
  if (newcomer === 'listener') return 'listener-new';
  return 'by-sight';
}

export function buildConversationPrompt(
  params: ConversationPromptParams,
): { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  const {
    speaker,
    speakerNeeds,
    speakerEcon,
    conversation,
    relationship,
    otherAgent,
    memories,
    world,
    location,
    effectivePersonality,
    statePrompts,
    gossipFacts,
    situationalPrompt,
  } = params;

  // Extract friendship for context selector
  const friendship = relationship
    ? (relationship.agent_a === speaker.id ? relationship.friendship_ab : relationship.friendship_ba)
    : 0;

  // Select context items
  const contextItems = selectConversationContext({
    memories: memories.map(m => ({
      description: m.description,
      emotional_valence: (m as any).emotional_valence ?? 0,
      created_at: m.created_at,
      metadata: (m as any).metadata ?? {},
    })),
    facts: gossipFacts ?? [],
    statePrompts: statePrompts ?? [],
    situationalPrompt: situationalPrompt ?? null,
    otherAgentName: otherAgent.name,
    otherAgentId: otherAgent.id,
    topic: conversation.topic,
    currentTick: world.time.totalTicks,
    friendship,
  });

  // Build system prompt with enrichment data
  const system = buildAgentSystemPrompt(
    speaker,
    speakerNeeds,
    speakerEcon,
    effectivePersonality,
    statePrompts,
    params.enrichment,
    otherAgent.age,
  );

  // Build user message parts
  const userParts: string[] = [];

  // Setting line
  userParts.push(buildSettingLine(world, location.name));

  const meeting = firstMeetingOf(relationship, params.newcomer);

  // Who is in front of them. Playtest #3: Rosa, talking TO the mayor, spoke of
  // "the Mayor's preoccupation with his own precision" — her memories named
  // "the Mayor" and nothing tied that title to Thomas. The full name appears
  // once here (memories use it); everything after uses the spoken name.
  userParts.push(buildListenerLine(otherAgent, params.otherJobTitle ?? null));

  // Relationship tag
  const otherRomance = relationship
    ? (relationship.agent_a === speaker.id ? relationship.romance_ba : relationship.romance_ab)
    : 0;
  const romanticScene = otherRomance > 15 || /^(?:flirting|romance)$/i.test(conversation.topic ?? '');
  const spokenName = addressName(otherAgent.name);
  // A private history (a kiss, a night together, a marriage it would betray) is
  // only told to adults, and only when there is a relationship row to carry it.
  const intimacy = relationship
    ? intimacyLinesFor(
        speaker, otherAgent, spokenName, relationship.tags,
        relationship.agent_a === speaker.id ? relationship.romance_ab : relationship.romance_ba,
      )
    : [];
  userParts.push(buildRelationshipTag(relationship, speaker.id, spokenName, meeting, romanticScene, intimacy));

  // Context items with prefixes
  const contextPrefixes: Record<ContextItem['type'], string> = {
    situation: '[Situation]',
    state: '[State]',
    memory: '[Memory]',
    fact: '[You know]',
  };
  for (const item of contextItems) {
    userParts.push(`${contextPrefixes[item.type]} ${item.text}`);
  }

  // Turn instruction with enriched context
  const messageCount = conversation.messages.length;
  const maxTurns = conversation.max_turns ?? 6;
  const romance = relationship
    ? (relationship.agent_a === speaker.id ? relationship.romance_ab : relationship.romance_ba)
    : 0;
  // Get sentiment from last message (if any)
  const lastMsg = conversation.messages.length > 0
    ? conversation.messages[conversation.messages.length - 1] as Record<string, any>
    : null;
  const lastSentiment = lastMsg?.sentiment as number | undefined;

  // The listener by the name the speaker calls them: the model echoes the form
  // the instruction uses, and "Start talking to Priya Sharma" came back as
  // "Good morning, Priya Sharma" (the sanitiser shortens what still slips by).
  const turnInstruction = buildTurnInstruction(
    messageCount, maxTurns, addressName(otherAgent.name), conversation.topic,
    friendship, meeting, romance, lastSentiment,
  );
  const repetitionHint = buildRepetitionHint(
    conversation.messages as Array<{ speakerId: number; text: string; fallback?: boolean }>,
    speaker.id,
    speaker.name,
  );
  // Legacy messages (no `fallback` key) are matched against the canned line
  // with their own speaker's name — both names are known here.
  const nameOf = (id: number) => (id === speaker.id ? speaker.name : otherAgent.name);

  // Build message array. Consecutive same-role messages are merged: the turn
  // instruction below always follows the other person's line, and Gemma-style
  // chat templates expect strict user/assistant alternation.
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const push = (role: "user" | "assistant", content: string) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else messages.push({ role, content });
  };

  // First message is context
  push("user", userParts.join('\n'));

  // Add recent conversation history (last 6 messages). The other person's lines
  // carry their name: unlabelled "user" turns read to the model as an anonymous
  // chat user, which is how "thank you for asking, [Your Name]" got written to
  // someone the prompt had named three lines earlier.
  const recentMessages = conversation.messages.slice(-6) as Array<{
    speakerId: number;
    text: string;
    fallback?: boolean;
  }>;
  const otherFirstName = firstName(otherAgent.name);

  for (const msg of recentMessages) {
    // A canned fallback ("Omar smiled and nodded.") is narration, not a line.
    // As the speaker's own "assistant" turn it would teach them to narrate, so
    // it is dropped; the other person's is kept as a bracketed action, like the
    // [Memory]-style tags above, so the reply can still react to it.
    if (isFallbackMessage(msg, nameOf(msg.speakerId))) {
      if (msg.speakerId !== speaker.id) push("user", `[${msg.text}]`);
      continue;
    }
    if (msg.speakerId === speaker.id) push("assistant", msg.text);
    else push("user", `${otherFirstName}: ${msg.text}`);
  }

  // The turn instruction goes LAST, right before generation. It used to sit in
  // the first message above the history, where later-turn guidance ("wrap up",
  // "they seem upset") drowned under six lines of chat — conversations looped on
  // the same openers and questions.
  // What they already said to others today (lib/topicMemory.ts). Not during a
  // proposal: that question has one subject.
  const subjectsHint = conversation.topic === PROPOSAL_TOPIC || conversation.topic === RENDEZVOUS_TOPIC ? '' : buildSubjectsHint(params.recentSubjects);
  push("user", `[Your turn] ${[turnInstruction, repetitionHint, subjectsHint].filter(Boolean).join(' ')} Reply with only your spoken words.`);

  return { system, messages };
}

/**
 * "You've already talked about foundation and flour today — bring up something
 * else unless asked." Playtest #3: Yuki raised the old stone foundation (one of
 * her goals) in six conversations, Rosa offered extra flour twice; each
 * conversation started from the same goals with no memory of the last.
 */
export function buildSubjectsHint(subjects: readonly string[] | undefined): string {
  if (!subjects?.length) return '';
  const list = subjects.length === 1
    ? subjects[0]
    : `${subjects.slice(0, -1).join(', ')} and ${subjects[subjects.length - 1]}`;
  return `You've already talked about ${list} today — bring up something else unless asked.`;
}

/**
 * Name the speaker's own recent openers and questions so they don't loop on
 * them. Playtest: 14 of 104 lines asked "how are you doing (really)", and one
 * agent opened every line with "Well, I…". Looks at the last two of the
 * speaker's own lines only — a handful of tokens, not a transcript.
 */
function buildRepetitionHint(
  messages: Array<{ speakerId: number; text: string; fallback?: boolean }>,
  speakerId: number,
  speakerName: string,
): string {
  const own = messages
    .filter((m) => m.speakerId === speakerId && !isFallbackMessage(m, speakerName))
    .slice(-2);
  const openers = new Set<string>();
  const questions = new Set<string>();
  for (const m of own) {
    const text = (m.text ?? '').trim();
    const opener = text.split(/\s+/).slice(0, 2).join(' ').replace(/[.!?…]+$/, '');
    if (opener) openers.add(opener);
    const asked = text.match(/[^.!?…]+\?/g);
    const lastQuestion = asked?.[asked.length - 1]?.trim();
    if (lastQuestion) {
      const words = lastQuestion.split(/\s+/);
      questions.add(words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : lastQuestion);
    }
  }
  const parts: string[] = [];
  if (openers.size > 0) {
    parts.push(`Don't start with ${[...openers].map((o) => `"${o}"`).join(' or ')} again.`);
  }
  if (questions.size > 0) {
    parts.push(`Don't repeat your question ${[...questions].map((q) => `"${q}"`).join(' or ')}.`);
  }
  return parts.join(' ');
}
