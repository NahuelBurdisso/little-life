/**
 * Template-tier scripts for chats at gatherings (lib/gatherings): two people at
 * the same funeral, wake, send-off, market, fire, wedding or christening talk
 * about the occasion, not the weather.
 *
 * Same contract as the social-call scripts (data/socialCallScripts.ts): every
 * line carries one of the script's anchors, a question gets an answer written
 * for it, `{you}` is the other one's first name, the town is around 1900. Each
 * names the `trigger` it is for (`gathering:<kind>`) and is played FIRST for a
 * chat queued with it (lib/templateChat.ts `callScriptsFor`).
 *
 * The topic is the queue entry's own ("remembering Tom at the funeral"), so the
 * conversation row and the memories name the person.
 *
 * Pure data, no DB imports.
 */
import type { ChatContext, TopicScript } from './smallTalkScripts';
import { gatheringTrigger } from '../lib/gatherings/topics';

const QUIET_ACKS = {
  agree: [{ text: 'I know.', s: 0 }, { text: 'Yes.', s: 0.1 }],
  disagree: [{ text: "Well. Each grieves their own way.", s: 0 }, { text: 'Perhaps.', s: 0 }],
  neutral: [{ text: 'Mm.', s: 0 }, { text: 'I see.', s: 0 }],
};
const BRISK_ACKS = {
  agree: [{ text: 'Right!', s: 0.1 }, { text: 'Aye!', s: 0.1 }],
  disagree: [{ text: 'No time to argue!', s: 0 }, { text: 'Never mind that!', s: 0 }],
  neutral: [{ text: 'Go on!', s: 0 }, { text: 'Quick, then!', s: 0 }],
};
/** Every gathering chat may be had again at the next one; the per-pair cooldown would only get in the way. */
const ONCE = 0;
const always = () => true;
const heavy = () => 10;
const topicOr = (fallback: string) => (c: ChatContext) => (c.intent && c.intent.trim()) || fallback;

export const GATHERING_SCRIPTS: TopicScript[] = [
  // ===== the funeral =====
  {
    id: 'gather_funeral',
    trigger: gatheringTrigger('funeral'),
    acks: QUIET_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: topicOr('remembering the dead at the funeral'),
    anchors: () => ['gone', 'miss', 'buried', 'remember', 'funeral', 'grave', 'rest'],
    openers: [
      {
        kind: 'ask', text: 'How are you bearing up, {you}? I can hardly believe they are gone.', s: -0.1,
        replies: [
          { text: "I keep thinking I'll see them on the road. I'll miss them more than I can say.", s: -0.2, stance: 'agree' },
          { text: "As well as anyone can at a funeral. I remember them laughing, mostly.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: 'I remember the first time I met them, {you}. Kind, from the first word.', s: 0.1,
        replies: [
          { text: "That's how I'll remember them too. Kind, and gone too soon.", s: 0, stance: 'agree' },
          { text: "I hadn't heard that one. I'm glad you remember it.", s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: 'A good turnout for the funeral, {you}. They would have liked that.', s: 0,
        replies: [
          { text: "They would. Half the town came to see them buried.", s: 0.1, stance: 'agree' },
          { text: "I'd hoped for more at the funeral, truth be told.", s: -0.1, stance: 'disagree' },
        ],
      },
    ],
    follow: [
      { text: "May they rest easy now.", s: 0 },
      { text: "We'll all miss them at the tavern of an evening.", s: -0.1 },
      { text: "I'll tend the grave come spring, if no one else does.", s: 0.1 },
    ],
    close: [
      { text: "Rest well. I'll remember them, {you}.", s: 0 },
      { text: "Look after yourself, {you}. They're gone, but we're still here.", s: 0.1 },
    ],
  },
  // ===== the wake =====
  {
    id: 'gather_wake',
    trigger: gatheringTrigger('wake'),
    acks: QUIET_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: topicOr('drinking to the dead at the wake'),
    anchors: () => ['drink', 'glass', 'story', 'remember', 'toast', 'laugh'],
    openers: [
      {
        kind: 'ask', text: 'Do you remember the story of the runaway pig, {you}?', s: 0.2,
        replies: [
          { text: "Remember it! I laughed till I cried. They never lived it down.", s: 0.3, stance: 'agree' },
          { text: "I only heard the story second-hand. Tell it again.", s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: 'Raise your glass, {you}. To the best of us.', s: 0.2,
        replies: [
          { text: "To the best of us. I'll drink to that.", s: 0.2, stance: 'agree' },
          { text: "One glass for them, then. They'd want us to laugh tonight.", s: 0.1, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "They'd have stood the next drink themselves, you know.", s: 0.2 },
      { text: "Another story, then, and another glass.", s: 0.2 },
    ],
    close: [
      { text: "One last toast, {you}, and then home.", s: 0.1 },
      { text: "I'll remember tonight, {you}. Thank you for the company and the drink.", s: 0.2 },
    ],
  },
  // ===== the send-off =====
  {
    id: 'gather_send_off',
    trigger: gatheringTrigger('send_off'),
    acks: QUIET_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: topicOr('seeing a friend off'),
    anchors: () => ['leaving', 'goodbye', 'miss', 'road', 'write', 'gone', 'town'],
    openers: [
      {
        kind: 'ask', text: "Did you ever think they'd really go, {you}? Leaving, just like that.", s: -0.1,
        replies: [
          { text: "I hoped they'd change their mind about leaving. I'll miss them.", s: -0.1, stance: 'agree' },
          { text: "I saw it coming. This town was never easy on them.", s: -0.2, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "I've packed them some bread for the road, {you}.", s: 0.2,
        replies: [
          { text: "That's good of you. It's a long road out of town.", s: 0.1, stance: 'agree' },
          { text: "They'll need more than bread where they're going, on that road.", s: 0, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "I made them promise to write.", s: 0.1 },
      { text: "The town feels smaller already, with them gone.", s: -0.1 },
    ],
    close: [
      { text: "Well. Goodbye is goodbye, {you}.", s: 0 },
      { text: "Let's wave them down the road together, {you}.", s: 0.1 },
    ],
  },
  // ===== market day =====
  {
    id: 'gather_market',
    trigger: gatheringTrigger('market'),
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: topicOr('market day: prices, wares and news'),
    anchors: () => ['market', 'price', 'stall', 'bought', 'sell', 'bargain', 'cheap', 'eggs', 'bread'],
    openers: [
      {
        kind: 'ask', text: 'Found any bargains at the market, {you}?', s: 0.2,
        replies: [
          { text: "Eggs, cheap as I've ever seen them. The market's good today.", s: 0.2, stance: 'agree' },
          { text: "Not a bargain in sight. Every stall has put its price up.", s: -0.1, stance: 'disagree' },
          { text: "Only some bread. I'm here for the company more than the stalls.", s: 0.1, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "That stall by the well wants twice the fair price for its bread, {you}.", s: -0.1,
        replies: [
          { text: "Haggle! They'll come down on the price if you walk away.", s: 0.1, stance: 'neutral' },
          { text: "Market day prices. I bought mine at the bakery yesterday.", s: 0, stance: 'agree' },
        ],
      },
    ],
    follow: [
      { text: "I sold the last of my eggs before ten. A good market.", s: 0.2 },
      { text: "Half the town's at the market. All the news is here.", s: 0.1 },
    ],
    close: [
      { text: "I'd best finish at the market before the stalls close, {you}.", s: 0.1 },
      { text: "Good bargains to you, {you}.", s: 0.2 },
    ],
  },
  // ===== the fire =====
  {
    id: 'gather_fire',
    trigger: gatheringTrigger('fire'),
    acks: BRISK_ACKS,
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: topicOr('the fire'),
    anchors: () => ['fire', 'water', 'bucket', 'smoke', 'flames', 'well', 'roof'],
    openers: [
      {
        kind: 'ask', text: 'Is anyone still inside, {you}? The smoke is pouring out!', s: -0.2,
        replies: [
          { text: "No, they're out! It's the roof we have to save now.", s: 0, stance: 'agree' },
          { text: "I don't know! Get more water on those flames!", s: -0.2, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: 'Grab a bucket, {you}! Form a line to the well!', s: 0,
        replies: [
          { text: "Here! Pass the water this way!", s: 0.1, stance: 'agree' },
          { text: "The well's too far, we'll never stop the fire like this!", s: -0.2, stance: 'disagree' },
        ],
      },
    ],
    follow: [
      { text: "Keep the water coming!", s: 0 },
      { text: "Wet the roof next door before the flames jump!", s: 0 },
    ],
    close: [
      { text: "More water, {you}! Don't stop!", s: 0 },
      { text: "Back to the bucket line, {you}!", s: 0 },
    ],
  },
  // ===== the wedding =====
  {
    id: 'gather_wedding',
    trigger: gatheringTrigger('wedding'),
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: topicOr('the wedding'),
    anchors: () => ['wedding', 'couple', 'bride', 'dance', 'happy', 'married', 'vows'],
    openers: [
      {
        kind: 'ask', text: "Doesn't the couple look happy, {you}?", s: 0.3,
        replies: [
          { text: "The happiest couple in town. A fine wedding.", s: 0.3, stance: 'agree' },
          { text: "Happy enough today. Married life is the long part.", s: 0, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: "I'll have the first dance after the couple, {you}, if you'll have me.", s: 0.3,
        replies: [
          { text: "A dance at a wedding? Gladly.", s: 0.3, stance: 'agree' },
          { text: "My feet are no good for a dance, but I'll clap for the couple.", s: 0.1, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "Did you hear the vows? Not a dry eye on the square.", s: 0.3 },
      { text: "Here's to the happy couple, married at last.", s: 0.3 },
    ],
    close: [
      { text: "To the happy couple, {you}!", s: 0.3 },
      { text: "A lovely wedding. I'll go and dance, {you}.", s: 0.3 },
    ],
  },
  // ===== the christening =====
  {
    id: 'gather_christening',
    trigger: gatheringTrigger('christening'),
    cooldownHours: ONCE,
    when: always,
    weight: heavy,
    topic: topicOr('the christening'),
    anchors: () => ['baby', 'little', 'christening', 'parents', 'child', 'cried'],
    openers: [
      {
        kind: 'ask', text: 'Did you see the baby, {you}?', s: 0.3,
        replies: [
          { text: "The sweetest little thing. The parents are beaming.", s: 0.3, stance: 'agree' },
          { text: "Only the top of a little bonnet. The baby slept through it all.", s: 0.2, stance: 'neutral' },
        ],
      },
      {
        kind: 'tell', text: 'The baby cried all through the christening, {you}.', s: 0.2,
        replies: [
          { text: "Good lungs on that little one! They'll be a singer.", s: 0.3, stance: 'agree' },
          { text: "They all cry at a christening. It means good luck.", s: 0.2, stance: 'neutral' },
        ],
      },
    ],
    follow: [
      { text: "The parents look worn out and proud as anything.", s: 0.2 },
      { text: "A new little one in town. That's good news for all of us.", s: 0.3 },
    ],
    close: [
      { text: "Bless the baby, {you}.", s: 0.3 },
      { text: "I'll go and congratulate the parents, {you}.", s: 0.3 },
    ],
  },
];
