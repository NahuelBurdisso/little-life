/**
 * Benchmark all LLM call paths against Gemma 4 26B abliterated.
 * Tests: conversation, reflection, daily planning, goal review, goal pivot, ambition generation, self-description.
 * Reports timing, token throughput, and response quality.
 */

import { callOllamaChat } from '../server/ai/ollama';
import { callOllamaEmbedding } from '../server/ai/ollama';
import { CONFIG } from '../server/lib/constants';
import { buildGoalReviewPrompt, buildPivotPrompt, buildAmbitionGenerationPrompt } from '../server/lib/goals/goalPrompts';
import { parseGoalReview, parsePivotResult, parseAmbitionGeneration } from '../server/lib/goals/goalParser';

const MODEL = CONFIG.AI.CHAT_MODEL;

interface BenchResult {
  name: string;
  durationMs: number;
  outputLength: number;
  parseSuccess: boolean | null;
  preview: string;
}

async function benchmark(name: string, fn: () => Promise<BenchResult>): Promise<BenchResult> {
  console.log(`\n--- ${name} ---`);
  const start = Date.now();
  try {
    const result = await fn();
    result.durationMs = Date.now() - start;
    console.log(`  Time: ${result.durationMs}ms`);
    console.log(`  Output: ${result.outputLength} chars`);
    if (result.parseSuccess !== null) console.log(`  Parse: ${result.parseSuccess ? 'OK' : 'FAILED'}`);
    console.log(`  Preview: ${result.preview.slice(0, 120)}...`);
    return result;
  } catch (e) {
    const elapsed = Date.now() - start;
    console.log(`  ERROR after ${elapsed}ms: ${e instanceof Error ? e.message : String(e)}`);
    return { name, durationMs: elapsed, outputLength: 0, parseSuccess: false, preview: String(e) };
  }
}

// ─── Test personality for prompts ──────────────────────────────────────────

const testPersonality = {
  honesty: 65, aggression: 30, warmth: 70, impulsiveness: 40,
  vanity: 35, curiosity: 75, loyalty: 80, morality: 60,
  sensuality: 45, neuroticism: 50,
};

async function main() {
  console.log(`\n========================================`);
  console.log(`LLM Benchmark: ${MODEL}`);
  console.log(`========================================`);

  const results: BenchResult[] = [];

  // 1. Basic conversation response
  results.push(await benchmark('Conversation (agent chat)', async () => {
    const r = await callOllamaChat({
      model: MODEL,
      system: `You are Elena Voss, a 34-year-old farmer. You are hardworking, loyal, and skeptical. You are talking to Marco Rivera at the tavern. Keep responses short (1-2 sentences).`,
      messages: [{ role: 'user', content: 'Hey Elena, how\'s the harvest going this season?' }],
      options: { temperature: 0.8, num_predict: 100 },
    });
    return { name: 'Conversation', durationMs: 0, outputLength: r.text.length, parseSuccess: null, preview: r.text };
  }));

  // 2. Conversation with personality + states + goals context (full prompt)
  results.push(await benchmark('Conversation (full context)', async () => {
    const r = await callOllamaChat({
      model: MODEL,
      system: `You are Carlos Mendez, a 45-year-old handyperson. Personality: funny, unreliable, self-deprecating, generous.
You are struggling with money ($25). You owe Rosa months of unpaid debt.
Your life ambition: "Escape poverty and build financial security"
Your current goals: 1. Find a way to earn extra money (strategy: ask around for odd jobs)
You are feeling stressed (mood: 35, stress: 55).
You are talking to Ray Kowalski, the town constable. Ray suspects you of stealing. You suspect Ray planted evidence against you.
Relationship: rivals (friendship: -25, trust: -20).
Keep responses short (1-2 sentences), stay in character.`,
      messages: [{ role: 'user', content: 'Mendez. I need to talk to you about some missing tools from the workshop.' }],
      options: { temperature: 0.8, num_predict: 120 },
    });
    return { name: 'Conversation (full)', durationMs: 0, outputLength: r.text.length, parseSuccess: null, preview: r.text };
  }));

  // 3. Daily plan generation
  results.push(await benchmark('Daily Plan Generation', async () => {
    const r = await callOllamaChat({
      model: MODEL,
      system: `You are Priya Sharma, a 30-year-old baker. Personality: energetic, perfectionist, warm, competitive.
Money: $65. Job: Baker at the bakery.
Wake time: 4:00, Sleep time: 22:00, Work: 5:00-14:00

Your goals:
1. Find a deep, meaningful romantic connection (strategy: spend more time with Thomas at the house)
2. Win the next baking competition (strategy: practice new recipes after work)

Recent reflections:
1. I've been working too hard and neglecting my social life
2. Thomas seems distant lately, I wonder what's bothering him

Yesterday's plan: 4:00-5:00 Morning routine, 5:00-14:00 Work at bakery, 14:00-15:00 Lunch, 15:00-18:00 Practice baking, 18:00-20:00 Socialize at tavern, 20:00-22:00 Home

Valid locations: Home 3, Bakery, Town Square, Tavern, General Store, Clinic, Farm

Create a daily plan with 5-8 time blocks. Format: HH:00-HH:00 Activity at Location`,
      messages: [{ role: 'user', content: 'Plan your day.' }],
      options: { temperature: 0.7, num_predict: 512 },
    });
    return { name: 'Daily Plan', durationMs: 0, outputLength: r.text.length, parseSuccess: null, preview: r.text };
  }));

  // 4. Reflection (question generation)
  results.push(await benchmark('Reflection Questions', async () => {
    const r = await callOllamaChat({
      model: MODEL,
      system: `You are Diego Santos, a 26-year-old musician. You are passionate, impulsive, and dramatic.
Based on your recent experiences, generate exactly 3 questions for self-reflection.
Recent memories:
1. I flirted with Priya at the tavern and Lucia saw
2. I wrote a new song about longing and performed it at the tavern
3. Marco told me to be careful with my heart
4. I noticed Lucia has been avoiding me lately
5. My hand injury is getting better thanks to Dr. Sofia`,
      messages: [{ role: 'user', content: 'What 3 questions should you reflect on?' }],
      options: { temperature: 0.7, num_predict: 200 },
    });
    return { name: 'Reflection Qs', durationMs: 0, outputLength: r.text.length, parseSuccess: null, preview: r.text };
  }));

  // 5. Goal Review (structured JSON)
  results.push(await benchmark('Goal Review (JSON)', async () => {
    const prompt = buildGoalReviewPrompt({
      name: 'Marco Rivera',
      personality: { ...testPersonality, honesty: 40, sensuality: 80, curiosity: 70 },
      traits: ['charming', 'empathetic', 'secretive', 'humorous'],
      ambition: { description: 'Become the most influential person in town', type: 'power' },
      activeGoals: [
        { id: 1, description: 'Learn what James told me when he was drunk', strategy: 'Casually bring it up next time he visits', progress: 0.2, daysActive: 3 },
        { id: 2, description: 'Get closer to Rosa to learn about the ledger', strategy: 'Offer to help at the shop', progress: 0, daysActive: 1 },
      ],
      recentMemories: [
        'Ray came into the tavern asking questions about Carlos',
        'Rosa seemed nervous when I mentioned the town budget',
        'Diego performed a beautiful song about heartbreak',
        'James came in for a drink but left quickly when he saw me',
      ],
      relationshipHighlights: [
        '- Ray Kowalski: enemy (-15), low trust',
        '- Diego Santos: friend (55), music nights',
        '- Carlos Mendez: friend (50), drinking buddy',
      ],
      money: 60,
      job: 'bartender',
      dayNumber: 5,
    });
    const r = await callOllamaChat({
      model: MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      options: { temperature: 0.7, num_predict: 512 },
    });
    const parsed = parseGoalReview(r.text);
    return { name: 'Goal Review', durationMs: 0, outputLength: r.text.length, parseSuccess: parsed !== null, preview: r.text };
  }));

  // 6. Goal Pivot (structured JSON)
  results.push(await benchmark('Goal Pivot (JSON)', async () => {
    const prompt = buildPivotPrompt({
      name: 'Carlos Mendez',
      personality: { ...testPersonality, honesty: 50, morality: 45, impulsiveness: 60, warmth: 40 },
      goalDescription: 'Find a way to earn extra money',
      strategy: 'Ask around for odd jobs at the tavern',
      progress: 0,
      daysActive: 3,
      recentMemories: [
        'Nobody at the tavern had any work for me',
        'Ray was watching me again from across the street',
        'Rosa slipped me some extra credit at the shop',
        'I overheard Elena needs help fixing the barn fence',
      ],
    });
    const r = await callOllamaChat({
      model: MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      options: { temperature: 0.7, num_predict: 200 },
    });
    const parsed = parsePivotResult(r.text);
    return { name: 'Goal Pivot', durationMs: 0, outputLength: r.text.length, parseSuccess: parsed !== null, preview: r.text };
  }));

  // 7. Ambition Generation (structured JSON)
  results.push(await benchmark('Ambition Generation (JSON)', async () => {
    const prompt = buildAmbitionGenerationPrompt({
      name: 'Omar Hassan',
      personality: { ...testPersonality, aggression: 20, warmth: 80, honesty: 75, curiosity: 65 },
      traits: ['quiet', 'dependable', 'observant', 'guarded'],
      recentMemories: [
        'I saw Ray shove Carlos behind the tavern',
        'Sofia and I had a quiet dinner at the clinic',
        'The garden is growing well this spring',
        'I helped a patient recover from a fever',
      ],
      money: 55,
      job: 'medical_assistant',
      relationshipHighlights: [
        '- Dr. Sofia Petrov: friend (50), coworker',
        '- Carlos Mendez: acquaintance (40)',
      ],
    });
    const r = await callOllamaChat({
      model: MODEL,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      options: { temperature: 0.8, num_predict: 200 },
    });
    const parsed = parseAmbitionGeneration(r.text);
    return { name: 'Ambition Gen', durationMs: 0, outputLength: r.text.length, parseSuccess: parsed !== null, preview: r.text };
  }));

  // 8. Embedding generation
  results.push(await benchmark('Embedding (single text)', async () => {
    const start = Date.now();
    const result = await callOllamaEmbedding('Carlos Mendez was seen arguing with Ray Kowalski behind the tavern late at night');
    const elapsed = Date.now() - start;
    return { name: 'Embedding', durationMs: elapsed, outputLength: result.length, parseSuccess: null, preview: `Vector dim=${result.length}, first 3: [${result.slice(0, 3).map(v => v.toFixed(4)).join(', ')}]` };
  }));

  // 9. Embedding batch (5 texts)
  results.push(await benchmark('Embedding (batch of 5)', async () => {
    const texts = [
      'Elena harvested wheat from the farm',
      'Marco poured drinks at the tavern',
      'Rosa counted money at the shop',
      'Diego played guitar at the town square',
      'Yuki read a book at home',
    ];
    const start = Date.now();
    const embeddings = await Promise.all(texts.map(t => callOllamaEmbedding(t)));
    const elapsed = Date.now() - start;
    return { name: 'Embedding Batch', durationMs: elapsed, outputLength: embeddings.length, parseSuccess: null, preview: `5 vectors, dim=${embeddings[0].length} each` };
  }));

  // ─── Summary ────────────────────────────────────────────────────────────

  console.log(`\n========================================`);
  console.log(`SUMMARY`);
  console.log(`========================================`);
  console.log(`\n${'Test'.padEnd(30)} ${'Time'.padStart(8)} ${'Chars'.padStart(8)} ${'Parse'.padStart(8)}`);
  console.log(`${'─'.repeat(30)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
  for (const r of results) {
    const parseStr = r.parseSuccess === null ? 'n/a' : r.parseSuccess ? 'OK' : 'FAIL';
    console.log(`${r.name.padEnd(30)} ${(r.durationMs + 'ms').padStart(8)} ${(r.outputLength + '').padStart(8)} ${parseStr.padStart(8)}`);
  }

  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const llmResults = results.filter(r => r.name !== 'Embedding' && r.name !== 'Embedding Batch');
  const avgLlm = Math.round(llmResults.reduce((s, r) => s + r.durationMs, 0) / llmResults.length);
  const jsonResults = results.filter(r => r.parseSuccess !== null);
  const parseRate = jsonResults.filter(r => r.parseSuccess).length + '/' + jsonResults.length;

  console.log(`\nTotal time: ${totalMs}ms`);
  console.log(`Avg LLM call: ${avgLlm}ms`);
  console.log(`JSON parse success: ${parseRate}`);
  console.log(`\nEstimated daily LLM budget (12 agents):`);
  console.log(`  Morning goal review: 12 × ${results.find(r => r.name === 'Goal Review')?.durationMs ?? '?'}ms = ${12 * (results.find(r => r.name === 'Goal Review')?.durationMs ?? 0)}ms`);
  console.log(`  Daily plans: 12 × ${results.find(r => r.name === 'Daily Plan')?.durationMs ?? '?'}ms = ${12 * (results.find(r => r.name === 'Daily Plan')?.durationMs ?? 0)}ms`);
  console.log(`  Conversations: ~40/day × ${results.find(r => r.name === 'Conversation (full)')?.durationMs ?? '?'}ms = ${40 * (results.find(r => r.name === 'Conversation (full)')?.durationMs ?? 0)}ms`);
}

main().catch(console.error);
