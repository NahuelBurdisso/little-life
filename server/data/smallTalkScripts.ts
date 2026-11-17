/**
 * Topic scripts for template-tier conversations (no LLM).
 *
 * Why scripts: template chats (~25% of all conversations — the fallback when
 * the LLM slots are full, see `planConversation`) used to be three lines drawn
 * from three unrelated categories: "Glad to be in out of the rain" answered by
 * "I've got so much to do today, but at least the company's good", then "It
 * was really nice talking to you, Diego Santos." Playtest #2 (G5) read them as
 * non-sequiturs.
 *
 * A script is ONE topic grounded in something real about the moment — the
 * weather, the place, a mutual acquaintance, a town event, what the listener
 * visibly looks like, a plan of the speaker's, the relationship — played as a
 * mini-exchange:
 *
 *   opener (A)  — a question (`ask`) or a statement (`tell`)
 *   reply  (B)  — written FOR that opener: every opener carries its own
 *                 `replies`, so a question gets an answer, not a non-sequitur.
 *                 Statements without their own replies use the script's `react`.
 *   follow (A)  — optional; an acknowledgement matched to the reply's stance
 *                 ("Exactly." / "If you say so.") + one more line on the topic
 *   close       — a farewell that still names the topic ("Try to stay dry").
 *
 * Every line of a script contains at least one of its `anchors` (the topic's
 * words, or a slot value such as the place's or the mutual friend's name);
 * `templateChat.test.ts` checks that over thousands of generated chats, so a
 * reply can't drift off-topic unnoticed.
 *
 * Slots: `{you}` is the LISTENER's first name for that line (never the
 * speaker's own), `{place}`, `{mutual}`, `{event}` / `{Event}`, `{work}`,
 * `{job}`, `{tavern}`, `{baker}`, `{bartender}`, `{eventAsk}` / `{eventYes}` /
 * `{eventNo}` (the event's own question, EVENT_TALK `ask`). A line whose slot has no value
 * in this town is skipped, never rendered with a raw `{...}`.
 *
 * Lines can be flavoured by the speaker's `voice` (from personality, see
 * `voiceOf`) and their `tone` toward the listener (friendship and mood), and
 * gated with `when` on the real state of the speaker (`me`) and listener
 * (`you`). The town lives around 1900 (TOWN_SETTING): no phones, cars or
 * electricity in any line.
 *
 * Pure data + predicates, no DB imports: the composer is server/lib/templateChat.ts.
 */

export type Voice = 'warm' | 'gruff' | 'shy' | 'bubbly' | 'plain';
export type Tone = 'warm' | 'neutral' | 'cool';
export type Stance = 'agree' | 'disagree' | 'neutral';

/** One side of the conversation, as the composer sees it. */
export interface ChatPerson {
  /** Full name — never spoken; `first` is what people call each other. */
  name: string;
  first: string;
  /** This person's friendship toward the OTHER one (directional). */
  friendship: number;
  mood: number;
  hunger: number;
  energy: number;
  voice: Voice;
  tone: Tone;
  /** Spoken job noun ("baker", "nurse"), or null for no job. */
  job: string | null;
  /** Name of their workplace, when they have one. */
  workplace: string | null;
  /** At their own workplace right now. */
  atWork: boolean;
  /** Standing in their own home. */
  livesHere: boolean;
  /**
   * Active agent states ("grieving", "sick", "heartbroken"…), as `getAgentStates`
   * lists them. Template chats were blind to them: a widow at mood 35 (not low
   * enough for `rough_day`) was told "Lovely day!" by the sunny-weather script.
   */
  states: string[];
}

export interface ChatEvent {
  key: string;
  /** "the festival" — reads after a verb or preposition. */
  phrase: string;
  /** The word every event line contains. */
  anchor: string;
  mood: 'good' | 'bad' | 'odd';
  /**
   * A question written for this event, with a yes-ish and an other answer.
   * "What do you make of the full moon?" fitted every event and so was said by
   * every pair on the same night (playtest #3); each event asks its own thing.
   */
  ask?: readonly [question: string, answer: string, otherAnswer: string];
  /** Something one can be told to enjoy: "Enjoy the big catch, Elena." read wrong. */
  enjoy?: boolean;
}

export interface ChatContext {
  /** [opener, listener]. */
  people: [ChatPerson, ChatPerson];
  place: {
    name: string;
    type: string | null;
    setting: 'indoor' | 'outdoor' | null;
    /** The name can be said aloud ("Home 4" can't). */
    speakable: boolean;
  };
  weather: string;
  dayPhase: string;
  /** relationships.status for the pair. */
  status: string | null;
  /** Opener's romance toward the listener. */
  romance: number;
  event: ChatEvent | null;
  /** A third person both know, and whether each likes them. */
  mutual: { first: string; openerLikes: boolean; listenerLikes: boolean } | null;
  roles: { baker?: string; bartender?: string; tavern?: string };
  /**
   * Why the pair is talking: the queued conversation topic ("flirting",
   * "offering help", "offering comfort", "catching up"…). A template chat is
   * the fallback for a conversation that was ASKED for — a crush spotted, a
   * partner nearby, someone sick — and playtest #3 had partners Lucia and
   * Diego fall back to "What do you make of the full moon?". Scripts written
   * for the reason are preferred (templateChat.ts `preferredScripts`).
   */
  intent?: string | null;
  /**
   * The queue entry's `trigger_reason` ('social_call:sick_visit', 'needs_social'…).
   * A social call's chat plays the scripts written for that call
   * (data/socialCallScripts.ts) before anything else: the caller walked over to
   * say something in particular, and the fallback must not be the weather.
   */
  trigger?: string | null;
  /**
   * News about the listener that the opener knows (lib/partnerView.ts `newsKeyOf`):
   * just out of jail, out of work, thinking of leaving, a birthday, in debt. The
   * `their_news` script is written for it, so a template chat doesn't greet a man
   * just out of jail with the weather. Optional: contexts built before it have none.
   */
  news?: ChatNews | null;
}

/** What `ChatContext.news` can be (lib/partnerView.ts decides which, if any). */
export type ChatNews = 'released' | 'lost_job' | 'birthday' | 'leaving' | 'in_debt';

/** Words every line of `their_news` carries, per piece of news. */
export const NEWS_ANCHORS: Record<ChatNews, string[]> = {
  released: ['back'],
  lost_job: ['work'],
  birthday: ['birthday'],
  leaving: ['leav', 'stay'],
  in_debt: ['money', 'times'],
};

/** The queued topic is a flirt (perception crush / infatuation, personality pick). */
export const isFlirtIntent = (c: ChatContext) => /^(?:flirting|romance)$/i.test(c.intent ?? '');
/** The queued topic is an offer of help or comfort. */
export const isHelpIntent = (c: ChatContext) => /^(?:offering help|offering comfort|checking in)$/i.test(c.intent ?? '');
const COUPLE = new Set(['partners', 'engaged', 'married']);

/**
 * States that make someone come across cool whatever they feel for the listener
 * (`toneOf`): a widow, a heartbroken lover and a depressed man don't chirp.
 */
export const HEAVY_STATES: readonly string[] = ['grieving', 'heartbroken', 'depressed'];
export const isGrieving = (p: ChatPerson) => p.states.includes('grieving');
export const isSick = (p: ChatPerson) => p.states.includes('sick');
/** Grieving or heartbroken: no flirting with them, and no gushing about the weather. */
export const isMourning = (p: ChatPerson) => p.states.includes('grieving') || p.states.includes('heartbroken');
/** The scripts a crush plays out on; the beat rules (templateBeats.ts) read the flirt beat off them. */
export const FLIRT_SCRIPT_IDS: ReadonlySet<string> = new Set(['sweethearts', 'shy_flirt', 'flirting']);
/**
 * Scripts the composer drops when EITHER person is mourning: the flirts, and
 * the one whose openers marvel at how glorious the sun is.
 */
export const OFF_KEY_WHILE_MOURNING: ReadonlySet<string> = new Set([...FLIRT_SCRIPT_IDS, 'weather_sun']);

export interface ScriptLine {
  text: string;
  /** Sentiment in [-1, 1]. */
  s: number;
  voice?: Voice[];
  tone?: Tone[];
  stance?: Stance;
  when?: (c: ChatContext, me: ChatPerson, you: ChatPerson) => boolean;
}

export interface OpenerLine extends ScriptLine {
  kind: 'ask' | 'tell';
  /** Replies written for this opener; statements may fall back to `react`. */
  replies?: ScriptLine[];
}

export interface TopicScript {
  id: string;
  /**
   * Only for a conversation queued with this `trigger_reason` (the social-call
   * scripts, data/socialCallScripts.ts); such a script is played first, ahead of
   * the weighted draw, and is not held to the pair's per-topic cooldown.
   */
  trigger?: string;
  /**
   * Also for a hostile pair. Most topics assume goodwill ("Can I buy you a
   * drink?"); a pair that can't stand each other gets the standoff, or at
   * most grumbles about the weather or the day.
   */
  hostileOk?: boolean;
  /** GAME HOURS before this pair can have this topic again (template_usage). */
  cooldownHours: number;
  when: (c: ChatContext) => boolean;
  /** Relative pick weight among eligible scripts: rarer, more grounded topics weigh more. */
  weight: (c: ChatContext) => number;
  /** Conversation topic label (feed, memory: "X and I talked about <topic>"). */
  topic: (c: ChatContext) => string;
  /** Lower-case words every line of this script contains at least one of. */
  anchors: (c: ChatContext) => string[];
  openers: OpenerLine[];
  react?: ScriptLine[];
  /** Acknowledgements for the follow-up, when FOLLOW_ACKS would strike the wrong note. */
  acks?: Record<Stance, ScriptLine[]>;
  follow?: ScriptLine[];
  close: ScriptLine[];
}

/**
 * The acknowledgement that starts a follow-up, keyed by the stance of the
 * reply it answers. It is what makes the third line a response rather than a
 * second opener.
 */
export const FOLLOW_ACKS: Record<Stance, ScriptLine[]> = {
  agree: [
    { text: 'Exactly.', s: 0.2 },
    { text: 'My thoughts too.', s: 0.2 },
    { text: 'True enough.', s: 0.1 },
    { text: 'Aye.', s: 0.1, voice: ['gruff'] },
  ],
  disagree: [
    { text: 'Maybe so.', s: 0 },
    { text: 'If you say so.', s: -0.1 },
    { text: 'Each to their own.', s: 0 },
    { text: 'Suit yourself.', s: -0.2, tone: ['cool'] },
  ],
  neutral: [
    { text: 'Mm.', s: 0 },
    { text: 'Fair enough.', s: 0.1 },
    { text: 'I suppose so.', s: 0 },
  ],
};

// ─── helpers for `when` ──────────────────────────────────────────────────────

const is = (...values: string[]) => (v: string | null | undefined) => v != null && values.includes(v);
const wet = is('rainy', 'stormy');
const sunny = is('sunny', 'hot');
const grey = is('cloudy', 'foggy');
const PUBLIC_DRINKING = is('tavern', 'divebar');
const SHOPS = is('shop', 'pawnshop', 'market_square');
const FARMS = is('farm', 'farmyard');
const HOMES = is('home', 'house');
const EVENINGISH = is('afternoon', 'evening', 'night');
/** Not hostile: friendly scripts need the opener at least neutral. */
const civil = (c: ChatContext) => c.people[0].friendship >= -10;
/** The line is said by the person who opened the chat. */
const byOpener = (c: ChatContext, me: ChatPerson) => me === c.people[0];
const hostile = (c: ChatContext) =>
  c.people[0].friendship < -10 || c.status === 'rivals' || c.status === 'enemies';

// ─── scripts ─────────────────────────────────────────────────────────────────

export const SMALL_TALK_SCRIPTS: TopicScript[] = [
  // ===== weather: rain and storms =====
  {
    id: 'weather_wet',
    hostileOk: true,
    cooldownHours: 8,
    when: (c) => wet(c.weather),
    weight: () => 3,
    topic: (c) => (c.weather === 'stormy' ? 'the storm' : 'the rain'),
    anchors: () => ['rain', 'wet', 'dry', 'puddle', 'downpour', 'storm', 'mud', 'soak', 'thunder'],
    openers: [
      {
        kind: 'ask', text: 'Is this rain ever going to let up, {you}?', s: -0.1,
        replies: [
          { text: "Not today, by the look of those clouds. The rain's settled in.", s: -0.1, stance: 'neutral' },
          { text: "I doubt it. Mind the puddles on your way home.", s: 0.1, stance: 'neutral', tone: ['warm', 'neutral'] },
          { text: 'Rain or no rain, the work still waits.', s: -0.2, stance: 'disagree', voice: ['gruff'] },
          { text: 'Let it rain. The gardens need it.', s: 0.2, stance: 'disagree', voice: ['bubbly', 'warm'] },
        ],
      },
      {
        kind: 'ask', text: 'Did you get caught in that downpour?', s: 0,
        replies: [
          { text: "Right in the middle of it. I'm still drying out.", s: -0.1, stance: 'agree' },
          { text: 'No, I ducked under an awning before the rain got heavy.', s: 0.1, stance: 'neutral' },
          { text: 'Soaked to the bone, thanks for asking.', s: -0.3, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'ask', text: "Don't you love the smell of the rain?", s: 0.3, voice: ['bubbly', 'warm'],
        replies: [
          { text: "I do, as long as I'm watching it from somewhere dry.", s: 0.3, stance: 'agree' },
          { text: "Can't say I do. It just smells like wet mud to me.", s: -0.1, stance: 'disagree' },
        ],
      },
      {
        kind: 'ask', text: 'Did the storm keep you up last night?', s: -0.1,
        when: (c) => c.weather === 'stormy',
        replies: [
          { text: 'Half the night. That thunder rattled every window.', s: -0.2, stance: 'agree' },
          { text: 'I slept right through the storm, believe it or not.', s: 0.1, stance: 'disagree' },
        ],
      },
      { kind: 'tell', text: 'This rain has turned every road into mud.', s: -0.2 },
      { kind: 'tell', text: "I'm soaked right through. That rain came out of nowhere.", s: -0.2, when: (c) => c.place.setting === 'outdoor' },
      { kind: 'tell', text: 'Listen to that rain on the roof.', s: 0.1, when: (c) => c.place.setting === 'indoor' },
    ],
    react: [
      { text: "Mm, and it doesn't look like the rain will stop soon.", s: -0.1, stance: 'neutral' },
      { text: 'Better the rain now than a drought at harvest.', s: 0.2, stance: 'disagree' },
      { text: 'Tell me about it. My boots are still wet from this morning.', s: -0.1, stance: 'agree' },
      { text: "It's rain. It falls. Nothing to be done about it.", s: -0.2, stance: 'disagree', voice: ['gruff'] },
    ],
    follow: [
      { text: 'The ditches by the road will overflow if this rain keeps up.', s: -0.1 },
      { text: 'At least the gardens are getting a proper drink from all this rain.', s: 0.2 },
      { text: "I'd give anything for a dry pair of socks.", s: -0.1 },
    ],
    close: [
      { text: 'Well, try to stay dry, {you}.', s: 0.2 },
      { text: "I'd best make a run for it before the rain gets worse.", s: 0 },
      { text: "Watch your step out there. The mud's everywhere.", s: 0.1 },
    ],
  },

  // ===== weather: sun and heat =====
  {
    id: 'weather_sun',
    hostileOk: true,
    cooldownHours: 8,
    // "Isn't this sun glorious?" at night is the wrong kind of grounded.
    when: (c) => sunny(c.weather) && c.dayPhase !== 'evening' && c.dayPhase !== 'night',
    weight: () => 3,
    topic: (c) => (c.weather === 'hot' ? 'the heat' : 'the sunshine'),
    anchors: () => ['sun', 'heat', 'hot', 'shade', 'sky', 'scorch', 'warm'],
    openers: [
      {
        kind: 'ask', text: "Isn't this sun glorious, {you}?", s: 0.5, when: (c) => c.weather === 'sunny',
        replies: [
          { text: 'It is. A bit of sun puts the whole town in a good mood.', s: 0.4, stance: 'agree' },
          { text: "It's pleasant enough, until the afternoon sun gets going.", s: 0.1, stance: 'neutral' },
          { text: 'Too bright for my eyes. I prefer a bit of shade.', s: -0.1, stance: 'disagree', voice: ['gruff', 'shy'] },
        ],
      },
      {
        kind: 'ask', text: 'Is this heat getting to you too?', s: -0.1, when: (c) => c.weather === 'hot',
        replies: [
          { text: "Terribly. I've been hunting for shade all day.", s: -0.2, stance: 'agree' },
          { text: "I've known worse heat than this, honestly.", s: 0.1, stance: 'disagree' },
        ],
      },
      {
        kind: 'ask', text: 'Shall we find some shade? This sun is strong.', s: 0.2,
        when: (c) => c.place.setting === 'outdoor' && c.people[0].friendship >= 10,
        replies: [
          { text: 'Good idea, before we both get scorched.', s: 0.3, stance: 'agree' },
          { text: "I'd rather stay in the sun a while longer.", s: 0.1, stance: 'disagree' },
        ],
      },
      { kind: 'tell', text: 'Not a cloud in the sky today.', s: 0.4, when: (c) => c.weather === 'sunny' },
      { kind: 'tell', text: "Shame to be stuck indoors when the sun's out like this.", s: 0, when: (c) => c.place.setting === 'indoor' },
      { kind: 'tell', text: "It's so hot I could fry an egg on the doorstep.", s: -0.1, when: (c) => c.weather === 'hot' },
    ],
    react: [
      { text: "The sun's doing everyone good.", s: 0.3, stance: 'agree' },
      { text: 'Enjoy the sun while it lasts, I say.', s: 0.2, stance: 'neutral' },
      { text: 'Too much sun for my liking.', s: -0.1, stance: 'disagree' },
    ],
    follow: [
      { text: 'The washing will dry in an hour in this sun.', s: 0.2 },
      { text: 'Everyone in town seems to be out in the sun today.', s: 0.2 },
      { text: "I'll want a cold drink before this heat is done.", s: 0, when: (c) => c.weather === 'hot' },
    ],
    close: [
      { text: "Don't get too much sun, {you}.", s: 0.2 },
      { text: 'Enjoy the sunshine.', s: 0.3 },
      { text: "I'm off to find some shade.", s: 0.1 },
    ],
  },

  // ===== weather: cloud and fog =====
  {
    id: 'weather_grey',
    hostileOk: true,
    cooldownHours: 8,
    when: (c) => grey(c.weather),
    weight: () => 2,
    topic: (c) => (c.weather === 'foggy' ? 'the fog' : 'the grey sky'),
    anchors: () => ['cloud', 'grey', 'fog', 'gloom', 'sky', 'sun'],
    openers: [
      {
        kind: 'ask', text: 'Think those clouds will break before evening?', s: 0,
        when: (c) => c.weather === 'cloudy' && c.dayPhase !== 'evening' && c.dayPhase !== 'night',
        replies: [
          { text: "I wouldn't count on it. The sky's been grey all day.", s: -0.1, stance: 'agree' },
          { text: "They might. There's a patch of blue sky over the hills.", s: 0.2, stance: 'disagree' },
        ],
      },
      {
        kind: 'ask', text: 'Could you see a thing in that fog this morning?', s: 0, when: (c) => c.weather === 'foggy',
        replies: [
          { text: 'Barely my own hands. I nearly walked into a fence in the fog.', s: 0, stance: 'agree' },
          { text: "It's thinning now, at least. The fog never lasts past noon.", s: 0.1, stance: 'neutral' },
        ],
      },
      { kind: 'tell', text: 'Another grey day. I could do with some sun.', s: -0.1, when: (c) => c.weather === 'cloudy' },
      {
        kind: 'tell', text: 'This fog is so thick I nearly walked straight past you.', s: 0.1,
        when: (c) => c.weather === 'foggy' && c.place.setting === 'outdoor',
        replies: [
          { text: 'I heard you before I saw you in this fog.', s: 0.1, stance: 'agree' },
          { text: "Then it's lucky we didn't walk into each other in the fog.", s: 0.2, stance: 'neutral' },
        ],
      },
    ],
    react: [
      { text: 'Grey skies do make everyone a bit glum.', s: -0.1, stance: 'agree' },
      { text: "I don't mind a grey day. It's restful.", s: 0.2, stance: 'disagree' },
      { text: 'The clouds will clear eventually.', s: 0.1, stance: 'neutral' },
    ],
    follow: [
      { text: 'The whole town feels quieter under this grey sky.', s: 0 },
      { text: 'My knees always ache when the clouds hang low like this.', s: -0.1, when: (c) => c.weather === 'cloudy' },
      { text: 'Sounds carry strangely in the fog, have you noticed?', s: 0, when: (c) => c.weather === 'foggy' },
    ],
    close: [
      { text: "Don't lose your way in the gloom, {you}.", s: 0.1 },
      { text: "Here's hoping for sun tomorrow.", s: 0.2 },
    ],
  },

  // ===== weather: snow =====
  {
    id: 'weather_cold',
    hostileOk: true,
    cooldownHours: 8,
    when: (c) => c.weather === 'snowy',
    weight: () => 3,
    topic: () => 'the snow',
    anchors: () => ['snow', 'cold', 'freez', 'frost', 'winter', 'warm', 'fire'],
    openers: [
      {
        kind: 'ask', text: 'Have you ever seen this much snow, {you}?', s: 0.1,
        replies: [
          { text: "Not since I was a child. The snow's up to the fence posts.", s: 0.1, stance: 'agree' },
          { text: "Plenty of times. This winter's nothing special.", s: -0.1, stance: 'disagree', voice: ['gruff', 'plain'] },
        ],
      },
      {
        kind: 'ask', text: 'Is your hearth keeping up with this cold?', s: 0,
        replies: [
          { text: "Barely. I'm burning wood faster than I can split it in this cold.", s: -0.2, stance: 'agree' },
          { text: "It's warm enough, if I sit right by the fire.", s: 0.1, stance: 'neutral' },
        ],
      },
      { kind: 'tell', text: "I can't feel my fingers in this cold.", s: -0.2 },
      { kind: 'tell', text: "Look at the snow on the rooftops. It's beautiful.", s: 0.3, when: (c) => c.place.setting === 'outdoor' },
    ],
    react: [
      { text: "Winter's properly here now.", s: 0, stance: 'neutral' },
      { text: 'Nothing a hot bowl of soup by the fire won\'t fix.', s: 0.2, stance: 'disagree' },
      { text: 'The cold gets right into your bones, doesn\'t it?', s: -0.1, stance: 'agree' },
    ],
    follow: [
      { text: 'The children will be out sledding in the snow by noon.', s: 0.3 },
      { text: "I've put an extra blanket on the bed against the cold.", s: 0 },
    ],
    close: [
      { text: 'Keep warm, {you}.', s: 0.2 },
      { text: "I'd better get back to the fire before I freeze.", s: 0.1 },
    ],
  },

  // ===== weather: wind =====
  {
    id: 'weather_wind',
    hostileOk: true,
    cooldownHours: 8,
    when: (c) => c.weather === 'windy',
    weight: () => 3,
    topic: () => 'the wind',
    anchors: () => ['wind', 'gust', 'blow', 'breeze', 'shutter'],
    openers: [
      {
        kind: 'ask', text: 'Did the wind take anything off your roof last night?', s: -0.1,
        replies: [
          { text: 'A few shingles. That wind was fierce.', s: -0.2, stance: 'agree' },
          { text: 'Not a thing, thankfully. The wind spared our side of town.', s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'Hear that wind rattling the shutters?', s: -0.1, when: (c) => c.place.setting === 'indoor',
        replies: [
          { text: "I do. The shutters have been banging since dawn.", s: -0.1, stance: 'agree' },
          { text: "It's only wind. This place has stood through worse.", s: 0.1, stance: 'disagree' },
        ],
      },
      { kind: 'tell', text: 'This wind is relentless today.', s: -0.1 },
      { kind: 'tell', text: "Hold onto your hat, {you}. The wind's picking up.", s: 0, when: (c) => c.place.setting === 'outdoor' },
    ],
    react: [
      { text: "It's blowing straight off the hills today.", s: -0.1, stance: 'neutral' },
      { text: 'A good breeze clears the air, I suppose.', s: 0.1, stance: 'disagree' },
      { text: 'Tell me about it. The wind nearly took my hat twice.', s: -0.1, stance: 'agree' },
    ],
    follow: [
      { text: "Somebody's washing is going to end up three streets over in this wind.", s: 0.1 },
      { text: 'The mill will be turning at full speed with a wind like this.', s: 0.1 },
    ],
    close: [
      { text: 'Mind the gusts on your way, {you}.', s: 0.1 },
      { text: "I'm getting out of this wind.", s: 0 },
    ],
  },

  // ===== the day itself (always available: the fallback topic) =====
  {
    id: 'the_day',
    hostileOk: true,
    cooldownHours: 6,
    when: () => true,
    weight: () => 1,
    topic: () => 'the day',
    anchors: () => ['morning', 'afternoon', 'evening', 'night', 'day', 'dawn', 'early', 'late'],
    openers: [
      {
        kind: 'ask', text: 'Early start today, {you}?', s: 0.1, when: (c) => c.dayPhase === 'morning' || c.dayPhase === 'dawn',
        replies: [
          { text: "Since before dawn. The morning's half gone already.", s: -0.1, stance: 'agree' },
          { text: 'Not so early. I lingered over breakfast this morning.', s: 0.2, stance: 'disagree' },
        ],
      },
      {
        kind: 'ask', text: 'Getting through the afternoon all right?', s: 0.1, when: (c) => c.dayPhase === 'afternoon',
        replies: [
          { text: 'Just about. This afternoon is dragging.', s: -0.1, stance: 'agree' },
          { text: 'Better than the morning, at least.', s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'Heading home for the evening?', s: 0.1, when: (c) => c.dayPhase === 'evening',
        replies: [
          { text: "Soon. It's been a long day.", s: -0.1, stance: 'agree' },
          { text: "Not yet. The evening's still young.", s: 0.2, stance: 'disagree' },
        ],
      },
      {
        kind: 'ask', text: "Out late tonight, aren't you?", s: 0, when: (c) => c.dayPhase === 'night',
        replies: [
          { text: "Couldn't sleep. The night air helps.", s: 0, stance: 'neutral' },
          { text: "Late? The night's barely started.", s: 0.2, stance: 'disagree', voice: ['bubbly', 'gruff'] },
        ],
      },
      { kind: 'tell', text: "The day's flown by, hasn't it?", s: 0.1 },
      { kind: 'tell', text: 'What a long day it has been.', s: -0.1 },
    ],
    react: [
      { text: 'Tell me about it. This day has lasted a week.', s: -0.1, stance: 'agree' },
      { text: "It's not over yet. The day could still surprise us.", s: 0.2, stance: 'disagree' },
      { text: 'One day is much like another, for me.', s: 0, stance: 'neutral', voice: ['gruff', 'shy', 'plain'] },
    ],
    follow: [
      { text: "I'll be glad to put my feet up at the end of the day.", s: 0.1 },
      { text: "Tomorrow can't be any longer than today.", s: 0 },
    ],
    close: [
      { text: 'Enjoy the rest of your day, {you}.', s: 0.3, when: (c) => c.dayPhase !== 'night' },
      { text: 'Have a good evening, {you}.', s: 0.3, when: (c) => c.dayPhase === 'evening' },
      { text: 'Good night, {you}.', s: 0.2, when: (c) => c.dayPhase === 'night' },
      { text: "Well, the day won't wait for us.", s: 0 },
    ],
  },

  // ===== the place they're in =====
  {
    id: 'place',
    cooldownHours: 10,
    when: (c) => c.place.speakable && !HOMES(c.place.type) && c.place.type !== 'prison' && civil(c),
    weight: () => 2,
    topic: (c) => c.place.name,
    anchors: (c) => [c.place.name.toLowerCase()],
    openers: [
      {
        kind: 'ask', text: 'Do you come to {place} often, {you}?', s: 0.2,
        when: (_c, _me, you) => !you.atWork,
        replies: [
          { text: 'Often enough. {place} is on my way most days.', s: 0.1, stance: 'neutral' },
          { text: "Not as often as I'd like. {place} is a nice spot.", s: 0.3, stance: 'agree' },
          { text: 'Only when I have to. {place} is too crowded for me.', s: -0.1, stance: 'disagree', voice: ['shy', 'gruff'] },
        ],
      },
      {
        kind: 'ask', text: 'Busy at {place} today, isn\'t it?', s: 0,
        replies: [
          { text: "Busier than I'd like. I can barely hear myself think in {place}.", s: -0.1, stance: 'agree' },
          { text: "I like {place} busy. There's always someone to talk to.", s: 0.3, stance: 'disagree', voice: ['bubbly', 'warm'] },
        ],
      },
      {
        kind: 'tell', text: '{place} is quieter than usual today.', s: 0,
        replies: [
          { text: 'I noticed that too. {place} feels half empty.', s: 0, stance: 'agree' },
          { text: 'Quiet suits {place}, if you ask me.', s: 0.2, stance: 'disagree' },
        ],
      },
      {
        kind: 'tell', text: "I've always liked {place} at this time of day.", s: 0.3,
        replies: [
          { text: "So have I. There's no better spot than {place}.", s: 0.3, stance: 'agree' },
          { text: "Really? {place} has never done much for me.", s: -0.1, stance: 'disagree' },
        ],
      },
    ],
    follow: [
      { text: 'I remember when {place} looked quite different.', s: 0.1 },
      { text: 'Half the town passes through {place} sooner or later.', s: 0.1 },
    ],
    close: [
      { text: "I'll leave you to enjoy {place}, {you}.", s: 0.2 },
      { text: 'I expect I\'ll see you around {place}.', s: 0.1 },
    ],
  },

  // ===== a drink at the tavern =====
  {
    id: 'tavern_drink',
    cooldownHours: 6,
    when: (c) => PUBLIC_DRINKING(c.place.type) && EVENINGISH(c.dayPhase) && civil(c),
    weight: () => 4,
    topic: (c) => `a drink at ${c.place.speakable ? c.place.name : 'the tavern'}`,
    anchors: () => ['drink', 'ale', 'cider', 'glass', 'round', 'bar', 'cheers', 'pour'],
    openers: [
      {
        kind: 'ask', text: 'What are you drinking tonight, {you}?', s: 0.3,
        replies: [
          { text: "Just a cider. I've an early start tomorrow.", s: 0.1, stance: 'neutral' },
          { text: "Whichever ale is cheapest. It's been a long week.", s: -0.1, stance: 'agree' },
          { text: 'Same drink as always, same as every night.', s: -0.1, stance: 'disagree', voice: ['gruff'] },
        ],
      },
      {
        kind: 'ask', text: 'Can I buy you a drink, {you}?', s: 0.5, when: (c) => c.people[0].friendship >= 20,
        replies: [
          { text: "I'd never say no to a free drink. Thank you!", s: 0.5, stance: 'agree' },
          { text: "Kind of you, but I'm making this glass last.", s: 0.1, stance: 'neutral' },
          { text: 'I can buy my own drinks, thanks.', s: -0.3, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'ask', text: "Has {bartender} poured you one of the good ales yet?", s: 0.3,
        replies: [
          { text: "Twice already. {bartender} pours a dangerous glass.", s: 0.4, stance: 'agree' },
          { text: "Not yet. I've stuck to cider tonight.", s: 0.1, stance: 'neutral' },
        ],
      },
      { kind: 'tell', text: 'Nothing like a drink after a long day.', s: 0.4 },
      {
        kind: 'tell', text: 'I just needed to get out of the house for a drink tonight.', s: -0.2,
        when: (_c, me) => me.mood < 45,
        replies: [
          { text: "Then this drink is on me. Sit down.", s: 0.4, stance: 'agree', tone: ['warm'] },
          { text: "I know the feeling. That's what the bar is for.", s: 0.1, stance: 'agree' },
        ],
      },
    ],
    react: [
      { text: "I'll drink to that.", s: 0.4, stance: 'agree' },
      { text: 'Just the one drink for me tonight.', s: 0, stance: 'neutral' },
      { text: 'Careful, the ale here sneaks up on you.', s: 0.1, stance: 'disagree' },
    ],
    follow: [
      { text: "The bar's fuller than I've seen it all week.", s: 0.2 },
      { text: "I think I'll have one more round before I head home.", s: 0.2 },
    ],
    close: [
      { text: 'Cheers, {you}. Enjoy your drink.', s: 0.4 },
      { text: "I'll leave you to your glass.", s: 0.1 },
      { text: 'Next round is on you, {you}.', s: 0.3, when: (_c, me) => me.friendship >= 20 },
    ],
  },

  // ===== shopping =====
  {
    id: 'shopping',
    cooldownHours: 6,
    when: (c) => SHOPS(c.place.type) && civil(c),
    weight: () => 3,
    topic: () => 'prices',
    anchors: () => ['price', 'buy', 'coin', 'shelf', 'shelves', 'stock', 'basket', 'cost', 'shop', 'spend', 'charg'],
    openers: [
      {
        kind: 'ask', text: 'Found anything worth buying, {you}?', s: 0.2, when: (_c, _me, you) => !you.atWork,
        replies: [
          { text: 'A few things. Prices are steep this week though.', s: -0.1, stance: 'neutral' },
          { text: 'Just flour and salt in my basket. Nothing exciting.', s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: "Have you seen what they're charging for eggs now?", s: -0.1,
        replies: [
          { text: "I have. At these prices I'll keep my own hens.", s: -0.2, stance: 'agree' },
          { text: "It's the same price as last month, I think.", s: 0, stance: 'disagree' },
        ],
      },
      { kind: 'tell', text: "I only came in for thread and I've filled a whole basket.", s: 0.3 },
      { kind: 'tell', text: "I'll have to buy the cheapest of everything. Coin is tight.", s: -0.3, when: (_c, me) => me.mood < 45 },
    ],
    react: [
      { text: 'The shelves are well stocked today, at least.', s: 0.2, stance: 'neutral' },
      { text: 'Everything costs more than it used to.', s: -0.2, stance: 'agree' },
      { text: "It's always the way when you go in to buy one thing.", s: 0.2, stance: 'agree' },
    ],
    follow: [
      { text: 'I swear the prices change every time I walk in.', s: -0.1 },
      { text: "I'd better not spend another coin today.", s: 0 },
    ],
    close: [
      { text: 'Happy shopping, {you}.', s: 0.3 },
      { text: "Don't spend all your coin in one place.", s: 0.2 },
    ],
  },

  // ===== the bakery =====
  {
    id: 'bakery',
    cooldownHours: 8,
    when: (c) => c.place.type === 'bakery' && civil(c),
    weight: () => 3,
    topic: () => 'bread',
    anchors: () => ['bread', 'loaf', 'loaves', 'oven', 'flour', 'bun', 'baking'],
    openers: [
      {
        kind: 'ask', text: "Doesn't the bread smell wonderful in here?", s: 0.4,
        replies: [
          { text: 'It does. I could eat a whole loaf standing here.', s: 0.4, stance: 'agree' },
          { text: "I've stopped noticing. I'm in here every morning for my loaf.", s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: "Have you tried {baker}'s rye loaf?", s: 0.4,
        replies: [
          { text: "Every week. {baker}'s rye is the best bread in town.", s: 0.5, stance: 'agree' },
          { text: 'Not yet. I always end up with the white loaf.', s: 0, stance: 'neutral' },
        ],
      },
      { kind: 'tell', text: 'The ovens must have been going since before dawn.', s: 0.2 },
    ],
    react: [
      { text: 'Fresh bread is the best part of the morning.', s: 0.4, stance: 'agree' },
      { text: 'Somebody has to get up early to bake all this bread.', s: 0.1, stance: 'neutral' },
    ],
    follow: [
      { text: "I'll take a warm loaf home if there are any left.", s: 0.3 },
      { text: "I've never managed to bake bread half this good myself.", s: 0.2 },
    ],
    close: [
      { text: 'Enjoy your bread, {you}.', s: 0.3 },
      { text: 'Save me a bun next time.', s: 0.3 },
    ],
  },

  // ===== the farm =====
  {
    id: 'farm',
    cooldownHours: 8,
    when: (c) => FARMS(c.place.type) && civil(c),
    weight: () => 3,
    topic: () => 'the crops',
    anchors: () => ['crop', 'field', 'harvest', 'soil', 'barley', 'row', 'hoe'],
    openers: [
      {
        kind: 'ask', text: 'How are the crops coming along this year?', s: 0.2,
        replies: [
          { text: "Better than last year. The barley's standing tall.", s: 0.3, stance: 'agree' },
          { text: "Slowly. The soil's been stubborn this season.", s: -0.1, stance: 'disagree' },
        ],
      },
      {
        kind: 'ask', text: 'Need a hand in the field, {you}?', s: 0.3, when: (_c, _me, you) => you.atWork,
        replies: [
          { text: "I'd never turn down help in the field. Grab a hoe.", s: 0.4, stance: 'agree' },
          { text: "Kind of you, but the field's nearly done for today.", s: 0.1, stance: 'neutral' },
        ],
      },
      { kind: 'tell', text: 'The fields look good from the road today.', s: 0.3 },
    ],
    react: [
      { text: "It's been a decent season for the crops so far.", s: 0.2, stance: 'agree' },
      { text: "Don't speak too soon. The harvest isn't in yet.", s: 0, stance: 'disagree' },
    ],
    follow: [
      { text: "If the weather holds we'll have a fine harvest.", s: 0.3 },
      { text: 'My back aches just looking at all these rows.', s: -0.1 },
    ],
    close: [
      { text: "Don't work the field too hard, {you}.", s: 0.2 },
      { text: 'Good luck with the harvest.', s: 0.3 },
    ],
  },

  // ===== the clinic =====
  {
    id: 'clinic',
    cooldownHours: 8,
    when: (c) => c.place.type === 'clinic' && civil(c) && !c.people[0].atWork && !c.people[1].atWork,
    weight: () => 3,
    topic: () => 'feeling poorly',
    anchors: () => ['clinic', 'cough', 'medicine', 'better', 'doctor', 'poorly', 'wait'],
    openers: [
      {
        kind: 'ask', text: 'Are you at the clinic for yourself, {you}?', s: 0,
        replies: [
          { text: "Just a cough that won't go away.", s: -0.1, stance: 'neutral' },
          { text: "No, I'm picking up medicine for a neighbour.", s: 0.1, stance: 'neutral' },
        ],
      },
      { kind: 'tell', text: 'The wait at the clinic is longer than ever today.', s: -0.2 },
    ],
    react: [
      { text: 'Half the town seems to be feeling poorly this week.', s: -0.2, stance: 'agree' },
      { text: "At least the clinic is warm while we wait.", s: 0.1, stance: 'disagree' },
    ],
    follow: [
      { text: 'I just hope the medicine does its job quickly.', s: 0 },
      { text: 'The doctor works harder than anyone in town.', s: 0.2 },
    ],
    close: [
      { text: 'Feel better soon, {you}.', s: 0.3 },
      { text: "I hope the wait isn't too long for you.", s: 0.1 },
    ],
  },

  // ===== the listener's work =====
  {
    id: 'work',
    cooldownHours: 10,
    when: (c) => civil(c) && (c.people[1].atWork || c.people[1].job != null),
    weight: (c) => (c.people[1].atWork ? 3 : 1.5),
    topic: () => 'work',
    anchors: (c) => ['work', 'shift', ...[c.people[1].job, c.people[1].workplace].filter((s): s is string => !!s).map((s) => s.toLowerCase())],
    openers: [
      {
        kind: 'ask', text: 'Busy shift at {work}, {you}?', s: 0.1, when: (_c, _me, you) => you.atWork,
        replies: [
          { text: "Non-stop since I opened up. Work never ends at {work}.", s: -0.1, stance: 'agree' },
          { text: "Quiet, for once. I've almost caught up on my work.", s: 0.2, stance: 'disagree' },
        ],
      },
      {
        kind: 'ask', text: 'How is the work treating you these days?', s: 0.2, when: (_c, _me, you) => you.job != null,
        replies: [
          { text: "Can't complain. There's always work for a {job} in this town.", s: 0.2, stance: 'neutral' },
          { text: "Honestly, the work's been wearing me down lately.", s: -0.3, stance: 'agree', when: (_c, me) => me.mood < 50 },
          { text: 'I love the work, most days. Being a {job} suits me.', s: 0.4, stance: 'disagree', when: (_c, me) => me.mood >= 50 },
          { text: "It pays. That's about all I'll say about the work.", s: -0.1, stance: 'neutral', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: "I've been at work since first light.", s: -0.1, when: (_c, me) => me.job != null,
        replies: [
          { text: "You've earned a sit-down after that much work.", s: 0.3, stance: 'agree', tone: ['warm', 'neutral'] },
          { text: "Work doesn't wait for anyone, does it.", s: 0, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: 'Some days the work feels like it will never end.', s: -0.1 },
      { text: "I'll be glad when this shift is over.", s: 0 },
    ],
    close: [
      // The work is the listener's: only the opener sends them back to it.
      { text: "Don't let the work grind you down, {you}.", s: 0.2, when: byOpener },
      { text: "I'll let you get back to work.", s: 0.1, when: byOpener },
      { text: "Well, this work won't do itself.", s: 0, when: (c, me) => !byOpener(c, me) },
    ],
  },

  // ===== someone looks tired (either side) =====
  {
    id: 'tired',
    cooldownHours: 8,
    when: (c) => civil(c) && (c.people[0].energy < 35 || c.people[1].energy < 35),
    weight: () => 4,
    topic: () => 'being tired',
    anchors: () => ['tired', 'sleep', 'rest', 'worn', 'exhaust', 'bed'],
    openers: [
      {
        kind: 'ask', text: 'You look worn out, {you}. Long day?', s: 0, when: (_c, _me, you) => you.energy < 35,
        replies: [
          { text: 'The longest. I could sleep standing up.', s: -0.2, stance: 'agree' },
          { text: "That obvious? I've hardly had any sleep.", s: -0.1, stance: 'neutral' },
          { text: "I'm fine. Just tired, that's all.", s: -0.2, stance: 'disagree', voice: ['gruff', 'shy'] },
        ],
      },
      {
        kind: 'ask', text: 'Have you been getting any sleep, {you}?', s: 0.1,
        when: (_c, me, you) => you.energy < 35 && me.friendship >= 20,
        replies: [
          { text: "Not much. My head won't rest at night.", s: -0.2, stance: 'agree' },
          { text: 'A few hours of sleep. It will have to do.', s: -0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "Forgive me, I'm half asleep on my feet.", s: -0.1, when: (_c, me) => me.energy < 35,
        replies: [
          { text: 'You do look tired. Sit down a moment.', s: 0.2, stance: 'agree', tone: ['warm', 'neutral'] },
          { text: 'Then get yourself to bed early tonight.', s: 0.1, stance: 'neutral' },
          { text: "We're all tired, believe me.", s: -0.1, stance: 'disagree', voice: ['gruff'] },
        ],
      },
      {
        kind: 'tell', text: "I've been up since before dawn and I'm exhausted.", s: -0.2, when: (_c, me) => me.energy < 35,
        replies: [
          { text: "No wonder you're tired. Go and rest.", s: 0.2, stance: 'agree' },
          { text: 'Sleep will fix that. Early to bed tonight.', s: 0.1, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: 'A good night of sleep fixes most things.', s: 0.1 },
      { text: "I'll be in bed the minute I get home.", s: 0, when: (_c, me) => me.energy < 35 },
      { text: "You should get to bed early tonight.", s: 0.1, when: (_c, _me, you) => you.energy < 35 },
    ],
    close: [
      { text: 'Get some rest, {you}.', s: 0.3, when: (_c, _me, you) => you.energy < 35 },
      { text: "I'm off to rest before I fall over.", s: 0, when: (_c, me) => me.energy < 35 },
      { text: 'Sleep well tonight, {you}.', s: 0.2 },
    ],
  },

  // ===== the listener looks unhappy =====
  {
    id: 'rough_day',
    // "Exactly." after "Everything's gone wrong" would be cruel.
    acks: {
      agree: [{ text: "I'm sorry to hear it.", s: 0.2 }, { text: 'That sounds hard.', s: 0.1 }],
      disagree: [{ text: "All right, I won't pry.", s: 0.1 }, { text: 'If you say so.', s: 0 }],
      neutral: [{ text: 'I understand.', s: 0.1 }, { text: "I'm sorry to hear it.", s: 0.2 }],
    },
    cooldownHours: 10,
    when: (c) => c.people[1].mood < 30 && c.people[0].friendship >= 0,
    weight: () => 4,
    topic: () => 'a rough day',
    anchors: () => ['wrong', 'rough', 'down', 'mind', 'trouble', 'worr'],
    openers: [
      {
        kind: 'ask', text: 'You seem out of sorts, {you}. Is something wrong?', s: 0.1,
        replies: [
          { text: "It's nothing I want to talk about. Just a rough day.", s: -0.3, stance: 'neutral' },
          { text: "Is it that obvious? Everything's gone wrong this week.", s: -0.4, stance: 'agree' },
          { text: "I'm fine. Really. Just a lot on my mind.", s: -0.2, stance: 'disagree', voice: ['gruff', 'shy', 'plain'] },
        ],
      },
      {
        kind: 'ask', text: 'Rough day? You look like something is weighing on your mind.', s: 0.1,
        when: (_c, me) => me.friendship >= 20,
        replies: [
          { text: "More than one thing is on my mind, if I'm honest.", s: -0.3, stance: 'agree' },
          { text: "It'll pass. It's nothing but a rough patch.", s: -0.1, stance: 'disagree' },
        ],
      },
    ],
    follow: [
      { text: "If you want to talk about what's wrong, you know where to find me.", s: 0.3 },
      { text: 'Rough days pass. They always do.', s: 0.2 },
    ],
    close: [
      // Comfort goes to the one having the rough day; they answer with thanks.
      { text: "Don't let it get you down, {you}.", s: 0.2, when: byOpener },
      { text: "Try not to worry too much, {you}.", s: 0.2, when: byOpener },
      { text: "Thank you. I'll try not to let it get me down.", s: 0.1, when: (c, me) => !byOpener(c, me) },
    ],
  },

  // ===== the listener is grieving =====
  // Before this, a widow at mood 35 (`rough_day` needs < 30) got "Lovely day!" from the
  // sunny-weather script. Every line here is said gently: a grieving speaker comes across
  // cool (`toneOf`), so their side keeps to s <= 0.1, and the opener's lines are quiet too.
  {
    id: 'condolence',
    // "Exactly." after "I miss them dreadfully" would be cruel.
    acks: {
      agree: [{ text: 'I know.', s: 0 }, { text: 'Of course.', s: 0.1 }],
      disagree: [{ text: "I won't press you.", s: 0.1 }, { text: 'Forgive me for asking.', s: 0 }],
      neutral: [{ text: 'Take all the time you need.', s: 0.1 }, { text: 'I understand.', s: 0.1 }],
    },
    cooldownHours: 12,
    when: (c) => civil(c) && isGrieving(c.people[1]),
    weight: () => 8,
    topic: () => 'a loss',
    anchors: () => ['loss', 'sorry', 'miss'],
    openers: [
      {
        kind: 'ask', text: "I'm so sorry, {you}. How are you bearing up?", s: 0.1,
        replies: [
          { text: 'Some hours are easier than others. I miss them dreadfully.', s: -0.2, stance: 'agree' },
          { text: 'One day at a time. The loss is still very new.', s: -0.1, stance: 'neutral' },
          { text: "I'd sooner not speak of the loss, if it's all the same.", s: -0.2, stance: 'disagree', voice: ['gruff', 'shy', 'plain'] },
        ],
      },
      {
        kind: 'ask', text: "Have you eaten today, {you}? Forgive me, I'm sorry to fuss.", s: 0.1,
        when: (_c, me) => me.friendship >= 20,
        replies: [
          { text: "A little. I've had no appetite since the loss.", s: -0.2, stance: 'neutral' },
          { text: 'Not really. Food tastes of nothing, and I miss them at every meal.', s: -0.2, stance: 'agree' },
        ],
      },
      {
        kind: 'tell', text: "I heard about your loss, {you}. I'm so sorry.", s: 0.1,
        replies: [
          { text: 'Thank you for saying so. I miss them more each day.', s: -0.1, stance: 'agree' },
          { text: "Word travels fast. It's a hard loss to speak of, but thank you.", s: -0.1, stance: 'neutral' },
          { text: "I can't talk about the loss yet. Forgive me.", s: -0.2, stance: 'disagree', voice: ['gruff', 'shy'] },
        ],
      },
      {
        kind: 'tell', text: "I've thought of you since your loss. If you need anything, only say.", s: 0.1,
        replies: [
          { text: 'That is kind. Some evenings the house is too quiet, and I miss them.', s: -0.1, stance: 'agree' },
          { text: "Thank you. I'll remember it when the loss is less raw.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "I'm sorry for your loss, {you}. They'll be missed by the whole town.", s: 0.1,
        replies: [
          { text: 'Thank you. Hearing that helps, a little. I miss them so.', s: 0, stance: 'agree' },
          { text: 'I keep expecting them to walk through the door. I miss them terribly.', s: -0.2, stance: 'agree' },
        ],
      },
    ],
    follow: [
      { text: "I'm sorry I can't offer more than my company.", s: 0.1 },
      { text: 'A loss like that is too heavy to carry alone.', s: 0.1 },
      { text: 'The town will miss them, and I will too.', s: 0 },
      { text: "Come by for supper this week. You shouldn't sit alone with the loss.", s: 0.1, when: (_c, me) => me.friendship >= 20 },
    ],
    close: [
      // Comfort goes to the one grieving; they answer with thanks.
      { text: "Be gentle with yourself, {you}. I'm sorry, truly.", s: 0.1, when: byOpener },
      { text: "I'll look in on you tomorrow, {you}. I'm so sorry.", s: 0.1, when: byOpener },
      { text: 'If the nights are hardest, send for me. I am sorry for your loss, {you}.', s: 0.1, when: byOpener },
      { text: "Thank you for coming, {you}. It helps not to miss them alone.", s: 0.1, when: (c, me) => !byOpener(c, me) },
      { text: "Thank you, {you}. I'm sorry to be poor company.", s: 0, when: (c, me) => !byOpener(c, me) },
    ],
  },

  // ===== the listener is sick =====
  // The clinic script needs the clinic; a sick neighbour in the street got the weather.
  {
    id: 'feeling_poorly',
    // "Exactly." after "I'm no better" would be a poor joke.
    acks: {
      agree: [{ text: 'Poor soul.', s: 0.1 }, { text: 'I thought as much.', s: 0 }],
      disagree: [{ text: 'Well, if you say so.', s: 0 }, { text: "You'd tell me if it were worse.", s: 0.1 }],
      neutral: [{ text: 'I see.', s: 0 }, { text: 'I understand.', s: 0.1 }],
    },
    cooldownHours: 10,
    when: (c) => civil(c) && isSick(c.people[1]),
    weight: () => 6,
    topic: () => 'being unwell',
    anchors: () => ['unwell', 'rest', 'better'],
    openers: [
      {
        kind: 'ask', text: 'You look unwell, {you}. Have you been resting?', s: 0,
        replies: [
          { text: "Not as much as I should. There's too much to do to rest.", s: -0.1, stance: 'neutral' },
          { text: "I'm not feeling myself, no. I'll rest when the fever breaks.", s: -0.1, stance: 'agree' },
          { text: "I'm a little unwell, that's all. It will pass.", s: -0.1, stance: 'disagree', voice: ['gruff', 'shy', 'plain'] },
        ],
      },
      {
        kind: 'ask', text: 'Are you feeling any better today, {you}?', s: 0.1,
        replies: [
          { text: 'A little better, thank you. The fever broke in the night.', s: 0.1, stance: 'agree' },
          { text: "Not really. I'm no better than yesterday.", s: -0.2, stance: 'disagree' },
          { text: "Slowly. I'm told I need rest, and I'm trying.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "I heard you'd been unwell, {you}. I hope it's nothing serious.", s: 0.1,
        replies: [
          { text: "Just a fever, I think. I'll be better in a day or two.", s: 0, stance: 'neutral' },
          { text: "I've felt better, I'll admit. Rest is all the doctor orders.", s: -0.1, stance: 'agree' },
          { text: "It's only a cough. I'm not so unwell as people say.", s: -0.1, stance: 'disagree', voice: ['gruff', 'shy', 'plain'] },
        ],
      },
      {
        kind: 'tell', text: 'You ought to be home resting, {you}, not out here looking so unwell.', s: 0.1,
        replies: [
          { text: "I know. I couldn't bear the four walls any longer. I'll rest soon.", s: -0.1, stance: 'neutral' },
          { text: "I'm headed home now. A night's rest, and I'll be better by morning.", s: 0.1, stance: 'agree' },
          { text: "Don't fuss. I've no time to rest.", s: -0.2, stance: 'disagree', voice: ['gruff'] },
        ],
      },
    ],
    follow: [
      { text: "You mustn't push yourself. Rest is the best medicine there is.", s: 0.1 },
      { text: "A hot broth and a warm bed will have you better before the week is out.", s: 0.1 },
      { text: "I hope you're better by Sunday.", s: 0.1 },
      { text: "Send word if you're still unwell tomorrow.", s: 0 },
    ],
    close: [
      // The rest is the listener's to take: the opener sends them to it, they answer with thanks.
      { text: 'Get some rest, {you}, and mend soon.', s: 0.1, when: byOpener },
      { text: "I hope you're better soon, {you}.", s: 0.2, when: byOpener },
      { text: 'Rest well, {you}. Send word if you need anything.', s: 0.1, when: byOpener },
      { text: "Thank you, {you}. I'll rest and be better soon.", s: 0.1, when: (c, me) => !byOpener(c, me) },
      { text: "I'll go and rest now. Thank you for asking after me, {you}.", s: 0.1, when: (c, me) => !byOpener(c, me) },
    ],
  },

  // ===== someone is hungry =====
  {
    id: 'hungry',
    cooldownHours: 6,
    when: (c) => civil(c) && c.people[0].hunger < 35,
    weight: () => 3,
    topic: () => 'food',
    anchors: () => ['eat', 'food', 'hungry', 'starv', 'stomach', 'bite', 'breakfast', 'supper', 'stew', 'meal', 'lunch'],
    openers: [
      {
        kind: 'tell', text: 'I skipped breakfast and my stomach is making sure I know it.', s: -0.1,
        when: (c) => c.dayPhase === 'morning' || c.dayPhase === 'dawn',
      },
      { kind: 'tell', text: "I'm starving. I haven't eaten a thing since breakfast.", s: -0.2, when: (c) => EVENINGISH(c.dayPhase) },
      {
        kind: 'ask', text: "Want to grab a bite at {tavern}? I'm starving.", s: 0.4,
        when: (c, me) => me.friendship >= 30 && !PUBLIC_DRINKING(c.place.type),
        replies: [
          { text: 'I could eat. Lead the way to the stew.', s: 0.4, stance: 'agree' },
          { text: "Not now, but don't let me keep you from your meal.", s: 0.1, stance: 'neutral' },
        ],
      },
    ],
    react: [
      { text: 'Go and eat something before you faint.', s: 0.1, stance: 'neutral' },
      { text: "Now you've made me hungry too.", s: 0.2, stance: 'agree' },
    ],
    follow: [
      { text: "I'd give a lot for a bowl of hot stew right now.", s: 0.1 },
      { text: "I can smell someone's supper cooking from here.", s: 0.1 },
    ],
    close: [
      { text: "I'd better go find some food.", s: 0.1, when: (_c, me) => me.hunger < 35 },
      { text: 'Enjoy your meal, {you}.', s: 0.2, when: (_c, _me, you) => you.hunger < 35 },
      { text: "Don't go hungry on my account, {you}.", s: 0.1, when: (_c, _me, you) => you.hunger < 35 },
    ],
  },

  // ===== a mutual acquaintance =====
  {
    id: 'mutual',
    cooldownHours: 12,
    when: (c) => c.mutual != null && civil(c),
    weight: () => 4,
    topic: (c) => c.mutual!.first,
    anchors: (c) => [c.mutual!.first.toLowerCase()],
    openers: [
      {
        kind: 'ask', text: 'Have you seen {mutual} lately, {you}?', s: 0.1,
        replies: [
          { text: 'Just yesterday. {mutual} seemed in good spirits.', s: 0.3, stance: 'neutral', when: (c) => c.mutual!.listenerLikes },
          { text: 'Not for a few days. I should look in on {mutual}.', s: 0.1, stance: 'neutral', when: (c) => c.mutual!.listenerLikes },
          { text: "I try not to, if I'm honest. {mutual} and I don't get along.", s: -0.3, stance: 'disagree', when: (c) => !c.mutual!.listenerLikes },
        ],
      },
      {
        kind: 'tell', text: 'I ran into {mutual} this morning. Always a pleasure.', s: 0.3,
        when: (c) => c.mutual!.openerLikes,
        replies: [
          { text: '{mutual} always cheers me up too.', s: 0.3, stance: 'agree', when: (c) => c.mutual!.listenerLikes },
          { text: "I've no energy for {mutual} today.", s: -0.1, stance: 'neutral', tone: ['cool'] },
          { text: "Can't say I feel the same about {mutual}.", s: -0.2, stance: 'disagree', when: (c) => !c.mutual!.listenerLikes },
        ],
      },
      {
        kind: 'tell', text: '{mutual} was in a foul mood again today.', s: -0.2,
        when: (c) => !c.mutual!.openerLikes,
        replies: [
          { text: "Go easy on {mutual}. They've had a hard time.", s: 0, stance: 'disagree', when: (c) => c.mutual!.listenerLikes },
          { text: 'When is {mutual} ever in a good mood?', s: -0.3, stance: 'agree', when: (c) => !c.mutual!.listenerLikes },
        ],
      },
    ],
    follow: [
      { text: 'Give {mutual} my regards if you see them.', s: 0.2, when: (c) => c.mutual!.openerLikes },
      { text: "I'll keep my distance from {mutual} for a while.", s: -0.2, when: (c) => !c.mutual!.openerLikes },
      { text: '{mutual} works too hard, if you ask me.', s: 0.1, when: (c) => c.mutual!.openerLikes },
    ],
    close: [
      { text: 'If you see {mutual}, tell them I said hello.', s: 0.2, when: (c, me) => (me === c.people[0] ? c.mutual!.openerLikes : c.mutual!.listenerLikes) },
      { text: 'Anyway, enough about {mutual}.', s: 0 },
    ],
  },

  // ===== a town event =====
  {
    id: 'event',
    cooldownHours: 6,
    when: (c) => c.event != null && civil(c),
    weight: () => 5,
    topic: (c) => c.event!.phrase,
    anchors: (c) => [c.event!.anchor],
    openers: [
      // The event's own question (EVENT_TALK `ask`), with answers written for it.
      {
        kind: 'ask', text: '{eventAsk}', s: 0.2,
        replies: [
          { text: '{eventYes}', s: 0.3, stance: 'agree' },
          { text: '{eventNo}', s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'What do you make of {event}, {you}?', s: 0.1,
        replies: [
          { text: '{Event} is the best thing to happen here in months.', s: 0.5, stance: 'agree', when: (c) => c.event!.mood === 'good' },
          { text: "I'm glad of {event}. The town needed cheering up.", s: 0.4, stance: 'agree', when: (c) => c.event!.mood === 'good' },
          { text: "I haven't the heart for {event} this week.", s: -0.2, stance: 'disagree', tone: ['cool'], when: (c) => c.event!.mood === 'good' },
          { text: '{Event} has everyone on edge.', s: -0.3, stance: 'agree', when: (c) => c.event!.mood === 'bad' },
          { text: 'I try not to think about {event}.', s: -0.2, stance: 'neutral', when: (c) => c.event!.mood === 'bad' },
          { text: "I don't know what to make of {event}, honestly.", s: 0, stance: 'neutral', when: (c) => c.event!.mood === 'odd' },
          { text: '{Event} is all anyone talks about.', s: 0.1, stance: 'neutral', when: (c) => c.event!.mood === 'odd' },
        ],
      },
      {
        kind: 'ask', text: 'Have you heard about {event}?', s: 0.1,
        replies: [
          { text: "Who hasn't? {Event} is all anyone talks about.", s: 0.1, stance: 'agree' },
          { text: 'Only bits and pieces about {event}. Tell me more.', s: 0.2, stance: 'neutral' },
        ],
      },
      { kind: 'tell', text: "I can't stop thinking about {event}. What a thing for the town.", s: 0.5, when: (c) => c.event!.mood === 'good' },
      { kind: 'tell', text: "{Event} has me worried, I won't lie.", s: -0.3, when: (c) => c.event!.mood === 'bad' },
      { kind: 'tell', text: "Something about {event} doesn't sit right with me.", s: -0.1, when: (c) => c.event!.mood === 'odd' },
    ],
    react: [
      { text: '{Event} has put everyone in a good mood.', s: 0.4, stance: 'agree', when: (c) => c.event!.mood === 'good' },
      { text: 'Not everyone is in the mood for {event}.', s: -0.2, stance: 'disagree', tone: ['cool'], when: (c) => c.event!.mood === 'good' },
      { text: "Let's hope {event} passes soon.", s: -0.2, stance: 'agree', when: (c) => c.event!.mood === 'bad' },
      { text: "I've heard a dozen stories about {event} already.", s: 0, stance: 'neutral' },
    ],
    follow: [
      { text: 'I hope we get more days like {event}.', s: 0.4, when: (c) => c.event!.mood === 'good' },
      { text: 'People are looking out for each other since {event}.', s: 0.1, when: (c) => c.event!.mood === 'bad' },
      { text: "I'll believe half the stories about {event} when I see it myself.", s: 0, when: (c) => c.event!.mood === 'odd' },
    ],
    close: [
      { text: "Let's talk more about {event} another time.", s: 0.1 },
      { text: 'Enjoy {event}, {you}.', s: 0.4, when: (c) => c.event!.mood === 'good' && !!c.event!.enjoy },
      { text: 'Stay safe until {event} is over, {you}.', s: 0.1, when: (c) => c.event!.mood === 'bad' },
    ],
  },

  // ===== sweethearts =====
  {
    id: 'sweethearts',
    cooldownHours: 8,
    when: (c) =>
      (COUPLE.has(c.status ?? '') || c.status === 'romantic_interest' || c.romance >= 40)
      && c.people[0].friendship >= 20 && c.people[1].friendship >= 20
      // At night only a real couple: "Supper tonight?" at midnight is not a
      // plan, and the night lines below are a couple's.
      && (c.dayPhase !== 'night' || COUPLE.has(c.status ?? '')),
    weight: () => 5,
    topic: (c) => (c.dayPhase === 'night' ? 'a walk home' : 'plans for tonight'),
    anchors: () => ['tonight', 'supper', 'walk', 'evening', 'later', 'night', 'tomorrow'],
    openers: [
      {
        kind: 'ask', text: 'Walk with me later, {you}? Just the two of us.', s: 0.6,
        when: (c) => c.dayPhase !== 'night',
        replies: [
          { text: "I'd like nothing better than a walk with you.", s: 0.7, stance: 'agree' },
          { text: "Not tonight. I'm not fit company this evening.", s: -0.1, stance: 'disagree', tone: ['cool'] },
          { text: 'Later tonight, yes. Wait for me by the well.', s: 0.5, stance: 'agree' },
        ],
      },
      {
        kind: 'ask', text: 'Supper together tonight?', s: 0.6,
        when: (c) => c.dayPhase !== 'night',
        replies: [
          { text: "I've been hoping you'd ask. Supper it is.", s: 0.7, stance: 'agree' },
          { text: "Only if I'm allowed to cook supper this time.", s: 0.6, stance: 'neutral' },
          { text: "Maybe another evening. I'm not myself tonight.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: 'I was hoping I would see you before this evening.', s: 0.6,
        when: (c) => c.dayPhase !== 'night' && c.dayPhase !== 'evening',
        replies: [
          { text: 'And here I am, a whole evening early.', s: 0.6, stance: 'agree' },
          { text: "You'll have me all to yourself later, I promise.", s: 0.6, stance: 'neutral' },
          { text: "I'm not much company this evening, I'm afraid.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      // A couple at night (playtest #3: partners fell back to "What do you
      // make of the full moon?", word for word the same as another pair).
      {
        kind: 'ask', text: 'Walk me home tonight, {you}?', s: 0.6,
        when: (c) => c.dayPhase === 'night',
        replies: [
          { text: 'Of course. I was hoping for a walk with you tonight.', s: 0.7, stance: 'agree' },
          { text: 'Only as far as the gate tonight, then.', s: 0.4, stance: 'neutral' },
          { text: "Not tonight. I'd rather walk alone.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: "I didn't want the night to end without seeing you.", s: 0.6,
        when: (c) => c.dayPhase === 'night',
        replies: [
          { text: "Nor did I. It's a better night now.", s: 0.7, stance: 'agree' },
          { text: "It's late, but I'm glad of it. Tomorrow will come soon enough.", s: 0.5, stance: 'neutral' },
          { text: "It's late. I only want my bed tonight.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
    ],
    follow: [
      { text: "I'll count the hours until tonight.", s: 0.6, when: (c) => c.dayPhase !== 'night' && c.dayPhase !== 'evening' },
      { text: "Don't be late this evening.", s: 0.4, when: (c) => c.dayPhase !== 'night' },
      { text: "I'd stay out half the night if the cold would let us.", s: 0.5, when: (c) => c.dayPhase === 'night' },
    ],
    close: [
      { text: 'Until tonight, {you}.', s: 0.6, when: (c) => c.dayPhase !== 'night' && c.dayPhase !== 'evening' },
      { text: 'See you this evening, then.', s: 0.5, when: (c) => c.dayPhase !== 'night' && c.dayPhase !== 'evening' },
      { text: "I'll see you later this evening, {you}.", s: 0.5, when: (c) => c.dayPhase === 'evening' },
      { text: 'Good night, {you}. Until tomorrow.', s: 0.6, when: (c) => c.dayPhase === 'night' },
      { text: 'Sleep well tonight, {you}.', s: 0.5, when: (c) => c.dayPhase === 'night' },
    ],
  },

  // ===== a shy flirt (a crush spotted, not yet a couple) =====
  {
    id: 'shy_flirt',
    cooldownHours: 8,
    // Only when the conversation was queued AS a flirt: nobody flirts with the
    // baker because it happens to be sunny. A couple gets `sweethearts`.
    when: (c) => isFlirtIntent(c) && civil(c) && !COUPLE.has(c.status ?? ''),
    weight: () => 5,
    topic: () => 'a bit of flirting',
    anchors: () => ['hat', 'walk', 'hoping', 'smile', 'glad', 'company', 'blush', 'flatter'],
    openers: [
      {
        kind: 'ask', text: 'Is that a new hat, {you}? It suits you.', s: 0.5,
        replies: [
          { text: "It is. I'm glad somebody noticed the hat.", s: 0.5, stance: 'agree' },
          { text: "This old hat? You flatter me.", s: 0.4, stance: 'neutral' },
          { text: 'Oh — thank you. Nobody ever notices my hat.', s: 0.4, stance: 'agree', voice: ['shy'] },
          { text: "It's the same hat as always.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'ask', text: 'Would you walk with me a while, {you}?', s: 0.5,
        replies: [
          { text: "I'd like that walk very much.", s: 0.6, stance: 'agree' },
          { text: 'Only a short walk. People will talk.', s: 0.3, stance: 'neutral', voice: ['shy', 'plain'] },
          { text: "Not today. I'm in no mood for a walk.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: "I was hoping I'd run into you today.", s: 0.5,
        replies: [
          { text: "I was hoping the same, if I'm honest.", s: 0.6, stance: 'agree' },
          { text: 'Hoping, were you? You flatter me.', s: 0.4, stance: 'neutral' },
          { text: "I can't think why you'd be hoping for that.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: 'You have a lovely smile, {you}.', s: 0.6,
        replies: [
          { text: "And you've made me smile twice now.", s: 0.6, stance: 'agree' },
          { text: "Oh, stop. You'll make me blush.", s: 0.5, stance: 'neutral', voice: ['shy', 'warm'] },
          { text: "Save your flattery for someone who needs it.", s: -0.2, stance: 'disagree', tone: ['cool'] },
        ],
      },
    ],
    follow: [
      { text: "I don't mind admitting I enjoy your company.", s: 0.5 },
      { text: 'Perhaps we could walk to the square some evening.', s: 0.5 },
      { text: "I'll be hoping to see that smile again.", s: 0.5 },
    ],
    close: [
      { text: "Until next time, {you}. I'll be hoping it's soon.", s: 0.5 },
      { text: "I'm glad I found you, {you}.", s: 0.4 },
      { text: 'Good day. Thank you for the company.', s: 0.2, when: (c, me) => !byOpener(c, me) },
    ],
  },

  // ===== offering a hand (someone sick, tired or struggling) =====
  {
    id: 'help',
    cooldownHours: 6,
    when: (c) => isHelpIntent(c) && civil(c),
    weight: () => 5,
    topic: () => 'a helping hand',
    anchors: () => ['help', 'hand', 'need', 'fetch', 'soup', 'kind', 'manag'],
    openers: [
      {
        kind: 'ask', text: 'Can I lend you a hand with anything, {you}?', s: 0.4,
        replies: [
          { text: "That's kind. I could use a hand carrying water.", s: 0.4, stance: 'agree' },
          { text: "I'm managing, but thank you for the kind offer.", s: 0.2, stance: 'neutral' },
          { text: "I don't need help. I'm not an invalid.", s: -0.2, stance: 'disagree', voice: ['gruff'] },
          { text: 'I can manage without your help.', s: -0.2, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'ask', text: 'You look poorly, {you}. Shall I fetch you something from the shop?', s: 0.3,
        when: (_c, _me, you) => you.mood < 45 || you.energy < 35,
        replies: [
          { text: 'Would you? A little broth would help.', s: 0.4, stance: 'agree' },
          { text: "That's kind, but I'll be all right.", s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: 'If you need anything fetched, you only have to ask.', s: 0.4,
        replies: [
          { text: "I'll remember that. It's kind of you.", s: 0.4, stance: 'agree' },
          { text: "I'll manage, but thank you for the help all the same.", s: 0.2, stance: 'neutral' },
          { text: "I don't need anything fetched, thank you.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: "I've made too much soup. I'll bring some round for you.", s: 0.5,
        when: (c) => c.people[0].friendship >= 20,
        replies: [
          { text: 'Soup would be a kindness, thank you.', s: 0.5, stance: 'agree' },
          { text: "No need, but it's kind of you.", s: 0.2, stance: 'neutral' },
          { text: "No soup for me. I don't need looking after.", s: -0.2, stance: 'disagree', tone: ['cool'] },
        ],
      },
    ],
    follow: [
      { text: 'Folk have to help each other in a town this size.', s: 0.3 },
      { text: 'Send word if you need a hand later.', s: 0.3 },
    ],
    close: [
      { text: 'Take care of yourself, {you}. Send for me if you need a hand.', s: 0.4, when: byOpener },
      { text: "Mind you rest. I'll help if I can.", s: 0.3, when: byOpener },
      { text: 'Thank you for the kind offer, {you}.', s: 0.3, when: (c, me) => !byOpener(c, me) },
    ],
  },

  // ===== a crush, not (yet) a couple =====
  // Someone sweet on the listener tries their luck. Before this, a crush only showed in
  // template small talk once the pair was already at `sweethearts` level, so the courtship
  // itself — the part worth watching — had no voice, and template chats could never flirt
  // (lib/templateBeats.ts reads the flirt beat off this script).
  {
    id: 'flirting',
    cooldownHours: 10,
    // Unprompted: a chat queued AS a flirt gets `shy_flirt`, written for that
    // moment; this one is a crush trying their luck in an ordinary chat.
    when: (c) =>
      civil(c) && !isFlirtIntent(c) && c.romance >= 20 && c.people[0].friendship >= 0
      && c.status !== 'partners' && c.dayPhase !== 'night',
    weight: () => 4,
    topic: () => 'a bit of flirting',
    anchors: () => ['smile', 'look', 'dance', 'company'],
    openers: [
      {
        kind: 'ask', text: 'Has anyone told you what a lovely smile you have, {you}?', s: 0.6,
        replies: [
          { text: "Not lately. You've made me smile twice now.", s: 0.6, stance: 'agree', tone: ['warm', 'neutral'] },
          { text: "Flattery won't get you far, but I'll keep the smile.", s: 0.3, stance: 'neutral', tone: ['warm', 'neutral'] },
          { text: 'Save that smile talk for someone who wants it.', s: -0.3, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: 'You look well today, {you}. Very well indeed.', s: 0.5,
        replies: [
          { text: "You don't look so bad yourself.", s: 0.5, stance: 'agree', tone: ['warm', 'neutral'] },
          { text: "I'll pretend I didn't see that look on your face.", s: 0.2, stance: 'neutral', tone: ['warm', 'neutral'] },
          { text: "I'd rather you didn't look at me like that.", s: -0.3, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'ask', text: 'Will you save me a dance at the next gathering, {you}?', s: 0.5,
        replies: [
          { text: "One dance, if you promise not to tread on my toes.", s: 0.5, stance: 'agree', tone: ['warm', 'neutral'] },
          { text: "One dance. We'll see about a second.", s: 0.3, stance: 'neutral', tone: ['warm', 'neutral'] },
          { text: "I don't dance. Certainly not with you.", s: -0.4, stance: 'disagree', tone: ['cool'] },
        ],
      },
    ],
    follow: [
      { text: 'I always did enjoy your company.', s: 0.5 },
      { text: "I'll be thinking about that smile all day.", s: 0.5 },
    ],
    close: [
      { text: 'Until next time. Save that smile for me, {you}.', s: 0.4 },
      { text: "I'll let you go, but I'll miss the company.", s: 0.4 },
    ],
  },

  // ===== hosting or visiting at home =====
  {
    id: 'visit',
    cooldownHours: 10,
    when: (c) => HOMES(c.place.type) && civil(c) && (c.people[0].livesHere !== c.people[1].livesHere),
    weight: () => 4,
    topic: () => 'a visit',
    anchors: () => ['home', 'house', 'visit', 'tea', 'kettle', 'having me', 'chair'],
    openers: [
      {
        kind: 'tell', text: 'Make yourself at home, {you}.', s: 0.5, when: (_c, me) => me.livesHere,
        replies: [
          { text: "Thank you. You've made this house so cosy.", s: 0.4, stance: 'agree' },
          { text: "I won't stay long. Thank you for having me.", s: 0.3, stance: 'neutral' },
          { text: "I won't be staying long at your house.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'ask', text: 'Can I make you some tea while you visit?', s: 0.4, when: (_c, me) => me.livesHere,
        replies: [
          { text: 'Tea would be lovely, thank you.', s: 0.5, stance: 'agree' },
          { text: "Just a small cup of tea. I can't stay long.", s: 0.2, stance: 'neutral' },
          { text: "No tea for me. I can't stay long.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
      {
        kind: 'tell', text: 'Thank you for having me over, {you}. Your home is lovely.', s: 0.5, when: (_c, me) => !me.livesHere,
        replies: [
          { text: "You're welcome in my home any time.", s: 0.5, stance: 'agree' },
          { text: "Mind the loose floorboard. The house is older than both of us.", s: 0.2, stance: 'neutral' },
          { text: "Just don't stay too long. The house is a mess.", s: -0.1, stance: 'disagree', tone: ['cool'] },
        ],
      },
    ],
    follow: [
      { text: "The kettle's just boiled, if you'd like more tea.", s: 0.3, when: (_c, me) => me.livesHere },
      { text: 'I could sit in this chair all afternoon.', s: 0.3, when: (_c, me) => !me.livesHere },
    ],
    close: [
      { text: 'Come and visit any time, {you}.', s: 0.4, when: (_c, me) => me.livesHere },
      { text: 'Thank you for having me in your home, {you}.', s: 0.4, when: (_c, me) => !me.livesHere },
    ],
  },

  // ===== a hostile encounter =====
  {
    id: 'standoff',
    acks: {
      agree: [{ text: 'Hmph.', s: -0.2 }],
      disagree: [{ text: 'Suit yourself.', s: -0.3 }, { text: 'Whatever you say.', s: -0.3 }, { text: 'Hmph.', s: -0.2 }],
      neutral: [{ text: 'Hmph.', s: -0.2 }, { text: 'Whatever you say.', s: -0.3 }],
    },
    hostileOk: true,
    cooldownHours: 6,
    when: hostile,
    weight: () => 6,
    topic: () => 'tense encounter',
    anchors: (c) => ['here', ...(c.place.speakable ? [c.place.name.toLowerCase()] : [])],
    openers: [
      {
        kind: 'ask', text: 'What are you doing here, {you}?', s: -0.5,
        replies: [
          { text: "Same as you. You don't own this place, and I'm staying right here.", s: -0.4, stance: 'disagree' },
          { text: 'Minding my own business here. You should try it.', s: -0.5, stance: 'disagree', voice: ['gruff', 'plain', 'bubbly', 'warm'] },
          { text: "I'm only passing through here. No need for that tone.", s: -0.2, stance: 'neutral', voice: ['shy', 'warm'] },
        ],
      },
      {
        kind: 'tell', text: "Of course you'd turn up here.", s: -0.5,
        replies: [
          { text: 'I was here first, if you must know.', s: -0.4, stance: 'disagree' },
          { text: "There's room here for both of us. Try to ignore me.", s: -0.3, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "I'd hoped for a quiet hour at {place}. So much for that.", s: -0.4,
        when: (c) => c.place.speakable,
        replies: [
          { text: '{place} is quiet enough. Maybe the problem is you.', s: -0.5, stance: 'disagree' },
          { text: 'Then find another corner of {place}.', s: -0.4, stance: 'disagree' },
        ],
      },
    ],
    follow: [
      { text: 'Just stay out of my way while we are both here.', s: -0.4 },
      { text: "I'll be glad when one of us leaves {place}.", s: -0.4, when: (c) => c.place.speakable },
    ],
    close: [
      { text: "I'm done here.", s: -0.4 },
      { text: "I've nothing more to say to you here.", s: -0.5 },
    ],
  },

  // ===== news about the listener that the opener has heard =====
  // Out of jail, out of work, thinking of leaving, a birthday, money trouble
  // (lib/partnerView.ts decides what the opener knows). Preferred when there is
  // news (templateChat.ts `preferredScripts`): nobody greets a man just out of
  // jail with "lovely day". Every line carries its news's anchor (NEWS_ANCHORS).
  {
    id: 'their_news',
    cooldownHours: 12,
    when: (c) => civil(c) && c.news != null,
    weight: () => 6,
    topic: (c) => c.news === 'released' ? 'being back' : c.news === 'lost_job' ? 'losing work'
      : c.news === 'leaving' ? 'leaving town' : c.news === 'birthday' ? 'a birthday' : 'hard times',
    anchors: (c) => c.news ? NEWS_ANCHORS[c.news] : [...new Set(Object.values(NEWS_ANCHORS).flat())],
    openers: [
      {
        kind: 'ask', text: 'Good to have you back, {you}. Are you keeping well?', s: 0.1,
        when: (c) => c.news === 'released',
        replies: [
          { text: "Well enough. It's good to be back home.", s: 0.1, stance: 'agree' },
          { text: "I'd rather not talk about where I've been. But it's good to be back.", s: 0, stance: 'neutral' },
          { text: 'Back, and everyone staring at me. I know what they think.', s: -0.2, stance: 'disagree', voice: ['gruff', 'shy', 'plain'] },
        ],
      },
      {
        kind: 'tell', text: 'I heard you were back, {you}. Welcome home.', s: 0.1,
        when: (c) => c.news === 'released',
        replies: [
          { text: "Thank you. It's good to be back where I belong.", s: 0.1, stance: 'agree' },
          { text: 'Back, yes. Not everyone is as kind about it as you.', s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'I heard about your work, {you}. What will you do now?', s: 0,
        when: (c) => c.news === 'lost_job',
        replies: [
          { text: 'Find other work. I have to.', s: 0, stance: 'neutral' },
          { text: "I don't know yet. Without work the days are long.", s: -0.2, stance: 'agree' },
          { text: "There's always work for someone who looks. I'll manage.", s: 0.1, stance: 'disagree', voice: ['gruff', 'plain'] },
        ],
      },
      {
        kind: 'tell', text: "I'm sorry about your work, {you}. It's a hard thing.", s: 0.1,
        when: (c) => c.news === 'lost_job',
        replies: [
          { text: "It is. I'll look for work elsewhere.", s: 0, stance: 'agree' },
          { text: "Thank you. I'm not finished with work yet.", s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: "Is it true you're thinking of leaving town, {you}?", s: 0,
        when: (c) => c.news === 'leaving',
        replies: [
          { text: "I've been thinking of leaving. There's not much keeping me.", s: -0.2, stance: 'agree' },
          { text: "Maybe. I haven't made up my mind to leave or stay.", s: 0, stance: 'neutral' },
          { text: "Who told you I'm leaving? I'll stay or go as I please.", s: -0.3, stance: 'disagree', voice: ['gruff'] },
        ],
      },
      {
        kind: 'tell', text: "I'd be sorry to see you leave, {you}.", s: 0.1,
        when: (c) => c.news === 'leaving',
        replies: [
          { text: "That's kind. Maybe I'll stay a while yet.", s: 0.1, stance: 'agree' },
          { text: "I've not decided to leave. Not yet.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'Happy birthday, {you}! Doing anything for your birthday?', s: 0.1,
        when: (c) => c.news === 'birthday',
        replies: [
          { text: 'Nothing much. A quiet birthday suits me.', s: 0.1, stance: 'neutral' },
          { text: "A drink tonight, I think. It's not every day it's my birthday.", s: 0.3, stance: 'agree' },
          { text: 'Birthdays are for children.', s: -0.1, stance: 'disagree', voice: ['gruff'] },
        ],
      },
      {
        kind: 'tell', text: 'Many happy returns, {you}. Happy birthday.', s: 0.1,
        when: (c) => c.news === 'birthday',
        replies: [
          { text: 'Thank you! You remembered my birthday.', s: 0.3, stance: 'agree' },
          { text: 'Thank you. Another birthday, another year older.', s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'How are you managing for money, {you}? I heard times are hard.', s: 0,
        when: (c) => c.news === 'in_debt',
        replies: [
          { text: "Hard times, but I'll get by.", s: 0, stance: 'neutral' },
          { text: "Not well. Money's tighter than it's ever been.", s: -0.2, stance: 'agree' },
          { text: 'My money is my own business.', s: -0.3, stance: 'disagree', voice: ['gruff', 'shy'] },
        ],
      },
      {
        kind: 'tell', text: "Times are hard for you, {you}, I know. If you're short of money, say so.", s: 0.1,
        when: (c) => c.news === 'in_debt',
        replies: [
          { text: "That's kind. Times will turn, I hope.", s: 0.1, stance: 'agree' },
          { text: "I'll manage. I won't take anyone's money.", s: -0.1, stance: 'disagree' },
        ],
      },
    ],
    follow: [
      { text: "Whatever's past, you're back among your own now.", s: 0.1, when: (c) => c.news === 'released' },
      { text: "Something will turn up. There's always work for willing hands.", s: 0.1, when: (c) => c.news === 'lost_job' },
      { text: 'Stay, {you}. The place would be poorer without you.', s: 0.1, when: (c) => c.news === 'leaving' },
      { text: 'I hope this birthday is a good one.', s: 0.1, when: (c) => c.news === 'birthday' },
      { text: 'Hard times never last, {you}.', s: 0.1, when: (c) => c.news === 'in_debt' },
    ],
    close: [
      { text: 'Welcome back, {you}.', s: 0.1, when: (c, me) => c.news === 'released' && byOpener(c, me) },
      { text: "Thank you, {you}. It's good to be back.", s: 0.1, when: (c, me) => c.news === 'released' && !byOpener(c, me) },
      { text: 'Chin up, {you}. Work will come.', s: 0.1, when: (c, me) => c.news === 'lost_job' && byOpener(c, me) },
      { text: "Thank you, {you}. I'll find work soon enough.", s: 0.1, when: (c, me) => c.news === 'lost_job' && !byOpener(c, me) },
      { text: "Don't leave without saying goodbye, {you}.", s: 0.1, when: (c, me) => c.news === 'leaving' && byOpener(c, me) },
      { text: "I'll think about whether to stay, {you}.", s: 0.1, when: (c, me) => c.news === 'leaving' && !byOpener(c, me) },
      { text: 'Happy birthday again, {you}.', s: 0.1, when: (c, me) => c.news === 'birthday' && byOpener(c, me) },
      { text: "Thank you, {you}. It's a better birthday for seeing you.", s: 0.1, when: (c, me) => c.news === 'birthday' && !byOpener(c, me) },
      { text: 'Better times are coming, {you}.', s: 0.1, when: (c, me) => c.news === 'in_debt' && byOpener(c, me) },
      { text: 'Thank you, {you}. Better times, I hope.', s: 0.1, when: (c, me) => c.news === 'in_debt' && !byOpener(c, me) },
    ],
  },
];

/**
 * World events as small talk can name them. A missing key (a funeral, the
 * "beautiful day" blessing) means the event is not chat material.
 */
export const EVENT_TALK: Record<string, Omit<ChatEvent, 'key'>> = {
  festival: {
    phrase: 'the festival', anchor: 'festival', mood: 'good', enjoy: true,
    ask: ['Will you be at the festival later?', "I wouldn't miss the festival for anything.", "Maybe. Festivals aren't really for me."],
  },
  market_day: {
    phrase: 'market day', anchor: 'market', mood: 'good', enjoy: true,
    ask: ['Did you find anything good at the market?', "A few things. The market's busier than ever.", 'Nothing I could afford at the market, sadly.'],
  },
  storm: {
    phrase: 'this storm', anchor: 'storm', mood: 'bad',
    ask: ['Is your roof holding up in this storm?', 'Just about. This storm is a fierce one.', "It's leaking. This storm found every crack."],
  },
  sickness: {
    phrase: 'this flu', anchor: 'flu', mood: 'bad',
    ask: ['Has this flu reached your house yet?', 'Not yet, touch wood. The flu is everywhere.', 'It has. Half my household has the flu.'],
  },
  harvest: {
    phrase: 'the harvest', anchor: 'harvest', mood: 'good', enjoy: true,
    ask: ['How is the harvest coming in?', "Well, so far. It'll be a good harvest.", 'Slowly. The harvest needs more hands.'],
  },
  traveling_merchant: {
    phrase: 'the travelling merchant', anchor: 'merchant', mood: 'odd',
    ask: ['Have you seen what the merchant is selling?', 'I have. That merchant wants a fortune for everything.', 'Not yet, but I hear the merchant drives a hard bargain.'],
  },
  town_meeting: {
    phrase: 'the town meeting', anchor: 'meeting', mood: 'odd',
    ask: ['Will you speak up at the town meeting?', 'I will. Someone has to at these meetings.', "Not me. I'll just listen at the meeting."],
  },
  wedding: {
    phrase: 'the wedding', anchor: 'wedding', mood: 'good', enjoy: true,
    ask: ['Will you be at the wedding?', "Of course. I wouldn't miss the wedding.", "If I'm asked. Weddings make me weepy."],
  },
  fire_outbreak: {
    phrase: 'the fire', anchor: 'fire', mood: 'bad',
    ask: ['Was anyone hurt in the fire?', 'Thank heaven, no. But the fire gave us all a fright.', "I don't know yet. I only saw the smoke from the fire."],
  },
  mysterious_stranger: {
    phrase: 'the stranger in town', anchor: 'stranger', mood: 'odd',
    ask: ['Have you seen the stranger in town?', 'I have. That stranger gives me a funny feeling.', "No. I've only heard talk of the stranger."],
  },
  competition: {
    phrase: 'the competition', anchor: 'competition', mood: 'good', enjoy: true,
    ask: ['Are you entering the competition?', 'I am. I mean to win the competition this year.', "Not me. I'd rather watch the competition."],
  },
  full_moon: {
    phrase: 'the full moon', anchor: 'moon', mood: 'odd',
    ask: ['Have you seen how bright the moon is tonight?', 'I have. That moon lights the whole road home.', "I hadn't looked up. I'll see the moon on my way home."],
  },
  heatwave: {
    phrase: 'this heatwave', anchor: 'heatwave', mood: 'bad',
    ask: ['How are you bearing up in this heatwave?', 'Barely. This heatwave has no end.', "I keep to the shade. The heatwave can't last."],
  },
  bountiful_catch: {
    phrase: 'the big catch', anchor: 'catch', mood: 'good',
    ask: ['Did you see the size of the catch the boats brought in?', "I did. There'll be fish on every table from that catch.", "Not yet, but everyone's talking about the catch."],
  },
  starry_night: {
    phrase: 'the starry sky', anchor: 'starry', mood: 'good',
    ask: ['Have you ever seen the sky so starry?', "Never. It's a starry night to remember.", "Starry or not, I'm too tired to look up."],
  },
  scandal: {
    phrase: 'the scandal', anchor: 'scandal', mood: 'odd',
    ask: ['Have you heard the latest about the scandal?', "Who hasn't? The scandal is all over town.", 'I try not to listen to scandal.'],
  },
  new_arrival: {
    phrase: 'the newcomer', anchor: 'newcomer', mood: 'odd',
    ask: ['Have you met the newcomer yet?', 'Only in passing. The newcomer seems pleasant enough.', "Not yet. I'm curious about the newcomer."],
  },
  // The town calendar (data/calendar.ts): named, because everyone knows which one it is.
  spring_fair: {
    phrase: 'the Spring Fair', anchor: 'fair', mood: 'good', enjoy: true,
    ask: ['Are you going to the Spring Fair?', "I am. The fair is the best day of spring.", "Maybe for an hour. Fairs tire me out."],
  },
  midsummer: {
    phrase: 'Midsummer', anchor: 'midsummer', mood: 'good', enjoy: true,
    ask: ['Will you sing at Midsummer this year?', "I might. Midsummer brings out the song in everyone.", "Not me. I'll listen at Midsummer."],
  },
  harvest_festival: {
    phrase: 'the Harvest Festival', anchor: 'harvest', mood: 'good', enjoy: true,
    ask: ['Are you baking for the Harvest Festival?', "I am. I mean to win at the harvest this year.", "No, I'll just eat my way through the harvest tables."],
  },
  winter_lights: {
    phrase: 'Winter Lights', anchor: 'lights', mood: 'good', enjoy: true,
    ask: ['Have you seen the Winter Lights on the square?', "I have. The lights make the cold bearable.", "Not yet. I'll see the lights tonight."],
  },
  election_day: {
    phrase: 'the election', anchor: 'election', mood: 'odd',
    ask: ['Who will you vote for in the election?', "I've made up my mind about the election.", "I haven't decided. The election is a hard call."],
  },
};

/** How people name a job in passing. Unlisted jobs (retired, unemployed) have none. */
export const JOB_NOUNS: Record<string, string> = {
  baker: 'baker',
  bartender: 'bartender',
  constable: 'constable',
  doctor: 'doctor',
  farmer: 'farmer',
  farmhand: 'farmhand',
  handyperson: 'handyman',
  mayor: 'mayor',
  medical_assistant: 'nurse',
  musician: 'musician',
  shop_assistant: 'shop hand',
  shopkeeper: 'shopkeeper',
  artist: 'painter',
  laborer: 'labourer',
  teacher: 'teacher',
};
