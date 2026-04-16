import { db } from '../../db';
import { agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../../lib/constants';
import type { PersonalityProfile } from '../../lib/personality';
import type { MemoryService } from './MemoryService';
import type { RetrievalResult } from './types';
import { buildQuestionPrompt, buildSynthesisPrompt } from './reflectionPrompts';
import { parseQuestions, parseInsights } from './reflectionParser';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUESTION_MEMORY_COUNT = 50;
const EVIDENCE_PER_QUESTION = 10;
const MAX_EVIDENCE_TOTAL = 15;
const INTER_REFLECTION_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// ReflectionRunner
// ---------------------------------------------------------------------------

export class ReflectionRunner {
  private memoryService: MemoryService;
  private queue: number[] = [];
  private running = false;

  constructor(memoryService: MemoryService) {
    this.memoryService = memoryService;
  }

  /**
   * Enqueue a reflection for the given agent. Deduplicates if agent is already
   * in the queue. Starts queue processing if not already running.
   */
  queueReflection(agentId: number): void {
    if (this.queue.includes(agentId)) return;
    this.queue.push(agentId);
    if (!this.running) {
      void this.processQueue();
    }
  }

  /**
   * Clear all pending reflections from the queue.
   */
  clearQueue(): void {
    this.queue.length = 0;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const agentId = this.queue.shift()!;
        try {
          await this.runReflection(agentId);
        } catch (err) {
          console.error(`[ReflectionRunner] Error reflecting for agent ${agentId}:`, err);
        }
        if (this.queue.length > 0) {
          await delay(INTER_REFLECTION_DELAY_MS);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runReflection(agentId: number): Promise<void> {
    // 1. Load agent from DB
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) {
      console.warn(`[ReflectionRunner] Agent ${agentId} not found in DB`);
      return;
    }

    const personality = agent.personality as PersonalityProfile | null;
    if (!personality) {
      console.warn(`[ReflectionRunner] Agent ${agent.name} has no personality, skipping reflection`);
      return;
    }

    const name = agent.name;
    const age = agent.age;
    const traits = Array.isArray(agent.traits)
      ? (agent.traits as string[]).map((t) => t.trim()).filter(Boolean)
      : String(agent.traits).split(',').map((t) => t.trim()).filter(Boolean);

    // 2. Get recent memories; skip if too few
    const recentMemories = this.memoryService.getRecent(agentId, QUESTION_MEMORY_COUNT);
    if (recentMemories.length < 5) return;

    // 3. Build question prompt
    const { system: qSystem, user: qUser } = buildQuestionPrompt({
      name,
      age,
      traits,
      personality,
      recentMemories,
    });

    // 4. Call LLM for questions
    const questionResponse = await callOllamaChat({
      model: CONFIG.AI.CHAT_MODEL,
      system: qSystem,
      messages: [{ role: 'user', content: qUser }],
      priority: 'normal',
      options: { temperature: 0.7, num_predict: 256 },
    });

    // 5. Parse questions; skip if empty
    const questions = parseQuestions(questionResponse.text);
    if (questions.length === 0) return;

    // 6. Retrieve evidence in parallel for each question
    const evidenceArrays: RetrievalResult[][] = await Promise.all(
      questions.map((q) => this.memoryService.retrieve(agentId, q, EVIDENCE_PER_QUESTION)),
    );

    // 7. Deduplicate: keep highest score per memory, sort desc, take top MAX_EVIDENCE_TOTAL
    const evidenceMap = new Map<number, RetrievalResult>();
    for (const results of evidenceArrays) {
      for (const result of results) {
        const existing = evidenceMap.get(result.memory.id);
        if (!existing || result.score > existing.score) {
          evidenceMap.set(result.memory.id, result);
        }
      }
    }

    const topEvidence = Array.from(evidenceMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_EVIDENCE_TOTAL);

    // 8. Skip if too few evidence memories
    if (topEvidence.length < 2) return;

    // 9. Build lineNum → memoryId mapping (1-based, matching evidence list indices)
    const lineToMemoryId = new Map<number, number>();
    topEvidence.forEach((result, index) => {
      lineToMemoryId.set(index + 1, result.memory.id);
    });

    // 10. Build synthesis prompt
    const evidenceForPrompt = topEvidence.map((result, index) => ({
      lineNum: index + 1,
      description: result.memory.description,
    }));

    const { system: sSystem, user: sUser } = buildSynthesisPrompt({
      name,
      personality,
      traits,
      questions,
      evidence: evidenceForPrompt,
    });

    // 11. Call LLM for synthesis
    const synthesisResponse = await callOllamaChat({
      model: CONFIG.AI.CHAT_MODEL,
      system: sSystem,
      messages: [{ role: 'user', content: sUser }],
      priority: 'normal',
      options: { temperature: 0.7, num_predict: 512 },
    });

    // 12. Parse insights; skip if empty
    const insights = parseInsights(synthesisResponse.text);
    if (insights.length === 0) return;

    // 13. Store each insight with resolved citation IDs
    for (const insight of insights) {
      const resolvedIds = insight.citations
        .map((lineNum) => lineToMemoryId.get(lineNum))
        .filter((id): id is number => id !== undefined);

      this.memoryService.record(
        agentId,
        'reflection',
        insight.text,
        { subtype: 'reflection', questions, citation_ids: resolvedIds },
        0,
        8,
        1,
        resolvedIds,
      );
    }

    // 14. Log result
    console.log(`[ReflectionRunner] Agent ${name} reflected: ${insights.length} insights from ${questions.length} questions`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
