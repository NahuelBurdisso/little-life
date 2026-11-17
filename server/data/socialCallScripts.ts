/**
 * Template-tier scripts for social calls (lib/socialCalls): the chat a caller
 * has when they have walked over on purpose — soup for a sickbed, a vigil, a
 * condolence, a birthday, a newcomer's welcome, a plea to stay, a loan.
 *
 * Same contract as the small-talk scripts (data/smallTalkScripts.ts, composed by
 * lib/templateChat.ts): every line carries one of the script's anchors, a
 * question gets an answer written for it, slots are `{you}` (the other one's
 * first name), the town is around 1900. Each script names the `trigger` it is
 * for and is played FIRST for a conversation queued with it, so a caller who
 * came to keep a vigil never falls back to "Lovely weather".
 *
 * The opener is always the caller (participants[0]); closes are split with
 * `byOpener` so thanks go to the one who came. Lines a cool speaker might say
 * stay at s <= 0.1: a grieving widow or a fevered patient doesn't chirp.
 *
 * Pure data, no DB imports.
 */
import type { ChatContext, ChatPerson, TopicScript } from './smallTalkScripts';
import { CALL_TOPIC, callTrigger } from '../lib/socialCalls/topics';

const byOpener = (c: ChatContext, me: ChatPerson) => me === c.people[0];
const byListener = (c: ChatContext, me: ChatPerson) => me !== c.people[0];
const intentIs = (topic: string) => (c: ChatContext) => (c.intent ?? '').trim().toLowerCase() === topic;
const QUIET_ACKS = {
  agree: [{ text: 'I know.', s: 0 }, { text: 'Of course.', s: 0.1 }],
  disagree: [{ text: "I won't press you.", s: 0.1 }, { text: 'As you like.', s: 0 }],
  neutral: [{ text: 'I understand.', s: 0.1 }, { text: 'I see.', s: 0 }],
};
/** Every call script is had once per call; the per-pair topic cooldown would only get in the way. */
const ONCE = 0;
const always = () => true;
const heavy = () => 10;

export const SOCIAL_CALL_SCRIPTS: TopicScript[] = [
  // ===== a visit to the sickbed =====
  {
    id: 'call_sick_visit',
    trigger: callTrigger('sick_visit'),
    acks: QUIET_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: () => CALL_TOPIC.sick_visit,
    anchors: () => ['ill', 'better', 'rest', 'broth', 'soup', 'mend', 'fever'],
    openers: [
      {
        kind: 'ask', text: 'I heard you were ill, {you}. How are you feeling?', s: 0.1,
        replies: [
          { text: "Poorly, but better for seeing a friend. The fever comes and goes.", s: 0, stance: 'agree' },
          { text: "A little better today. It was kind of you to come all this way while I'm ill.", s: 0.1, stance: 'neutral' },
          { text: "I'm not so ill as all that. You needn't have worried.", s: -0.1, stance: 'disagree', voice: ['gruff', 'shy', 'plain'] },
        ],
      },
      {
        kind: 'tell', text: "I've brought you some broth, {you}. You'll mend faster with something warm in you.", s: 0.2,
        replies: [
          { text: 'Broth! Bless you. I had no strength to cook for myself.', s: 0.1, stance: 'agree' },
          { text: "That's good of you. I'll take the broth when the fever lets me.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "I couldn't sit at home knowing you were ill, {you}.", s: 0.1,
        replies: [
          { text: "That's a comfort. Being ill alone is the worst of it.", s: 0, stance: 'agree' },
          { text: "Mind you don't catch it. But I'm glad of the company while I'm ill.", s: 0, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "You need rest, and plenty of it. The work will keep.", s: 0.1 },
      { text: "Send for me if the fever turns. I mean it.", s: 0.1 },
      { text: "A little soup, a long sleep, and you'll mend.", s: 0.1 },
    ],
    close: [
      { text: "I'll let you rest now, {you}. Get better.", s: 0.1, when: byOpener },
      { text: "Mend soon, {you}. I'll look in again.", s: 0.1, when: byOpener },
      { text: "Thank you for coming, {you}. I feel a little better already.", s: 0.1, when: byListener },
      { text: "I'll rest now. Thank you, {you}.", s: 0.1, when: byListener },
    ],
  },

  // ===== a vigil at a gravely ill bedside =====
  {
    id: 'call_vigil',
    trigger: callTrigger('vigil'),
    acks: QUIET_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: () => CALL_TOPIC.vigil,
    anchors: () => ['here', 'stay', 'sit', 'rest', 'hand'],
    openers: [
      {
        kind: 'tell', text: "I'm here, {you}. I'll sit with you a while.", s: 0.1,
        replies: [
          { text: "Stay, then. I don't want to be alone tonight.", s: 0, stance: 'agree' },
          { text: "You needn't sit up with me. But I'm glad you're here.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'Can I get you anything, {you}? Water? Another blanket for the rest of the night?', s: 0.1,
        replies: [
          { text: 'Just sit here by me. That is all I want.', s: 0, stance: 'agree' },
          { text: "Nothing. Only stay a little.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "Hold my hand, {you}. You're not facing this alone.", s: 0.1,
        when: (_c, me) => me.friendship >= 40,
        replies: [
          { text: "Your hand is warm. Stay, please.", s: 0, stance: 'agree' },
          { text: "I'm frightened. I'm glad you're here.", s: -0.1, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "I'm not going anywhere. Rest now.", s: 0.1 },
      { text: "Close your eyes. I'll stay right here.", s: 0.1 },
    ],
    close: [
      { text: "Sleep if you can, {you}. I'll stay.", s: 0.1, when: byOpener },
      { text: "I'll sit here till morning, {you}. Rest.", s: 0.1, when: byOpener },
      { text: "Thank you for sitting with me, {you}.", s: 0, when: byListener },
      { text: "Stay a little longer, {you}. Just a little.", s: 0, when: byListener },
    ],
  },

  // ===== condolences in a house of mourning =====
  {
    id: 'call_condolence',
    trigger: callTrigger('condolence'),
    acks: QUIET_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: () => CALL_TOPIC.condolence,
    anchors: () => ['sorry', 'loss', 'miss', 'grief'],
    openers: [
      {
        kind: 'tell', text: "I came as soon as I heard, {you}. I'm so sorry for your loss.", s: 0.1,
        replies: [
          { text: "Thank you. I keep thinking they'll walk in. I miss them so.", s: -0.2, stance: 'agree' },
          { text: "It was good of you to come. The house is quiet with this loss.", s: -0.1, stance: 'neutral' },
          { text: "I can't speak of the loss yet. But thank you.", s: -0.2, stance: 'disagree', voice: ['gruff', 'shy'] },
        ],
      },
      {
        kind: 'ask', text: "I've brought a little food, {you}. Have you eaten anything since the loss?", s: 0.1,
        replies: [
          { text: "Not much. Grief takes the appetite. Thank you.", s: -0.1, stance: 'agree' },
          { text: "A little. I'm sorry, I'm poor company.", s: -0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "They were a good soul, {you}. The whole town will miss them.", s: 0.1,
        replies: [
          { text: "They were. I'll miss them every day.", s: -0.1, stance: 'agree' },
          { text: "It helps to hear it. The grief comes in waves.", s: -0.1, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "Grief like that shouldn't be carried alone. Send for me.", s: 0.1 },
      { text: "I'm sorry I can't do more than sit with you.", s: 0.1 },
    ],
    close: [
      { text: "I'll look in tomorrow, {you}. I'm so sorry.", s: 0.1, when: byOpener },
      { text: "Be gentle with yourself in your grief, {you}.", s: 0.1, when: byOpener },
      { text: "Thank you for coming, {you}. I'll miss them less with friends near.", s: 0, when: byListener },
      { text: "Thank you, {you}. I'm sorry to be such poor company in my grief.", s: 0, when: byListener },
    ],
  },

  // ===== congratulations: an engagement =====
  {
    id: 'call_congrats_engagement',
    trigger: callTrigger('congratulate'),
    cooldownHours: ONCE,
    when: intentIs(CALL_TOPIC.congratulate_engagement),
    weight: heavy,
    topic: () => CALL_TOPIC.congratulate_engagement,
    anchors: () => ['congratulations', 'wedding', 'engaged', 'happy'],
    openers: [
      {
        kind: 'tell', text: "Congratulations, {you}! I've just heard you're engaged!", s: 0.5,
        replies: [
          { text: "Thank you! I'm so happy I can hardly sit still.", s: 0.5, stance: 'agree' },
          { text: "Word travels fast. Thank you, truly. We're very happy.", s: 0.3, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: "So when is the wedding, {you}? Congratulations, by the way!", s: 0.4,
        replies: [
          { text: "Soon, we hope. You'll be at the wedding, of course.", s: 0.4, stance: 'agree' },
          { text: "We haven't fixed a day for the wedding yet. Thank you for the congratulations.", s: 0.2, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "I'll dance at that wedding, mark my words.", s: 0.4 },
      { text: "You both deserve to be happy.", s: 0.4 },
    ],
    close: [
      { text: "Congratulations again, {you}.", s: 0.4, when: byOpener },
      { text: "Save me a seat at the wedding, {you}.", s: 0.4, when: byOpener },
      { text: "Thank you for the congratulations, {you}.", s: 0.3, when: byListener },
      { text: "You've made a happy day happier, {you}. Thank you.", s: 0.4, when: byListener },
    ],
  },

  // ===== congratulations: a baby =====
  {
    id: 'call_congrats_baby',
    trigger: callTrigger('congratulate'),
    cooldownHours: ONCE,
    when: (c) => /^congratulations on baby /i.test(c.intent ?? ''),
    weight: heavy,
    topic: (c) => c.intent ?? 'congratulations on the baby',
    anchors: () => ['baby', 'little one', 'congratulations'],
    openers: [
      {
        kind: 'tell', text: "Congratulations, {you}! I had to come and see the baby.", s: 0.5,
        replies: [
          { text: "Thank you! The baby's asleep at last, thank heavens.", s: 0.4, stance: 'agree' },
          { text: "Thank you. We're tired to the bone, but the baby's perfect.", s: 0.3, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'How is the little one, {you}? And how are you holding up?', s: 0.4,
        replies: [
          { text: "The little one is healthy and loud. I'm exhausted and happy.", s: 0.4, stance: 'agree' },
          { text: "The little one sleeps all day and wakes all night. Thank you for asking.", s: 0.2, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "A baby changes everything, and for the better.", s: 0.4 },
      { text: "If you need a hand with the little one, only ask.", s: 0.3 },
    ],
    close: [
      { text: "Congratulations again, {you}. Kiss the baby for me.", s: 0.4, when: byOpener },
      { text: "Get some sleep while the little one does, {you}.", s: 0.3, when: byOpener },
      { text: "Thank you for the congratulations, {you}.", s: 0.3, when: byListener },
      { text: "Come and see the baby again soon, {you}.", s: 0.4, when: byListener },
    ],
  },

  // ===== congratulations: the new mayor =====
  {
    id: 'call_congrats_mayor',
    trigger: callTrigger('congratulate'),
    cooldownHours: ONCE,
    when: intentIs(CALL_TOPIC.congratulate_election),
    weight: heavy,
    topic: () => CALL_TOPIC.congratulate_election,
    anchors: () => ['mayor', 'congratulations', 'town'],
    openers: [
      {
        kind: 'tell', text: "Congratulations, {you}! Mayor! The town chose well.", s: 0.5,
        replies: [
          { text: "Thank you. I mean to deserve it as mayor.", s: 0.4, stance: 'agree' },
          { text: "Thank you. Now the hard part begins for the town.", s: 0.2, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'What will you do first as mayor, {you}?', s: 0.3,
        replies: [
          { text: "Listen, first. The town has been ignored too long.", s: 0.3, stance: 'agree' },
          { text: "I haven't decided. Being mayor still feels strange.", s: 0.1, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "Don't forget the people who voted for you as mayor.", s: 0.2 },
      { text: "The town is lucky to have you.", s: 0.4 },
    ],
    close: [
      { text: "Congratulations again, Mayor {you}.", s: 0.4, when: byOpener },
      { text: "Do right by the town, {you}.", s: 0.3, when: byOpener },
      { text: "Thank you for the congratulations, {you}.", s: 0.3, when: byListener },
      { text: "My door at the town hall is open, {you}.", s: 0.3, when: byListener },
    ],
  },

  // ===== a birthday =====
  {
    id: 'call_birthday',
    trigger: callTrigger('birthday_wish'),
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: () => CALL_TOPIC.birthday_wish,
    anchors: () => ['birthday', 'year', 'many happy returns'],
    openers: [
      {
        kind: 'tell', text: 'Happy birthday, {you}! Did you think I would forget?', s: 0.5,
        replies: [
          { text: "I half thought everyone had. Thank you for remembering my birthday.", s: 0.3, stance: 'neutral' },
          { text: "Ha! Thank you. Another year older and none the wiser.", s: 0.4, stance: 'agree' },
        ],
      },
      {
        kind: 'ask', text: 'Many happy returns, {you}! How does it feel to be a year older?', s: 0.4,
        replies: [
          { text: "Much like yesterday, but with more creaks. Thank you for the birthday wishes.", s: 0.3, stance: 'neutral' },
          { text: "Old! But a good year, all told.", s: 0.3, stance: 'agree' },
        ],
      },
      {
        kind: 'tell', text: "I couldn't let your birthday pass without coming by, {you}.", s: 0.4,
        replies: [
          { text: "That's the nicest thing about this birthday so far.", s: 0.4, stance: 'agree' },
          { text: "You're kind. I wasn't making much of the birthday this year.", s: 0.1, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "Here's to many more birthdays.", s: 0.4 },
      { text: "May the year ahead be kinder than the last.", s: 0.3 },
    ],
    close: [
      { text: 'Happy birthday again, {you}.', s: 0.4, when: byOpener },
      { text: 'Enjoy the rest of your birthday, {you}.', s: 0.4, when: byOpener },
      { text: 'Thank you for the birthday wishes, {you}.', s: 0.3, when: byListener },
      { text: "You've made my birthday, {you}.", s: 0.4, when: byListener },
    ],
  },

  // ===== a welcome to town =====
  {
    id: 'call_welcome',
    trigger: callTrigger('welcome'),
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: () => CALL_TOPIC.welcome,
    anchors: () => ['welcome', 'town', 'neighbour', 'settle'],
    openers: [
      {
        kind: 'tell', text: "Welcome to town! I'm one of your neighbours, and I came to say hello, {you}.", s: 0.4,
        replies: [
          { text: "Thank you! It's good to meet a neighbour so soon.", s: 0.4, stance: 'agree' },
          { text: "That's kind. I'm still finding my feet in this town.", s: 0.2, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'Are you settling in, {you}? Welcome, by the way.', s: 0.3,
        replies: [
          { text: "Slowly. Everyone in town has been very welcoming.", s: 0.3, stance: 'agree' },
          { text: "I'm still unpacking. It's a lot to settle into a new town.", s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "I brought a loaf to welcome you, {you}. Bread is the first thing a new house needs.", s: 0.4,
        replies: [
          { text: "What a welcome! Thank you, neighbour.", s: 0.4, stance: 'agree' },
          { text: "You're too kind. I'll remember that welcome.", s: 0.3, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "If you need anything, my door is just down the lane. That's what neighbours are for.", s: 0.3 },
      { text: "You'll settle in quicker than you think. It's a friendly town.", s: 0.3 },
    ],
    close: [
      { text: 'Welcome again, {you}. Come by any time.', s: 0.4, when: byOpener },
      { text: "I'll let you settle in, {you}.", s: 0.3, when: byOpener },
      { text: 'Thank you for the welcome, {you}.', s: 0.3, when: byListener },
      { text: "I'm glad to have such a neighbour, {you}.", s: 0.4, when: byListener },
    ],
  },

  // ===== consolation after a blow =====
  {
    id: 'call_console',
    trigger: callTrigger('console'),
    acks: QUIET_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: (c) => c.intent ?? 'consolation after a hard blow',
    anchors: () => ['sorry', 'hard', 'better', 'chin up'],
    openers: [
      {
        kind: 'tell', text: "I heard, {you}. I'm sorry. That's a hard blow.", s: 0.1,
        replies: [
          { text: "It is hard. I didn't expect it to hurt this much.", s: -0.1, stance: 'agree' },
          { text: "I'll manage. But thank you for saying you're sorry.", s: 0, stance: 'neutral' },
          { text: "I'd sooner not talk about it. I'm sorry.", s: -0.2, stance: 'disagree', voice: ['gruff', 'shy'] },
        ],
      },
      {
        kind: 'ask', text: 'How are you holding up, {you}? It must be hard.', s: 0.1,
        when: (c) => (c.intent ?? '') !== CALL_TOPIC.console_heartbreak,
        replies: [
          { text: "Badly, if I'm honest. It's hard to know what comes next.", s: -0.1, stance: 'agree' },
          { text: "Better than yesterday. It's hard, but I'll find my feet.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: 'Your heart will mend, {you}. Would a walk help you feel better?', s: 0.1,
        when: intentIs(CALL_TOPIC.console_heartbreak),
        replies: [
          { text: "Maybe. It's hard to think of anything but them.", s: -0.1, stance: 'neutral' },
          { text: "A walk might help. Thank you for trying to make it better.", s: 0.1, stance: 'agree' },
        ],
      },
    ],
    follow: [
      { text: "Chin up. Better days come to those who wait for them.", s: 0.1 },
      { text: "It's hard now, but it won't always be.", s: 0.1 },
    ],
    close: [
      { text: "Chin up, {you}. I'm here if you need me.", s: 0.1, when: byOpener },
      { text: "It'll get better, {you}. I promise.", s: 0.1, when: byOpener },
      { text: "Thank you, {you}. I feel a little better.", s: 0.1, when: byListener },
      { text: "I'm sorry to be so low, {you}. Thank you for coming.", s: 0, when: byListener },
    ],
  },

  // ===== asking someone not to leave town =====
  {
    id: 'call_plead_to_stay',
    trigger: callTrigger('plead_to_stay'),
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: () => CALL_TOPIC.plead_to_stay,
    anchors: () => ['stay', 'leave', 'leaving', 'town'],
    openers: [
      {
        kind: 'ask', text: "Is it true you're thinking of leaving, {you}?", s: 0,
        replies: [
          { text: "It's true. I don't know what keeps me in this town any more.", s: -0.2, stance: 'agree' },
          { text: "I've thought about leaving, yes. I haven't decided.", s: -0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "Don't leave, {you}. This town wouldn't be the same without you.", s: 0.2,
        replies: [
          { text: "Do you mean that? I thought nobody would notice if I left town.", s: 0, stance: 'neutral' },
          { text: "You're kind to say it. Maybe I should stay a while longer.", s: 0.1, stance: 'agree' },
        ],
      },
      {
        kind: 'tell', text: "I heard you might be leaving, {you}, and I had to come and ask you to stay.", s: 0.1,
        replies: [
          { text: "I didn't think anyone would care if I left town.", s: -0.1, stance: 'neutral' },
          { text: "That means more than you know. I'll think again about leaving.", s: 0.1, stance: 'agree' },
        ],
      },
    ],
    follow: [
      { text: "Stay. Whatever it is, we'll face it together.", s: 0.2 },
      { text: "You have friends in this town, whatever it feels like.", s: 0.2 },
    ],
    close: [
      { text: "Promise me you'll think about staying, {you}.", s: 0.1, when: byOpener },
      { text: "Sleep on it before you leave, {you}. Please.", s: 0.1, when: byOpener },
      { text: "I'll think about staying, {you}. Thank you.", s: 0.1, when: byListener },
      { text: "Maybe this town isn't done with me yet, {you}.", s: 0.1, when: byListener },
    ],
  },

  // ===== met at the jail door: welcome home =====
  {
    id: 'call_welcome_home',
    trigger: callTrigger('meet_at_gate'),
    cooldownHours: ONCE,
    when: intentIs(CALL_TOPIC.welcome_home),
    weight: heavy,
    topic: () => CALL_TOPIC.welcome_home,
    anchors: () => ['home', 'out', 'behind you'],
    openers: [
      {
        kind: 'tell', text: "There you are, {you}. Come on, let's get you home.", s: 0.3,
        replies: [
          { text: "Home. I've thought of nothing else in there.", s: 0.2, stance: 'agree' },
          { text: "I didn't think anyone would be waiting when I came out.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'ask', text: "Are you all right, {you}? It's good to have you out.", s: 0.2,
        replies: [
          { text: "Better now that I'm out. Thank you for coming.", s: 0.2, stance: 'agree' },
          { text: "Tired. Ashamed. But glad to be out.", s: 0, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "It's behind you now. Nobody needs to rake it up.", s: 0.2 },
      { text: "A hot meal at home, and tomorrow is a new day.", s: 0.2 },
    ],
    close: [
      { text: "Let's go home, {you}.", s: 0.2, when: byOpener },
      { text: "Put it behind you, {you}.", s: 0.2, when: byOpener },
      { text: "Thank you for waiting for me to come out, {you}.", s: 0.2, when: byListener },
      { text: "I won't forget you came, {you}. Let's go home.", s: 0.2, when: byListener },
    ],
  },

  // ===== met at the jail door: a piece of someone's mind =====
  {
    id: 'call_reproach',
    trigger: callTrigger('meet_at_gate'),
    acks: {
      agree: [{ text: 'Good.', s: -0.1 }],
      disagree: [{ text: 'Is that so.', s: -0.2 }, { text: 'Hmph.', s: -0.2 }],
      neutral: [{ text: 'Hmph.', s: -0.2 }],
    },
    cooldownHours: ONCE,
    when: intentIs(CALL_TOPIC.reproach),
    weight: heavy,
    topic: () => CALL_TOPIC.reproach,
    anchors: () => ['jail', 'shame', 'ashamed', 'again'],
    openers: [
      {
        kind: 'tell', text: "Jail, {you}. I never thought I'd see the day.", s: -0.3,
        replies: [
          { text: "Don't. I've had enough shame in there to last me.", s: -0.3, stance: 'disagree' },
          { text: "I know. I'm ashamed of it too.", s: -0.1, stance: 'agree' },
        ],
      },
      {
        kind: 'ask', text: 'Do you know the shame you brought on all of us, {you}?', s: -0.4,
        replies: [
          { text: "I know the shame. You needn't spell it out.", s: -0.3, stance: 'neutral' },
          { text: "I'm ashamed. I won't do it again.", s: -0.1, stance: 'agree' },
        ],
      },
    ],
    follow: [
      { text: "See that it never happens again.", s: -0.2 },
      { text: "The whole town knows you were in jail. Remember that.", s: -0.3 },
    ],
    close: [
      { text: "Don't make me ashamed of you again, {you}.", s: -0.3, when: byOpener },
      { text: "I've said my piece about the jail, {you}.", s: -0.2, when: byOpener },
      { text: "I've had enough shame for one day, {you}.", s: -0.3, when: byListener },
      { text: "I won't go back to jail, {you}. You'll see.", s: -0.1, when: byListener },
    ],
  },

  // ===== an offer of a loan =====
  {
    id: 'call_loan',
    trigger: callTrigger('lend_money'),
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: () => CALL_TOPIC.lend_money,
    anchors: () => ['money', 'loan', 'pay', 'feet'],
    openers: [
      {
        kind: 'tell', text: "I hear money's been tight, {you}. Let me lend you a little.", s: 0.2,
        replies: [
          { text: "I hate to take it, but I need the money. I'll pay you back.", s: 0.1, stance: 'agree' },
          { text: "A loan? You're a better friend than I deserve. I'll pay every penny.", s: 0.2, stance: 'agree' },
        ],
      },
      {
        kind: 'ask', text: 'Would a loan help you back on your feet, {you}?', s: 0.2,
        replies: [
          { text: "It would. I'll pay it back as soon as I'm on my feet.", s: 0.1, stance: 'agree' },
          { text: "I'm ashamed to say yes, but a loan would save me. I'll pay it back.", s: 0, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "Pay me back when you're on your feet. No rush.", s: 0.2 },
      { text: "It's only money. Friends matter more.", s: 0.2 },
    ],
    close: [
      { text: "Take the money, {you}, and no more talk of shame.", s: 0.2, when: byOpener },
      { text: "Get back on your feet, {you}. That's all I ask.", s: 0.2, when: byOpener },
      { text: "I'll pay back every penny, {you}. Thank you.", s: 0.2, when: byListener },
      { text: "You won't regret the loan, {you}.", s: 0.2, when: byListener },
    ],
  },
];
