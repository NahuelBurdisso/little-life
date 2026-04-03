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
  gossip_learned: [
    (ctx) => `${ctx.source} told me that ${ctx.content}.`,
    (ctx) => `I heard from ${ctx.source}: ${ctx.content}.`,
  ],
  gossip_shared: [
    (ctx) => `I told ${ctx.other} about ${ctx.content}.`,
    (ctx) => `I shared with ${ctx.other} that ${ctx.content}.`,
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
};

/**
 * Return true if a template exists for the given key.
 */
export function hasTemplate(templateKey: string): boolean {
  return templateKey in TEMPLATES;
}

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
