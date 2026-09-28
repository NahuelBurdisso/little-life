/* Scratch harness — READ-ONLY review of conversation completion paths.
 * Runs against data/scratch-conv.db (a copy). Does not touch project source. */

process.env.DATABASE_PATH = './data/scratch-conv.db';
process.env.AUTOPLAY_ENABLED = 'false';

async function main() {
  const { db } = await import('../../server/db');
  const schema = await import('../../server/db/schema');
  const { conversationsTick } = await import('../../server/engine/systems/conversations');
  const { eq } = await import('drizzle-orm');

  const { agents, conversations, conversationSchedulerState, relationshipEvents } = schema as any;

  const world = db.select().from(schema.worldState).get()!;
  const sched = db.select().from(conversationSchedulerState).get()!;
  const active = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const a = active[0], b = active[1];
  console.log(`participants: ${a.id} ${a.name} / ${b.id} ${b.name}, loc=${a.current_location}`);

  const msgs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      speakerId: i % 2 === 0 ? a.id : b.id,
      text: `line ${i} that is definitely long enough to score`,
      sentiment: 0.4,
      topics: ['work'],
      timestamp: Date.now(),
    }));

  async function scenario(name: string, status: string, messageCount: number, maxTurns: number, startedAtOffsetMs: number) {
    const relBefore = db.select().from(relationshipEvents).all().length;
    const convBefore = db.select().from(conversations).all().length;

    const now = Date.now();
    const row = db.insert(conversations).values({
      participants: [a.id, b.id],
      messages: msgs(messageCount),
      location: a.current_location,
      trigger_reason: 'scratch',
      topic: 'the harvest',
      status,
      started_at: now + startedAtOffsetMs,
      ended_at: status === 'ended' ? now : null,
      sentiment: 0.4,
      max_turns: maxTurns,
    }).returning({ id: conversations.id }).get();

    for (const p of [a, b]) {
      db.update(agents).set({
        current_action: { type: 'talking', conversationId: row.id },
        action_started: (world.time as any).totalTicks,
        action_duration: maxTurns * 2,
      }).where(eq(agents.id, p.id)).run();
    }

    db.update(conversationSchedulerState).set({
      active_llm_conversations: [{ conversationId: row.id, startedAt: now + startedAtOffsetMs }],
      stats: sched.stats,
    }).where(eq(conversationSchedulerState.id, sched.id)).run();

    await conversationsTick();

    const after = db.select().from(conversations).where(eq(conversations.id, row.id)).get()!;
    const relAfter = db.select().from(relationshipEvents).all().length;
    const convAfter = db.select().from(conversations).all().length;
    const agentA = db.select().from(agents).where(eq(agents.id, a.id)).get()!;
    const schedAfter = db.select().from(conversationSchedulerState).get()!;

    console.log(`\n=== ${name} ===`);
    console.log(`  status after        : ${after.status}`);
    console.log(`  quality_score       : ${after.quality_score}`);
    console.log(`  relationshipEvents +: ${relAfter - relBefore}`);
    console.log(`  conversations   +   : ${convAfter - convBefore}`);
    console.log(`  agent A action      : ${JSON.stringify(agentA.current_action)}`);
    console.log(`  activeLLM remaining : ${JSON.stringify(schedAfter.active_llm_conversations)}`);
    console.log(`  stats               : ${JSON.stringify(schedAfter.stats)}`);
  }

  // Control: normal completion — status still 'active', turns exhausted.
  await scenario('CONTROL: active + messages == max_turns', 'active', 6, 6, 0);

  // Case 1: the `conversation.status === 'ended'` arm of the Step A predicate.
  await scenario("CASE 1: status already 'ended' (markConversationEnded / death path)", 'ended', 6, 6, 0);

  // Case 2: 60s wall-clock force-end (startedAt 70s in the past).
  await scenario('CASE 2: activeLLM entry older than LLM_CONVERSATION_TIMEOUT_MS', 'active', 6, 6, -70000);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
