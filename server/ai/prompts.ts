/**
 * Prompt Builders for Agent Conversations
 *
 * Constructs system prompts and conversation prompts for LLM calls.
 * Pure functions — no I/O.
 */

import { PersonalityProfile } from '../lib/personality';
import { generateVoiceDirective } from './voiceDirective';
import { selectConversationContext, ContextItem } from './contextSelector';
import { isFallbackMessage } from './sanitizeDialogue';
import { firstName } from './names';

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

function buildRelationshipTag(
  relationship: RelationshipRow | null,
  speakerId: number,
  otherName: string,
): string {
  if (!relationship) return `You don't know ${otherName}.`;

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
  };
  for (const tag of relationship.tags) {
    const mapped = tagMap[tag];
    if (mapped) parts.push(mapped);
  }

  // Romance
  if (romance > 60) {
    parts.push(`You have deep feelings for ${otherName}.`);
  } else if (romance > 40) {
    parts.push(`You're attracted to ${otherName}.`);
  } else if (romance > 20) {
    parts.push(`You find ${otherName} appealing.`);
  }

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
  const gossip = t.match(/^gossip about (.+)$/);
  if (gossip) return `You heard something about ${topic.slice(topic.length - gossip[1].length)} and can't keep it to yourself.`;
  if (t.startsWith('checking on')) return `You want to see how ${other} is really doing — mention something specific you know about them.`;
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
    'checking in': `You want to see how ${other} is really doing — mention something specific you know about them.`,
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
    'catching up': `Ask what's new with ${other} and share a bit of your own news.`,
    'inside joke': `Bring up a joke only the two of you would get.`,
    'friendly greeting': `Greet ${other} the way you would, and say one thing on your mind.`,
    'casual greeting': `Greet ${other} the way you would, and say one thing on your mind.`,
  };
  if (intents[t]) return intents[t];
  const smallTalk = ['weather', 'daily life', 'food', 'work', 'weekend plans', 'memories', 'the farm'];
  if (smallTalk.includes(t)) return `Make small talk about ${t}, with one specific detail from your day.`;
  return `You want to talk about ${topic} — bring it up naturally, as if it's been on your mind.`;
}

function buildTurnInstruction(
  messageCount: number,
  maxTurns: number,
  otherName: string,
  topic: string | null,
  friendship: number,
  isFirstMeeting: boolean,
  romance?: number,
  lastMessageSentiment?: number,
  goalContext?: string | null,
): string {
  const parts: string[] = [];

  if (messageCount === 0) {
    // Opening turn
    if (isFirstMeeting) {
      const approach = friendship >= 0
        ? `Introduce yourself to ${otherName}. You haven't really talked before. Be curious but cautious — first impressions matter.`
        : `You're meeting ${otherName} for the first time. Size them up. Your personality decides how open you are.`;
      parts.push(approach);
    } else if (topic) {
      parts.push(`Start talking to ${otherName}. ${topicIntent(topic, otherName)}`);
    } else {
      parts.push(`Start talking to ${otherName}. Be authentic to your personality and mood.`);
    }
    // Playtest openers were mostly vague pleasantries ("we should really
    // celebrate something soon", "we should catch up properly sometime"):
    // nothing for the other side to answer and nothing for the chronicle.
    parts.push('Say something concrete — a person, place or event from your [Memory] entries — not a vague "we should catch up sometime".');
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

  // Date mode
  if (romance && romance > 30 && messageCount > 0) {
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

  // Reputation
  let repLine = '';
  if (enrichment && enrichment.reputationScore !== 0) {
    repLine = `The townspeople consider you ${enrichment.reputationLabel}.`;
  }

  // Hobbies
  let hobbyLine = '';
  if (enrichment && enrichment.hobbies.length > 0) {
    const hobbyParts = enrichment.hobbies.slice(0, 3).map(h => `${h.hobby} (lv${h.level})`);
    hobbyLine = `Your hobbies: ${hobbyParts.join(', ')}.`;
  }

  // Build prompt parts, filtering empties
  const header = [identity, traitsLine, voiceDirective].filter(Boolean).join(' ');
  const middle = [descriptionLine, moodLine, momentumLine, stateLines, drinkLine, criticalNeedsLine, econLine, repLine, hobbyLine].filter(Boolean).join('\n');
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
  );

  // Build user message parts
  const userParts: string[] = [];

  // Setting line
  userParts.push(buildSettingLine(world, location.name));

  // Relationship tag
  userParts.push(buildRelationshipTag(relationship, speaker.id, otherAgent.name));

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
  const isFirstMeeting = relationship ? relationship.familiarity < 5 : true;
  const romance = relationship
    ? (relationship.agent_a === speaker.id ? relationship.romance_ab : relationship.romance_ba)
    : 0;
  // Get sentiment from last message (if any)
  const lastMsg = conversation.messages.length > 0
    ? conversation.messages[conversation.messages.length - 1] as Record<string, any>
    : null;
  const lastSentiment = lastMsg?.sentiment as number | undefined;

  const turnInstruction = buildTurnInstruction(
    messageCount, maxTurns, otherAgent.name, conversation.topic,
    friendship, isFirstMeeting, romance, lastSentiment,
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
  push("user", `[Your turn] ${[turnInstruction, repetitionHint].filter(Boolean).join(' ')} Reply with only your spoken words.`);

  return { system, messages };
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
