import { thatSentence } from '../factText';

type TemplateContext = Record<string, string | number>;

type TemplateFn = (ctx: TemplateContext) => string;

// Templates are first-person — these are private memories from the agent's own perspective.
// No need to reference the agent by name since the memory belongs to them.
const TEMPLATES: Record<string, TemplateFn[]> = {
  arrival: [
    (ctx) => `I arrived at ${ctx.location}.`,
    (ctx) => `I went to ${ctx.location}.`,
    (ctx) => `I headed over to ${ctx.location}.`,
  ],
  departure: [
    (ctx) => `I left ${ctx.location}.`,
    (ctx) => `I headed out from ${ctx.location}.`,
  ],
  conversation_start: [
    (ctx) => `I started talking with ${ctx.other}.`,
    (ctx) => `${ctx.other} and I began a conversation.`,
  ],
  conversation_end: [
    (ctx) => `${ctx.other} and I talked about ${ctx.summary || 'things'}.`,
    (ctx) => `I had a conversation with ${ctx.other} about ${ctx.summary || 'things'}.`,
    (ctx) => `${ctx.other} and I wrapped up our conversation.`,
  ],
  conversation_cut_short: [
    (ctx) => `${ctx.other} and I got cut off while talking about ${ctx.summary || 'things'}.`,
    (ctx) => `My conversation with ${ctx.other} about ${ctx.summary || 'things'} ended before we were done.`,
  ],
  state_triggered: [
    (ctx) => `I started feeling ${ctx.state}.`,
    (ctx) => `I'm ${ctx.state} now.`,
    (ctx) => `A wave of ${ctx.state} came over me.`,
  ],
  state_cleared: [
    (ctx) => `I'm no longer feeling ${ctx.state}.`,
    (ctx) => `The ${ctx.state} feeling has passed.`,
  ],
  relationship_changed: [
    (ctx) => `${ctx.other} and I are now ${ctx.status}.`,
    (ctx) => `My relationship with ${ctx.other} changed — we're ${ctx.status} now.`,
  ],
  relationship_sentiment: [
    (ctx) => `I'm starting to feel ${ctx.sentiment} toward ${ctx.other}.`,
    (ctx) => `My feelings toward ${ctx.other} have shifted — I feel ${ctx.sentiment}.`,
  ],
  // `content` is a whole fact clause ("Yuki and Thomas were once together —
  // and it ended badly.") with its own punctuation, so it goes through
  // thatSentence: "I told X about <clause>" was ungrammatical and the raw
  // splice doubled the period in the memory the LLM later reads back.
  gossip_learned: [
    (ctx) => thatSentence(`${ctx.source} told me`, String(ctx.content)),
    (ctx) => thatSentence(`I heard from ${ctx.source}`, String(ctx.content)),
  ],
  gossip_shared: [
    (ctx) => thatSentence(`I told ${ctx.other}`, String(ctx.content)),
    (ctx) => thatSentence(`I shared with ${ctx.other}`, String(ctx.content)),
  ],
  need_critical: [
    (ctx) => `I really need ${ctx.need}.`,
    (ctx) => `I can't ignore my ${ctx.need} anymore.`,
  ],
  economy_transaction: [
    (ctx) => `I got paid $${ctx.amount} for my work.`,
    (ctx) => `I earned $${ctx.amount} today.`,
  ],
  economy_distress: [
    () => `I'm almost out of money.`,
    () => `I'm struggling financially.`,
  ],
  economy_purchase: [
    (ctx) => `I bought ${ctx.item} for $${ctx.price} at ${ctx.location}.`,
    (ctx) => `I spent $${ctx.price} on ${ctx.item}.`,
  ],
  economy_production: [
    (ctx) => `I produced ${ctx.quantity} ${ctx.item} at work today.`,
  ],
  economy_blackmail: [
    (ctx) => `I had to pay $${ctx.amount} in blackmail money again.`,
    (ctx) => `Another $${ctx.amount} gone to my blackmailer.`,
  ],
  economy_theft_success: [
    (ctx) => `I stole ${ctx.item} from ${ctx.location} — I had no choice.`,
    (ctx) => `Desperate times. I took ${ctx.item} from ${ctx.location}.`,
  ],
  economy_theft_caught: [
    (ctx) => `I got caught stealing ${ctx.item} from ${ctx.location}. Humiliating.`,
  ],
  economy_milestone_up: [
    (ctx) => `I've saved up to $${ctx.amount}. Things are looking up.`,
  ],
  economy_milestone_down: [
    (ctx) => `My money dropped below $${ctx.amount}. Things are getting tight.`,
  ],
  world_event: [
    (ctx) => `There's ${ctx.event} happening in town.`,
    (ctx) => `I noticed ${ctx.event} going on.`,
  ],
  interaction_completed: [
    (ctx) => `I ${ctx.action} with ${ctx.other}.`,
    (ctx) => `${ctx.other} and I had an interaction — ${ctx.action}.`,
  ],
  perception_friend_distressed: [
    (ctx) => `I noticed ${ctx.target} looking really down today.`,
    (ctx) => `I saw ${ctx.target} seemed upset, so I went to check on them.`,
  ],
  perception_enemy: [
    (ctx) => `I spotted ${ctx.target} nearby. We don't get along.`,
  ],
  perception_crush: [
    (ctx) => `I saw ${ctx.target} and my heart skipped a beat.`,
    (ctx) => `I noticed ${ctx.target} nearby and felt nervous.`,
  ],
  perception_partner: [
    (ctx) => `I saw ${ctx.target} and went over to say hello.`,
  ],
  perception_someone_needs_help: [
    (ctx) => `I noticed ${ctx.target} wasn't doing well and offered to help.`,
  ],
  perception_witnessed_crime: [
    (ctx) => `I witnessed ${ctx.target} doing something they shouldn't.`,
  ],
  perception_casual: [
    (ctx) => `I noticed ${ctx.target} nearby and struck up a conversation.`,
  ],
  perception_jealousy: [
    (ctx) => `I saw ${ctx.target} and felt a surge of jealousy.`,
  ],
  perception_general_observation: [
    (ctx) => `I noticed something going on with ${ctx.target}.`,
    (ctx) => `I observed ${ctx.target} nearby — something seemed off.`,
  ],
  goal_created: [
    (ctx) => `I set a new goal: ${ctx.goal}.`,
    (ctx) => `I've decided to pursue ${ctx.goal}.`,
  ],
  goal_completed: [
    (ctx) => `I accomplished my goal: ${ctx.goal}!`,
    (ctx) => `I finally achieved ${ctx.goal}.`,
  ],
  goal_abandoned: [
    (ctx) => `I gave up on my goal to ${ctx.goal}.`,
    (ctx) => `I decided to let go of ${ctx.goal}.`,
  ],
  economy_gambling_won: [
    (ctx) => `I won $${ctx.amount} gambling against ${ctx.opponent}!`,
    (ctx) => `Lady luck smiled on me — won $${ctx.amount} from ${ctx.opponent}.`,
  ],
  economy_gambling_lost: [
    (ctx) => `I lost $${ctx.amount} gambling to ${ctx.opponent}.`,
    (ctx) => `Bad luck gambling — lost $${ctx.amount} to ${ctx.opponent}.`,
  ],
  social_seduction: [
    (ctx) => `I charmed ${ctx.target} with some flirtatious talk.`,
    (ctx) => `I turned on the charm with ${ctx.target}.`,
  ],
  crime_arrested: [
    (ctx) => `I was arrested by ${ctx.constable}. A terrible day.`,
    (ctx) => `${ctx.constable} arrested me. I feel ashamed.`,
  ],
  perception_investigate: [
    (ctx) => `I decided to check on ${ctx.target} — something seemed suspicious.`,
  ],
  anticipation: [
    (ctx) => `I'm looking forward to ${ctx.action} ${ctx.time}.`,
    (ctx) => `I'm thinking about seeing ${ctx.agent} ${ctx.time}.`,
    (ctx) => `I have plans to ${ctx.action} ${ctx.time} — feeling good about it.`,
  ],
};

/**
 * Pick a random variant for the given template key and fill it with context.
 * Falls back to joining context values with " — " for unknown keys.
 */
export function describeEvent(templateKey: string, context: TemplateContext): string {
  const variants = TEMPLATES[templateKey];
  if (!variants || variants.length === 0) {
    return Object.values(context).join(' — ');
  }
  const index = Math.floor(Math.random() * variants.length);
  return variants[index](context);
}
