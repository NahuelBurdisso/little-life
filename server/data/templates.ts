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
  };
  variants: Array<{ text: string; sentiment: number }>;
  cooldownPerPair: number;
}

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
      { text: "{speaker.name}: Hey {other.name}! So good to see you!", sentiment: 0.7 },
      { text: "{speaker.name}: {other.name}! Just the person I wanted to run into.", sentiment: 0.6 },
      { text: "{speaker.name}: Well if it isn't my favorite person in {location.name}!", sentiment: 0.8 },
      { text: "{speaker.name}: {other.name}, you're looking great today!", sentiment: 0.6 },
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
      { text: "{speaker.name}: Good morning, {other.name}! Beautiful day, isn't it?", sentiment: 0.7 },
      { text: "{speaker.name}: Morning! I was just thinking about you, {other.name}.", sentiment: 0.6 },
    ],
    cooldownPerPair: 4,
  },

  // ===== greeting_neutral =====
  {
    category: "greeting_neutral",
    conditions: {
      minFriendship: 10,
      maxFriendship: 39,
      minMood: 30,
      maxMood: null,
      timeOfDay: null,
      location: null,
      weather: null,
    },
    variants: [
      { text: "{speaker.name}: Oh, hello {other.name}.", sentiment: 0.2 },
      { text: "{speaker.name}: Hey there, {other.name}. How's it going?", sentiment: 0.3 },
      { text: "{speaker.name}: {other.name}. *nods*", sentiment: 0.1 },
      { text: "{speaker.name}: Afternoon, {other.name}.", sentiment: 0.2 },
    ],
    cooldownPerPair: 4,
  },
  {
    category: "greeting_neutral",
    conditions: {
      minFriendship: 10,
      maxFriendship: 39,
      minMood: null,
      maxMood: null,
      timeOfDay: ["evening"],
      location: ["tavern"],
      weather: null,
    },
    variants: [
      { text: "{speaker.name}: Evening, {other.name}. Busy night?", sentiment: 0.2 },
      { text: "{speaker.name}: {other.name}. Grab a seat, there's room.", sentiment: 0.3 },
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
      { text: "{speaker.name}: ...{other.name}.", sentiment: -0.3 },
      { text: "{speaker.name}: Oh. It's you.", sentiment: -0.4 },
      { text: "{speaker.name}: *barely glances at {other.name}*", sentiment: -0.5 },
      { text: "{speaker.name}: {other.name}. *crosses arms*", sentiment: -0.4 },
    ],
    cooldownPerPair: 4,
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
      { text: "{speaker.name}: {other.name}! Pull up a chair, drinks are on me tonight.", sentiment: 0.7 },
      { text: "{speaker.name}: Nothing like a cold one after a long day. Cheers, {other.name}!", sentiment: 0.6 },
      { text: "{speaker.name}: This place really comes alive at night. Glad to see you here, {other.name}.", sentiment: 0.5 },
      { text: "{speaker.name}: Marco makes the best drinks in town. What are you having, {other.name}?", sentiment: 0.5 },
      { text: "{speaker.name}: *raises glass* To another day survived in Little Life!", sentiment: 0.6 },
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
      { text: "{speaker.name}: *sits at the bar alone, nursing a drink* ...evening.", sentiment: -0.1 },
      { text: "{speaker.name}: Didn't expect to see you here, {other.name}.", sentiment: 0.0 },
      { text: "{speaker.name}: *glances over* Rough day?", sentiment: -0.1 },
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
      { text: "{speaker.name}: *stares into drink* I just needed to get out of the house tonight.", sentiment: -0.3 },
      { text: "{speaker.name}: Some days this town feels too small. Know what I mean, {other.name}?", sentiment: -0.4 },
      { text: "{speaker.name}: I'm not great company tonight. But I didn't want to be alone either.", sentiment: -0.3 },
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
      { text: "{speaker.name}: Take care, {other.name}! See you around.", sentiment: 0.5 },
      { text: "{speaker.name}: It was really nice talking to you, {other.name}.", sentiment: 0.6 },
      { text: "{speaker.name}: Alright, I should get going. Catch you later, {other.name}!", sentiment: 0.4 },
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
      { text: "{speaker.name}: Well, I should be going.", sentiment: 0.0 },
      { text: "{speaker.name}: See you around, {other.name}.", sentiment: 0.1 },
      { text: "{speaker.name}: I need to head out. Bye.", sentiment: 0.0 },
    ],
    cooldownPerPair: 2,
  },

  // ===== small_talk_weather =====
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
      { text: "{speaker.name}: What a gorgeous day! The sun feels wonderful.", sentiment: 0.5 },
      { text: "{speaker.name}: Perfect weather for being outdoors, don't you think, {other.name}?", sentiment: 0.4 },
      { text: "{speaker.name}: Not a cloud in the sky today!", sentiment: 0.4 },
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
      { text: "{speaker.name}: This {weather} is really something, huh?", sentiment: -0.1 },
      { text: "{speaker.name}: I hope this rain lets up soon. Everything's getting muddy.", sentiment: -0.2 },
      { text: "{speaker.name}: Stay dry out there, {other.name}.", sentiment: 0.1 },
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
      weather: ["cloudy", "foggy"],
    },
    variants: [
      { text: "{speaker.name}: Bit gloomy out today, isn't it?", sentiment: -0.1 },
      { text: "{speaker.name}: I can barely see the hills through this fog.", sentiment: 0.0 },
      { text: "{speaker.name}: Feels like the clouds might open up any minute.", sentiment: -0.1 },
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
      { text: "{speaker.name}: How's work been treating you, {other.name}?", sentiment: 0.3 },
      { text: "{speaker.name}: Busy day? I've been run off my feet!", sentiment: 0.2 },
      { text: "{speaker.name}: I've got so much to do today, but at least the company's good.", sentiment: 0.3 },
      { text: "{speaker.name}: You know, I actually enjoy what I do. Most days, anyway.", sentiment: 0.4 },
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
      { text: "{speaker.name}: Work's been rough lately. I could use a break.", sentiment: -0.2 },
      { text: "{speaker.name}: Don't even get me started on today. It's been one thing after another.", sentiment: -0.3 },
      { text: "{speaker.name}: Some days I wonder why I bother. *sighs*", sentiment: -0.4 },
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
      { text: "{speaker.name}: I'll take the usual, please. Thanks, {other.name}!", sentiment: 0.4 },
      { text: "{speaker.name}: Got anything new in stock? I'm in a buying mood.", sentiment: 0.5 },
      { text: "{speaker.name}: Just picking up a few things. You always have what I need.", sentiment: 0.4 },
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
      { text: "{speaker.name}: Just need to grab a few essentials. Prices seem steep today...", sentiment: -0.1 },
      { text: "{speaker.name}: I'll take the cheapest option. Funds are tight.", sentiment: -0.2 },
      { text: "{speaker.name}: *looks at prices and sighs* I'll just take the basics.", sentiment: -0.2 },
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
      { text: "{speaker.name}: {other.name}, I've finished up the morning tasks. Your turn for the afternoon shift.", sentiment: 0.2 },
      { text: "{speaker.name}: Everything's set up for you, {other.name}. Inventory is stocked.", sentiment: 0.3 },
      { text: "{speaker.name}: I'm heading out — left notes on what still needs doing.", sentiment: 0.1 },
      { text: "{speaker.name}: Shift change! Here are the keys, {other.name}. Nothing unusual today.", sentiment: 0.2 },
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
      { text: "{speaker.name}: Everything just feels... off today. I can't shake this mood.", sentiment: -0.5 },
      { text: "{speaker.name}: Sorry if I seem short. I'm not having the best day.", sentiment: -0.4 },
      { text: "{speaker.name}: *rubs temples* I just need things to go right for once.", sentiment: -0.5 },
      { text: "{speaker.name}: Don't mind me, {other.name}. I'm just in a funk.", sentiment: -0.3 },
      { text: "{speaker.name}: Nothing's wrong exactly, I just... wish things were different.", sentiment: -0.4 },
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
      { text: "{speaker.name}: {other.name}, did you hear?! Something amazing is happening in town!", sentiment: 0.8 },
      { text: "{speaker.name}: I'm SO excited! This is the best thing to happen all season!", sentiment: 0.9 },
      { text: "{speaker.name}: {other.name}! You have to come to {location.name} — you won't believe what's going on!", sentiment: 0.8 },
      { text: "{speaker.name}: I can barely contain myself! This is going to be incredible!", sentiment: 0.9 },
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
      { text: "{speaker.name}: Oh, {other.name}. Have you heard what's happening? Pretty exciting stuff.", sentiment: 0.5 },
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
      { text: "{speaker.name}: *yawns* Sorry, {other.name}. Long day.", sentiment: -0.1 },
      { text: "{speaker.name}: I can barely keep my eyes open. Think I'll turn in soon.", sentiment: -0.2 },
      { text: "{speaker.name}: My feet are killing me. I've been on them since dawn.", sentiment: -0.2 },
      { text: "{speaker.name}: I'm exhausted. Need to call it a night soon.", sentiment: -0.2 },
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
      { text: "{speaker.name}: *stifles a yawn* Didn't sleep well. Morning, {other.name}.", sentiment: -0.1 },
      { text: "{speaker.name}: Coffee. I need coffee. Oh, hey {other.name}.", sentiment: 0.0 },
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
      { text: "{speaker.name}: I skipped breakfast and I'm already regretting it.", sentiment: -0.2 },
      { text: "{speaker.name}: Know anywhere good to eat around here, {other.name}?", sentiment: 0.1 },
      { text: "{speaker.name}: My stomach's been growling all morning. So embarrassing.", sentiment: -0.1 },
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
      { text: "{speaker.name}: {other.name}, want to grab a bite at the tavern? I'm starving.", sentiment: 0.4 },
      { text: "{speaker.name}: I could eat a whole harvest feast right now. Join me for food?", sentiment: 0.3 },
      { text: "{speaker.name}: Priya's bread was incredible today. Have you tried it, {other.name}?", sentiment: 0.5 },
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
      { text: "{speaker.name}: I really need to eat something soon...", sentiment: -0.1 },
      { text: "{speaker.name}: *stomach growls* ...excuse me.", sentiment: -0.1 },
    ],
    cooldownPerPair: 4,
  },
];
