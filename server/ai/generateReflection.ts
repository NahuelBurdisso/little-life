import { callOllamaChat } from './ollama';
import { getReflectionContext, insertReflectionMemory } from '../helpers/reflectionHelpers';
import { CONFIG } from '../lib/constants';

export async function generateReflection(agentId: number): Promise<void> {
  // 1. Read context
  const context = getReflectionContext(agentId);

  if (!context) return;

  const { agent, needs, economy, world, recentMemories } = context;

  // 2. Skip if no memories today
  if (recentMemories.length === 0) return;

  // 3. Build reflection prompt
  const memoryDescriptions = recentMemories
    .map((m: { description: string }) => `- ${m.description}`)
    .join('\n');

  const moodValue = needs ? Math.round(needs.mood) : 50;
  const moodDescription =
    moodValue > 80 ? 'very happy'
      : moodValue > 60 ? 'content'
      : moodValue > 40 ? 'okay'
      : moodValue > 20 ? 'down'
      : 'miserable';

  const jobTitle = economy ? economy.job_title : 'resident';

  const system = `You are ${agent.name}, a ${agent.age}-year-old ${jobTitle}. ${agent.bio}\nYour traits: ${agent.traits.join(', ')}.\nRespond with a single introspective thought in first person. One sentence only.`;
  const userMessage = `Today's events:\n${memoryDescriptions}\n\nYour mood: ${moodDescription} (${moodValue}/100). Write a single reflective thought about your day.`;

  // 4. Call Ollama
  let reflectionText: string | null = null;

  try {
    const result = await callOllamaChat({
      model: CONFIG.AI.CHAT_MODEL,
      system,
      messages: [{ role: 'user', content: userMessage }],
      baseUrl: process.env.OLLAMA_BASE_URL,
      options: { temperature: 0.9, num_predict: 80 },
    });
    reflectionText = result.text.trim();
  } catch (error) {
    console.error(
      `Reflection generation failed for agent ${agent.name}:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!reflectionText) return;

  // Clean up to single sentence
  const firstSentenceEnd = reflectionText.search(/[.!?]/);
  if (firstSentenceEnd > 0 && firstSentenceEnd < reflectionText.length - 1) {
    reflectionText = reflectionText.slice(0, firstSentenceEnd + 1);
  }

  // 5. Insert memory
  const memoryId = insertReflectionMemory(agentId, reflectionText, world!.time.totalTicks);

  // 6. Queue embedding generation (import lazily to avoid circular dependency issues at module load)
  const { taskRunner } = await import('./taskRunner');
  taskRunner.generateEmbedding(memoryId, reflectionText);
}
