import { callOllamaEmbedding } from './ollama';
import { writeEmbedding } from '../helpers/embeddingHelpers';
import { currentWorldEpoch, isStaleWorldEpoch } from '../lib/worldEpoch';

export async function generateEmbeddingForMemory(memoryId: number, text: string): Promise<void> {
  // Captured at enqueue (this runs synchronously up to the await). Memory ids
  // restart after a world swap, so a vector landing late would overwrite the
  // embedding of some new resident's unrelated memory.
  const epoch = currentWorldEpoch();
  const result = await callOllamaEmbedding(text);
  if (isStaleWorldEpoch(epoch)) return;
  writeEmbedding(memoryId, Float32Array.from(result));
}
