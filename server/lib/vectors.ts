export class VectorStore {
  private vectors: Map<number, Float32Array> = new Map();
  private memoryAgentMap: Map<number, number> = new Map(); // memoryId → agentId

  load(memories: Array<{ id: number; agentId: number; embedding: Buffer | null }>) {
    for (const m of memories) {
      if (m.embedding) {
        const copy = new Uint8Array(m.embedding);
        this.vectors.set(m.id, new Float32Array(copy.buffer));
        this.memoryAgentMap.set(m.id, m.agentId);
      }
    }
  }

  add(id: number, agentId: number, embedding: Float32Array) {
    this.vectors.set(id, embedding);
    this.memoryAgentMap.set(id, agentId);
  }

  remove(id: number) {
    this.vectors.delete(id);
    this.memoryAgentMap.delete(id);
  }

  search(query: Float32Array, agentId: number, topK: number): number[] {
    const scores: Array<{ id: number; score: number }> = [];
    for (const [id, vec] of this.vectors) {
      if (this.memoryAgentMap.get(id) !== agentId) continue;
      scores.push({ id, score: cosineSimilarity(query, vec) });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK).map(s => s.id);
  }

  get size() { return this.vectors.size; }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export const vectorStore = new VectorStore();
