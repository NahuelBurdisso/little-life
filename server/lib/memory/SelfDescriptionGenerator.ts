import { db } from '../../db';
import { agents, agentStates, economy } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../../lib/constants';
import { buildPersonalityDescription, type PersonalityProfile } from '../personality';
import type { MemoryService } from './MemoryService';

const REGENERATION_INTERVAL_DAYS = 3; // regenerate every 3 game days

export class SelfDescriptionGenerator {
  private lastGenerated: Map<number, number> = new Map(); // agentId → day

  constructor(private memoryService: MemoryService) {}

  async maybeRegenerate(agentId: number, currentDay: number): Promise<void> {
    const lastDay = this.lastGenerated.get(agentId) ?? 0;
    if (currentDay - lastDay < REGENERATION_INTERVAL_DAYS) return;

    await this.regenerate(agentId, currentDay);
    this.lastGenerated.set(agentId, currentDay);
  }

  async regenerate(agentId: number, currentDay: number): Promise<void> {
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) return;
    if ((agent.current_action as any)?.type === 'dead') return;

    const personality = agent.personality as PersonalityProfile | null;
    if (!personality) return;
    const traits = Array.isArray(agent.traits) ? (agent.traits as string[]) : [];

    // 3 retrieval queries (paper-faithful)
    const [coreMemories, occupationMemories, progressMemories] = await Promise.all([
      this.memoryService.retrieve(agentId, `What are ${agent.name}'s core characteristics and values?`, 5),
      this.memoryService.retrieve(agentId, `What is ${agent.name}'s current daily routine and occupation?`, 5),
      this.memoryService.retrieve(agentId, `How does ${agent.name} feel about their recent progress in life?`, 5),
    ]);

    // Deduplicate
    const seen = new Set<number>();
    const allMemories: string[] = [];
    for (const results of [coreMemories, occupationMemories, progressMemories]) {
      for (const r of results) {
        if (!seen.has(r.memory.id)) {
          seen.add(r.memory.id);
          allMemories.push(r.memory.description);
        }
      }
    }

    // Get current states for context
    const activeStates = db.select({ type: agentStates.type }).from(agentStates).where(eq(agentStates.agent_id, agentId)).all();
    const stateList = activeStates.map((s) => s.type).join(', ');

    // Get economy for context
    const econ = db.select({ money: economy.money, job_title: economy.job_title }).from(economy).where(eq(economy.agent_id, agentId)).get();

    const personalityDesc = buildPersonalityDescription(personality, traits);

    const system = `You are summarizing ${agent.name}'s current self-concept based on their recent experiences.

${agent.name} is a ${agent.age}-year-old. ${personalityDesc}
${econ?.job_title ? `Works as: ${econ.job_title}` : 'Currently unemployed'}
${stateList ? `Current emotional state: ${stateList}` : ''}

Their recent memories and reflections:
${allMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Write a 2-3 sentence summary of how ${agent.name} currently sees themselves — their identity, what matters to them right now, and how they feel about their life. Write in third person. Be specific and grounded in the memories above, not generic.`;

    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        purpose: 'self_description',
        system,
        messages: [{ role: 'user', content: `Summarize ${agent.name}'s current self-concept.` }],
        priority: 'low',
        options: { temperature: 0.7, num_predict: 200 },
      });

      const description = response.text.trim();
      if (description.length > 10) {
        db.update(agents).set({ self_description: description }).where(eq(agents.id, agentId)).run();
        console.log(`[SelfDescription] Updated ${agent.name} (day ${currentDay}): ${description.substring(0, 60)}...`);
      }
    } catch (err) {
      console.warn(`[SelfDescription] Failed for ${agent.name}:`, (err as Error).message);
    }
  }

  clear(): void {
    this.lastGenerated.clear();
  }
}
