/* Scratch harness — measures how many retrieved memories survive
 * selectConversationContext once conversationHelpers zeroes their metadata.
 * READ-ONLY against data/scratch-conv.db. */

process.env.DATABASE_PATH = './data/scratch-conv.db';

async function main() {
  const { db } = await import('../../server/db');
  const schema = await import('../../server/db/schema');
  const { selectConversationContext } = await import('../../server/ai/contextSelector');
  const { eq, and } = await import('drizzle-orm');

  const active = db.select().from(schema.agents).where(eq(schema.agents.is_active, true)).all();
  const world = db.select().from(schema.worldState).get()!;
  const currentTick = (world.time as any).totalTicks as number;

  let totalIn = 0, keptFlat = 0, keptReal = 0;
  const perPair: string[] = [];

  for (const speaker of active) {
    const other = active.find((a) => a.id !== speaker.id)!;
    // Top-6 recent memories, the same slice size MEMORY_RETRIEVAL_LIMIT uses.
    const mems = db.select().from(schema.memories)
      .where(and(eq(schema.memories.agent_id, speaker.id), eq(schema.memories.is_active, 1)))
      .all()
      .sort((a: any, b: any) => b.created_at - a.created_at)
      .slice(0, 6);
    if (mems.length === 0) continue;

    // (a) exactly what conversationHelpers.ts:186-202 hands to the prompt builder
    const flat = mems.map(() => 0).map((_, i) => ({
      description: (mems[i] as any).description as string,
      emotional_valence: 0,
      created_at: currentTick,
      metadata: {} as Record<string, unknown>,
    }));

    // (b) the same memories with their real DB columns preserved
    const real = mems.map((m: any) => ({
      description: m.description as string,
      emotional_valence: m.emotional_valence as number,
      created_at: m.created_at as number,
      metadata: (m.metadata ?? {}) as Record<string, unknown>,
    }));

    const base = {
      facts: [], statePrompts: [], situationalPrompt: null,
      otherAgentName: other.name, otherAgentId: other.id,
      topic: null as string | null, currentTick, friendship: 0,
    };

    const outFlat = selectConversationContext({ ...base, memories: flat })
      .filter((i) => i.type === 'memory').length;
    const outReal = selectConversationContext({ ...base, memories: real })
      .filter((i) => i.type === 'memory').length;

    totalIn += mems.length;
    keptFlat += outFlat;
    keptReal += outReal;
    perPair.push(`  ${speaker.name} -> ${other.name}: in=${mems.length} kept(flattened)=${outFlat} kept(real cols)=${outReal}`);
  }

  console.log('topic = null, friendship = 0, no name match required\n');
  console.log(perPair.join('\n'));
  console.log(`\nTOTAL retrieved memories: ${totalIn}`);
  console.log(`  survive selectConversationContext as actually wired : ${keptFlat}`);
  console.log(`  survive if real emotional_valence/created_at kept   : ${keptReal}`);

  // Show the arithmetic for one memory with no name/topic match.
  const probe = selectConversationContext({
    memories: [{ description: 'walked to the bakery and bought bread', emotional_valence: -0.9, created_at: currentTick, metadata: {} }],
    facts: [], statePrompts: [], situationalPrompt: null,
    otherAgentName: 'Zzz', otherAgentId: 99999, topic: null, currentTick, friendship: -50,
  });
  console.log(`\nprobe (strongly negative memory, hostile pair, valence zeroed): kept=${probe.length}`);
  const probe2 = selectConversationContext({
    memories: [{ description: 'walked to the bakery and bought bread', emotional_valence: -0.9, created_at: currentTick - 10, metadata: {} }],
    facts: [], statePrompts: [], situationalPrompt: null,
    otherAgentName: 'Zzz', otherAgentId: 99999, topic: null, currentTick, friendship: -50,
  });
  console.log(`probe (same memory, valence preserved)                       : kept=${probe2.length}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
