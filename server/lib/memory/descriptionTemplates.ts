type TemplateContext = Record<string, string | number>;

type TemplateFn = (ctx: TemplateContext) => string;

const TEMPLATES: Record<string, TemplateFn[]> = {
  arrival: [
    (ctx) => `${ctx.agent} arrived at ${ctx.location}.`,
    (ctx) => `${ctx.agent} walked into ${ctx.location}.`,
    (ctx) => `${ctx.agent} showed up at ${ctx.location}.`,
  ],
  departure: [
    (ctx) => `${ctx.agent} left ${ctx.location}.`,
    (ctx) => `${ctx.agent} walked away from ${ctx.location}.`,
    (ctx) => `${ctx.agent} departed from ${ctx.location}.`,
  ],
  conversation_start: [
    (ctx) => `${ctx.agent} started talking with ${ctx.other}.`,
    (ctx) => `${ctx.agent} and ${ctx.other} began a conversation.`,
    (ctx) => `${ctx.agent} struck up a conversation with ${ctx.other}.`,
  ],
  conversation_end: [
    (ctx) => `${ctx.agent} finished talking with ${ctx.other}.`,
    (ctx) => `${ctx.agent} and ${ctx.other} wrapped up their conversation.`,
    (ctx) => `${ctx.agent} parted ways with ${ctx.other} after talking.`,
  ],
  state_triggered: [
    (ctx) => `${ctx.agent} is now ${ctx.state}.`,
    (ctx) => `${ctx.agent} became ${ctx.state}.`,
    (ctx) => `A ${ctx.state} state came over ${ctx.agent}.`,
  ],
  state_cleared: [
    (ctx) => `${ctx.agent} is no longer ${ctx.state}.`,
    (ctx) => `${ctx.agent} recovered from being ${ctx.state}.`,
    (ctx) => `The ${ctx.state} state cleared for ${ctx.agent}.`,
  ],
  relationship_changed: [
    (ctx) => `${ctx.agent}'s relationship with ${ctx.other} changed to ${ctx.status}.`,
    (ctx) => `${ctx.agent} and ${ctx.other} are now ${ctx.status}.`,
    (ctx) => `The bond between ${ctx.agent} and ${ctx.other} shifted — they are now ${ctx.status}.`,
  ],
  relationship_sentiment: [
    (ctx) => `${ctx.agent} feels ${ctx.sentiment} towards ${ctx.other}.`,
    (ctx) => `${ctx.agent}'s feelings toward ${ctx.other} are ${ctx.sentiment}.`,
    (ctx) => `${ctx.agent} thinks of ${ctx.other} with ${ctx.sentiment} feelings.`,
  ],
  gossip_learned: [
    (ctx) => `${ctx.agent} heard gossip: "${ctx.content}".`,
    (ctx) => `${ctx.agent} learned some gossip from ${ctx.source}: "${ctx.content}".`,
    (ctx) => `Word reached ${ctx.agent} that ${ctx.content}.`,
  ],
  gossip_shared: [
    (ctx) => `${ctx.agent} shared gossip with ${ctx.other}: "${ctx.content}".`,
    (ctx) => `${ctx.agent} told ${ctx.other} that ${ctx.content}.`,
    (ctx) => `${ctx.agent} passed on gossip to ${ctx.other}.`,
  ],
  need_critical: [
    (ctx) => `${ctx.agent}'s ${ctx.need} has reached a critical level.`,
    (ctx) => `${ctx.agent} is in desperate need of ${ctx.need}.`,
    (ctx) => `${ctx.agent} can no longer ignore their ${ctx.need}.`,
  ],
  economy_transaction: [
    (ctx) => `${ctx.agent} ${ctx.action} ${ctx.item} for ${ctx.amount}g.`,
    (ctx) => `${ctx.agent} spent ${ctx.amount}g on ${ctx.item}.`,
    (ctx) => `${ctx.agent} completed a transaction: ${ctx.item} for ${ctx.amount}g.`,
  ],
  economy_distress: [
    (ctx) => `${ctx.agent} is experiencing financial hardship.`,
    (ctx) => `${ctx.agent} is struggling to make ends meet.`,
    (ctx) => `${ctx.agent}'s finances are in a critical state.`,
  ],
  world_event: [
    (ctx) => `A ${ctx.event} is happening in ${ctx.location}.`,
    (ctx) => `Word spread about a ${ctx.event} in ${ctx.location}.`,
    (ctx) => `${ctx.agent} witnessed a ${ctx.event} at ${ctx.location}.`,
  ],
  interaction_completed: [
    (ctx) => `${ctx.agent} completed an interaction with ${ctx.other}.`,
    (ctx) => `${ctx.agent} and ${ctx.other} finished their interaction.`,
    (ctx) => `The interaction between ${ctx.agent} and ${ctx.other} concluded.`,
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
