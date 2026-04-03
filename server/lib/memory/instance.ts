import { MemoryService } from './MemoryService';
import { ContextBuilder } from './ContextBuilder';
import { ReflectionTrigger } from './ReflectionTrigger';
import { ReflectionRunner } from './ReflectionRunner';
import { MemoryConsolidator } from './MemoryConsolidator';
import { SelfDescriptionGenerator } from './SelfDescriptionGenerator';
import { db } from '../../db';
import { agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import type { PersonalityProfile } from '../personality';

export const memoryService = new MemoryService();
export const contextBuilder = new ContextBuilder(memoryService);
export const memoryConsolidator = new MemoryConsolidator(memoryService, memoryService.getStore());
export const selfDescriptionGenerator = new SelfDescriptionGenerator(memoryService);

// Personality-gated reflection threshold
function getReflectionThreshold(agentId: number): number {
  const BASE = 150;
  const agent = db.select({ personality: agents.personality }).from(agents).where(eq(agents.id, agentId)).get();
  if (!agent?.personality) return BASE;
  const p = agent.personality as PersonalityProfile;
  const c = ((p.curiosity ?? 50) / 100);
  const n = ((p.neuroticism ?? 50) / 100);
  const i = ((p.impulsiveness ?? 50) / 100);
  return Math.max(80, Math.min(250, BASE + c * -20 + n * -15 + i * 20));
}

export const reflectionTrigger = new ReflectionTrigger(getReflectionThreshold);
export const reflectionRunner = new ReflectionRunner(memoryService);
