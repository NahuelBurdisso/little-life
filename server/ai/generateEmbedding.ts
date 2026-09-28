import { callOllamaEmbedding } from './ollama';
import { writeEmbedding } from '../helpers/embeddingHelpers';

export async function generateEmbeddingForMemory(memoryId: number, text: string): Promise<void> {
  const result = await callOllamaEmbedding(text);
  writeEmbedding(memoryId, Float32Array.from(result));
}
