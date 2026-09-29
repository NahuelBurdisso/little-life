import { db } from '../../db';
import { agents, agentStates, economy } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../../lib/constants';
import { buildPersonalityDescription, type PersonalityProfile } from '../personality';
import type { MemoryService } from './MemoryService';
import { currentWorldEpoch, isStaleWorldEpoch } from '../worldEpoch';

const REGENERATION_INTERVAL_DAYS = 3; // regenerate every 3 game days

export class SelfDescriptionGenerator {
  private lastGenerated: Map<number, number> = new Map(); // agentId → day

  constructor(private memoryService: MemoryService) {}

  async maybeRegenerate(agentId: number, currentDay: number): Promise<void> {
    const lastDay = this.lastGenerated.get(agentId) ?? 0;
    if (currentDay - lastDay < REGENERATION_INTERVAL_DAYS) return;

    const worldEpoch = currentWorldEpoch();
    await this.regenerate(agentId, currentDay);
    // clear() ran during the await: this stamp belongs to the old world.
    if (isStaleWorldEpoch(worldEpoch)) return;
    this.lastGenerated.set(agentId, currentDay);
  }

  async regenerate(agentId: number, currentDay: number): Promise<void> {
    // Written by agent id after two awaits (retrieval, then the model): a world
    // swap in between would hand this description to the new resident who
    // reuses the id.
    const worldEpoch = currentWorldEpoch();
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

    // The description is pasted into every conversation prompt as "About you",
    // so its register becomes the agent's register. Playtest summaries read like
    // therapy notes ("an intentionally curated connector whose self-worth…"),
    // and dialogue drifted into the same jargon.
    const system = `You describe how a townsperson currently sees themselves.

${agent.name}, ${agent.age}. ${personalityDesc}
${econ?.job_title ? `Works as: ${econ.job_title}` : 'Currently unemployed'}
${stateList ? `Current state: ${stateList}` : ''}

Their recent memories and thoughts:
${allMemories.map((m) => `- ${m}`).join('\n')}

In 2 short sentences, third person, plain everyday words: who ${firstNameOf(agent.name)} is, what they care about right now, and what is weighing on them or delighting them. Mention the concrete people and things from the memories. No psychology jargon, no markdown, no preamble.`;

    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        purpose: 'self_description',
        system,
        messages: [{ role: 'user', content: `Describe ${agent.name}.` }],
        priority: 'low',
        options: { temperature: 0.7, num_predict: 160 },
      });

      if (isStaleWorldEpoch(worldEpoch)) return;
      const description = cleanSelfDescription(response.text, agent.name);
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

function firstNameOf(name: string): string {
  return name.replace(/^(Dr|Mr|Mrs|Ms)\.?\s+/i, '').split(/\s+/)[0];
}

/**
 * Strip what must not reach "About you:" in a conversation prompt: markdown
 * emphasis, a preamble line ("Here's a summary:"), wrapping quotes, and a cut
 * trailing sentence when the token cap stopped the model.
 */
export function cleanSelfDescription(raw: string, name: string): string {
  let text = raw.replace(/[*_`#]+/g, '').replace(/\r/g, '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && /^(here|sure|okay|of course|summary|based on)\b/i.test(lines[0]) && !lines[0].includes(firstNameOf(name))) {
    lines.shift();
  }
  text = lines.join(' ').replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
  const lastStop = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
  if (lastStop > 0 && lastStop < text.length - 1) text = text.slice(0, lastStop + 1);
  return text;
}
