/**
 * Template-tier conversation lines.
 *
 * Variant text is the spoken line ONLY — no "{speaker.name}: " prefix. The UI
 * (ConversationViewer / ConversationDetail / speech bubbles) already labels each
 * message with its speaker, so a prefixed line rendered as
 * "Priya Sharma: Priya Sharma: I can barely see the hills…".
 *
 * Any line that presumes a context must say so in `conditions`: weather lines
 * name their exact weather (fog talk only in fog), lines that only make sense
 * under the open sky carry `setting: 'outdoor'`, and "come to {location.name}"
 * carries `listenerElsewhere: true` so it is never said to someone standing there.
 */
export interface TemplateDef {
  category: string;
  conditions: {
    minFriendship: number | null;
    maxFriendship: number | null;
    minMood: number | null;
    maxMood: number | null;
    timeOfDay: string[] | null;
    location: string[] | null;
    weather: string[] | null;
    /** Indoors vs. open ground (see OUTDOOR_TYPES). Omitted = either. */
    setting?: 'indoor' | 'outdoor' | null;
    /** Only when the listener is NOT at the conversation's location. */
    listenerElsewhere?: boolean | null;
    /** Location types where this template must NOT be used. */
    notLocation?: string[] | null;
  };
  variants: Array<{ text: string; sentiment: number }>;
  cooldownPerPair: number;
}

/**
 * Placeholders that name a real townsperson by job (from `economy.job`). The
 * catalog was written for a fixed cast ("Priya's bread", "Marco makes the best
 * drinks"); procedural towns have different people, or none in that job. A
 * variant using one of these is only eligible when an active agent holds the
 * job and is neither of the two people talking; otherwise the variant is
 * skipped. `{tavern.name}` works the same way for the town's tavern.
 */
export const ROLE_PLACEHOLDERS: Record<string, string> = {
  'baker.name': 'baker',
  'bartender.name': 'bartender',
};

/**
 * A generic answer for the second speaker when no template reply is available
 * (every candidate category is on its per-pair cooldown, or none matches). A
 * template conversation must never be one person talking at another. Keyed by
 * the opener's tone.
 */
export const TEMPLATE_REPLY_FALLBACKS: Record<'warm' | 'neutral' | 'cold', Array<{ text: string; sentiment: number }>> = {
  warm: [
    { text: "Ha! Good to see you too, {other.name}.", sentiment: 0.4 },
    { text: "You always know how to cheer me up.", sentiment: 0.4 },
    { text: "Couldn't agree more.", sentiment: 0.3 },
  ],
  neutral: [
    { text: "Mm. I suppose so.", sentiment: 0.0 },
    { text: "Can't argue with that, {other.name}.", sentiment: 0.1 },
    { text: "*nods* Fair enough.", sentiment: 0.0 },
  ],
  cold: [
    { text: "...Right.", sentiment: -0.2 },
    { text: "*shrugs and looks away*", sentiment: -0.2 },
    { text: "If you say so, {other.name}.", sentiment: -0.1 },
  ],
};

/**
 * Closing lines for an LLM conversation the sim has to end before it ran its
 * course (see `conversationPacing.ts`), keyed by why. Said by the participant
 * who is leaving. The need-driven lines give the reason out loud, so the
 * transcript explains why they walked off; `budget` is the clock running out.
 * Deliberately not the `farewell` template category: that one is on a per-pair
 * cooldown, and a forced ending must always have a line.
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

export const CONVERSATION_TEMPLATES: TemplateDef[] = [
  // ===== greeting_friendly =====
  {
    category: "greeting_friendly",
    conditions: {
      minFriendship: 40,
      maxFriendship: null,
      minMood: 50,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Hey {other.name}! So good to see you!", sentiment: 0.7 },
      { text: "{other.name}! Just the person I wanted to run into.", sentiment: 0.6 },
      { text: "Well if it isn't my favorite person in town!", sentiment: 0.8 },
      { text: "{other.name}, you're looking great today!", sentiment: 0.6 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "greeting_friendly",
    conditions: {
      minFriendship: 40,
      maxFriendship: null,
      minMood: 50,
      maxMood: null,
      timeOfDay: ["morning", "dawn"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "Morning! I was just thinking about you, {other.name}.", sentiment: 0.6 },
      { text: "Good morning, {other.name}! Sleep well?", sentiment: 0.6 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "greeting_friendly",
    conditions: {
      minFriendship: 40,
      maxFriendship: null,
      minMood: 50,
      maxMood: null,
      timeOfDay: ["morning", "dawn"],
      location: null,
      weather: ["sunny"],
    },
    variants: [
      { text: "Good morning, {other.name}! Beautiful day, isn't it?", sentiment: 0.7 },
    ],
    cooldownPerPair: 4,
  },
  {
    // Friends still greet each other on a bad day — just more quietly.
    category: "greeting_friendly",
    conditions: {
      minFriendship: 40,
      maxFriendship: null,
      minMood: null,
      maxMood: 49,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Hey, {other.name}. Glad it's you.", sentiment: 0.4 },
      { text: "Oh, {other.name}. I could use a friendly face today.", sentiment: 0.3 },
    ],
    cooldownPerPair: 4,
  },

  // ===== greeting_neutral =====
  // Greeting bands (see greetingCategory in server/ai/templates.ts): friendly
  // at friendship >= 40, cold below -20, neutral in between — which includes
  // strangers at 0. Every band has a template for every mood.
  {
    category: "greeting_neutral",
    conditions: {
      minFriendship: -20,
      maxFriendship: 39,
      minMood: null,
      maxMood: 29,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Oh. Hi, {other.name}.", sentiment: 0.0 },
      { text: "*gives {other.name} a tired nod*", sentiment: 0.0 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "greeting_neutral",
    conditions: {
      minFriendship: -20,
      maxFriendship: 39,
      minMood: 30,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Oh, hello {other.name}.", sentiment: 0.2 },
      { text: "Hey there, {other.name}. How's it going?", sentiment: 0.3 },
      { text: "{other.name}. *nods*", sentiment: 0.1 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "greeting_neutral",
    conditions: {
      minFriendship: -20,
      maxFriendship: 39,
      minMood: 30,
      maxMood: null,
      timeOfDay: ["afternoon"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "Afternoon, {other.name}.", sentiment: 0.2 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "greeting_neutral",
    conditions: {
      minFriendship: -20,
      maxFriendship: 39,
      minMood: null,
      maxMood: null,
      timeOfDay: ["evening"],
      location: ["tavern"],
      weather: null,
    },
    variants: [
      { text: "Evening, {other.name}. Busy night?", sentiment: 0.2 },
      { text: "{other.name}. Grab a seat, there's room.", sentiment: 0.3 },
    ],
    cooldownPerPair: 4,
  },

  // ===== greeting_cold =====
  {
    category: "greeting_cold",
    conditions: {
      minFriendship: null,
      maxFriendship: 9,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "...{other.name}.", sentiment: -0.3 },
      { text: "Oh. It's you.", sentiment: -0.4 },
      { text: "*barely glances at {other.name}*", sentiment: -0.5 },
      { text: "{other.name}. *crosses arms*", sentiment: -0.4 },
    ],
    cooldownPerPair: 4,
  },

  // ===== tense_encounter =====
  {
    category: "tense_encounter",
    conditions: {
      minFriendship: null,
      maxFriendship: 0,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "*sees {other.name} and tenses up* ...what do you want?", sentiment: -0.6 },
      { text: "Great. Just what I needed today. {other.name}.", sentiment: -0.5 },
      { text: "*deliberately avoids eye contact with {other.name}*", sentiment: -0.4 },
      { text: "Don't you have somewhere else to be, {other.name}?", sentiment: -0.7 },
      { text: "*scoffs* Of course you're here.", sentiment: -0.5 },
    ],
    cooldownPerPair: 4,
  },

  // ===== passive_aggressive =====
  {
    category: "passive_aggressive",
    conditions: {
      minFriendship: -30,
      maxFriendship: 20,
      minMood: null,
      maxMood: 40,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Oh, {other.name}. Having a good day? Must be nice.", sentiment: -0.4 },
      { text: "Funny running into you. I was just thinking about... never mind.", sentiment: -0.3 },
      { text: "{other.name}. *forced smile* How lovely.", sentiment: -0.3 },
      { text: "I'm sure everything's just perfect in your world, {other.name}.", sentiment: -0.5 },
      { text: "No no, don't mind me. I'm just fine. *clearly not fine*", sentiment: -0.4 },
    ],
    cooldownPerPair: 6,
  },

  // ===== snide_remark =====
  {
    category: "snide_remark",
    conditions: {
      minFriendship: null,
      maxFriendship: 10,
      minMood: null,
      maxMood: 50,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "*mutters under breath as {other.name} walks by*", sentiment: -0.4 },
      { text: "Some people just have no self-awareness. *glances at {other.name}*", sentiment: -0.6 },
      { text: "I heard some interesting things about you, {other.name}. But I'll keep it to myself. For now.", sentiment: -0.5 },
      { text: "{other.name}. Still here, I see.", sentiment: -0.3 },
    ],
    cooldownPerPair: 6,
  },

  // ===== tavern_social =====
  {
    category: "tavern_social",
    conditions: {
      minFriendship: 20,
      maxFriendship: null,
      minMood: 40,
      maxMood: null,
      timeOfDay: ["evening", "night"],
      location: ["tavern"],
      weather: null,
    },
    variants: [
      { text: "{other.name}! Pull up a chair, drinks are on me tonight.", sentiment: 0.7 },
      { text: "Nothing like a cold one after a long day. Cheers, {other.name}!", sentiment: 0.6 },
      { text: "This place really comes alive at night. Glad to see you here, {other.name}.", sentiment: 0.5 },
      { text: "{bartender.name} makes the best drinks in town. What are you having, {other.name}?", sentiment: 0.5 },
      { text: "*raises glass* To another day survived in this town!", sentiment: 0.6 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "tavern_social",
    conditions: {
      minFriendship: null,
      maxFriendship: 19,
      minMood: null,
      maxMood: null,
      timeOfDay: ["evening", "night"],
      location: ["tavern"],
      weather: null,
    },
    variants: [
      { text: "*sits at the bar alone, nursing a drink* ...evening.", sentiment: -0.1 },
      { text: "Didn't expect to see you here, {other.name}.", sentiment: 0.0 },
      { text: "*glances over* Rough day?", sentiment: -0.1 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "tavern_social",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: 30,
      timeOfDay: ["evening", "night"],
      location: ["tavern"],
      weather: null,
    },
    variants: [
      { text: "*stares into drink* I just needed to get out of the house tonight.", sentiment: -0.3 },
      { text: "Some days this town feels too small. Know what I mean, {other.name}?", sentiment: -0.4 },
      { text: "I'm not great company tonight. But I didn't want to be alone either.", sentiment: -0.3 },
    ],
    cooldownPerPair: 6,
  },

  // ===== farewell =====
  {
    category: "farewell",
    conditions: {
      minFriendship: 40,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Take care, {other.name}! See you around.", sentiment: 0.5 },
      { text: "It was really nice talking to you, {other.name}.", sentiment: 0.6 },
      { text: "Alright, I should get going. Catch you later, {other.name}!", sentiment: 0.4 },
    ],
    cooldownPerPair: 2,
  },
  {
    category: "farewell",
    conditions: {
      minFriendship: null,
      maxFriendship: 39,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Well, I should be going.", sentiment: 0.0 },
      { text: "See you around, {other.name}.", sentiment: 0.1 },
      { text: "I need to head out. Bye.", sentiment: 0.0 },
    ],
    cooldownPerPair: 2,
  },

  // ===== small_talk_weather =====
  // One entry per exact weather: a line about fog must never fire in merely
  // cloudy weather. Lines that only work under the open sky are `outdoor`.
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["sunny"],
    },
    variants: [
      { text: "Not a cloud in the sky today!", sentiment: 0.4 },
      { text: "Lovely bit of sun we're having, {other.name}.", sentiment: 0.4 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["sunny"],
      setting: "outdoor",
    },
    variants: [
      { text: "What a gorgeous day! The sun feels wonderful.", sentiment: 0.5 },
      { text: "Perfect weather for being outdoors, don't you think, {other.name}?", sentiment: 0.4 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["sunny"],
      setting: "indoor",
    },
    variants: [
      { text: "Shame to be stuck inside on a day this sunny.", sentiment: 0.1 },
      { text: "Have you seen the sun out there? We should be outside, {other.name}.", sentiment: 0.3 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["rainy", "stormy"],
    },
    variants: [
      { text: "This weather is really something, huh?", sentiment: -0.1 },
      { text: "I hope this rain lets up soon. Everything's getting muddy.", sentiment: -0.2 },
      { text: "Stay dry out there, {other.name}.", sentiment: 0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["rainy", "stormy"],
      setting: "indoor",
    },
    variants: [
      { text: "Glad to be in out of the rain, I'll tell you that.", sentiment: 0.2 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["cloudy"],
    },
    variants: [
      { text: "Bit gloomy out today, isn't it?", sentiment: -0.1 },
      { text: "Feels like the clouds might open up any minute.", sentiment: -0.1 },
      { text: "Grey skies again. I could do with some sun.", sentiment: -0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["foggy"],
    },
    variants: [
      { text: "Bit gloomy out today, isn't it?", sentiment: -0.1 },
      { text: "Did you see the fog this morning? Thick as porridge.", sentiment: 0.0 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["foggy"],
      setting: "outdoor",
    },
    variants: [
      { text: "I can barely see the hills through this fog.", sentiment: 0.0 },
      { text: "Careful, {other.name} - I nearly walked straight into you in this fog.", sentiment: 0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["snowy"],
    },
    variants: [
      { text: "There's something peaceful about the snow, don't you think?", sentiment: 0.2 },
      { text: "I can barely feel my fingers. This winter is harsh.", sentiment: -0.2 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["snowy"],
      setting: "outdoor",
    },
    variants: [
      { text: "Look at all this snow! It's beautiful but freezing.", sentiment: 0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["snowy"],
      setting: "indoor",
    },
    variants: [
      { text: "Nice to be somewhere warm with all that snow outside.", sentiment: 0.3 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["windy"],
    },
    variants: [
      { text: "This wind is relentless today!", sentiment: -0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["windy"],
      setting: "outdoor",
    },
    variants: [
      { text: "Hold onto your hat, {other.name}! The wind's picking up.", sentiment: 0.0 },
      { text: "I love a good breeze, but this is a bit much.", sentiment: -0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["windy"],
      setting: "indoor",
    },
    variants: [
      { text: "Hear that wind rattling the shutters?", sentiment: -0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["hot"],
    },
    variants: [
      { text: "This heat is unbearable. Want to grab a cold drink?", sentiment: 0.1 },
      { text: "I'm melting! How do you handle this heat, {other.name}?", sentiment: -0.1 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_weather",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: ["hot"],
      setting: "outdoor",
    },
    variants: [
      { text: "It's absolutely scorching out here. I need shade.", sentiment: -0.2 },
    ],
    cooldownPerPair: 6,
  },

  // ===== small_talk_work =====
  {
    category: "small_talk_work",
    conditions: {
      minFriendship: 20,
      maxFriendship: null,
      minMood: 40,
      maxMood: null,
      timeOfDay: ["morning", "afternoon"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "How's work been treating you, {other.name}?", sentiment: 0.3 },
      { text: "Busy day? I've been run off my feet!", sentiment: 0.2 },
      { text: "I've got so much to do today, but at least the company's good.", sentiment: 0.3 },
      { text: "You know, I actually enjoy what I do. Most days, anyway.", sentiment: 0.4 },
    ],
    cooldownPerPair: 6,
  },
  {
    category: "small_talk_work",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: 39,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Work's been rough lately. I could use a break.", sentiment: -0.2 },
      { text: "Don't even get me started on today. It's been one thing after another.", sentiment: -0.3 },
      { text: "Some days I wonder why I bother. *sighs*", sentiment: -0.4 },
    ],
    cooldownPerPair: 6,
  },

  // ===== purchase =====
  {
    category: "purchase",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: 50,
      maxMood: null,
      timeOfDay: null,
      location: ["shop"],
      weather: null,
    },
    variants: [
      { text: "I'll take the usual, please. Thanks, {other.name}!", sentiment: 0.4 },
      { text: "Got anything new in stock? I'm in a buying mood.", sentiment: 0.5 },
      { text: "Just picking up a few things. You always have what I need.", sentiment: 0.4 },
    ],
    cooldownPerPair: 3,
  },
  {
    category: "purchase",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: 49,
      timeOfDay: null,
      location: ["shop"],
      weather: null,
    },
    variants: [
      { text: "Just need to grab a few essentials. Prices seem steep today...", sentiment: -0.1 },
      { text: "I'll take the cheapest option. Funds are tight.", sentiment: -0.2 },
      { text: "*looks at prices and sighs* I'll just take the basics.", sentiment: -0.2 },
    ],
    cooldownPerPair: 3,
  },

  // ===== work_handoff =====
  {
    category: "work_handoff",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: ["morning", "afternoon"],
      location: ["farm", "shop", "clinic"],
      weather: null,
    },
    variants: [
      { text: "{other.name}, I've finished up the morning tasks. Your turn for the afternoon shift.", sentiment: 0.2 },
      { text: "Everything's set up for you, {other.name}. Inventory is stocked.", sentiment: 0.3 },
      { text: "I'm heading out — left notes on what still needs doing.", sentiment: 0.1 },
      { text: "Shift change! Here are the keys, {other.name}. Nothing unusual today.", sentiment: 0.2 },
    ],
    cooldownPerPair: 8,
  },

  // ===== complaint_mood =====
  {
    category: "complaint_mood",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: 30,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Everything just feels... off today. I can't shake this mood.", sentiment: -0.5 },
      { text: "Sorry if I seem short. I'm not having the best day.", sentiment: -0.4 },
      { text: "*rubs temples* I just need things to go right for once.", sentiment: -0.5 },
      { text: "Don't mind me, {other.name}. I'm just in a funk.", sentiment: -0.3 },
      { text: "Nothing's wrong exactly, I just... wish things were different.", sentiment: -0.4 },
    ],
    cooldownPerPair: 8,
  },

  // ===== excited_event =====
  {
    category: "excited_event",
    conditions: {
      minFriendship: 30,
      maxFriendship: null,
      minMood: 70,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "{other.name}, did you hear?! Something amazing is happening in town!", sentiment: 0.8 },
      { text: "I'm SO excited! This is the best thing to happen all season!", sentiment: 0.9 },
      { text: "I can barely contain myself! This is going to be incredible!", sentiment: 0.9 },
    ],
    cooldownPerPair: 10,
  },
  {
    category: "excited_event",
    conditions: {
      minFriendship: 30,
      maxFriendship: null,
      minMood: 70,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
      listenerElsewhere: true,
    },
    variants: [
      { text: "{other.name}! You have to come to {location.name} — you won't believe what's going on!", sentiment: 0.8 },
    ],
    cooldownPerPair: 10,
  },
  {
    category: "excited_event",
    conditions: {
      minFriendship: null,
      maxFriendship: 29,
      minMood: 70,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "Oh, {other.name}. Have you heard what's happening? Pretty exciting stuff.", sentiment: 0.5 },
    ],
    cooldownPerPair: 10,
  },

  // ===== tired =====
  {
    category: "tired",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: ["evening", "night"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "*yawns* Sorry, {other.name}. Long day.", sentiment: -0.1 },
      { text: "I can barely keep my eyes open. Think I'll turn in soon.", sentiment: -0.2 },
      { text: "My feet are killing me. I've been on them since dawn.", sentiment: -0.2 },
      { text: "I'm exhausted. Need to call it a night soon.", sentiment: -0.2 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "tired",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: ["morning", "dawn"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "*stifles a yawn* Didn't sleep well. Morning, {other.name}.", sentiment: -0.1 },
      { text: "Coffee. I need coffee. Oh, hey {other.name}.", sentiment: 0.0 },
    ],
    cooldownPerPair: 4,
  },

  // ===== hungry =====
  {
    category: "hungry",
    conditions: {
      minFriendship: null,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: ["morning"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "I skipped breakfast and I'm already regretting it.", sentiment: -0.2 },
      { text: "Know anywhere good to eat around here, {other.name}?", sentiment: 0.1 },
      { text: "My stomach's been growling all morning. So embarrassing.", sentiment: -0.1 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "hungry",
    conditions: {
      minFriendship: 30,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: ["afternoon", "evening"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "I could eat a whole harvest feast right now. Join me for food?", sentiment: 0.3 },
      // Dropped automatically when the town has no baker (or the baker is one
      // of the two people talking) — see ROLE_PLACEHOLDERS.
      { text: "{baker.name}'s bread was incredible today. Have you tried it, {other.name}?", sentiment: 0.5 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "hungry",
    conditions: {
      minFriendship: 30,
      maxFriendship: null,
      minMood: null,
      maxMood: null,
      timeOfDay: ["afternoon", "evening"],
      location: null,
      weather: null,
      // Not an invitation you make while already sitting in the tavern.
      notLocation: ["tavern"],
    },
    variants: [
      { text: "{other.name}, want to grab a bite at {tavern.name}? I'm starving.", sentiment: 0.4 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "hungry",
    conditions: {
      minFriendship: null,
      maxFriendship: 29,
      minMood: null,
      maxMood: null,
      timeOfDay: ["afternoon", "evening"],
      location: null,
      weather: null,
    },
    variants: [
      { text: "I really need to eat something soon...", sentiment: -0.1 },
      { text: "*stomach growls* ...excuse me.", sentiment: -0.1 },
    ],
    cooldownPerPair: 4,
  },
];
