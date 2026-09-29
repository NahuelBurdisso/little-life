/**
 * Give every active memory a vector from the current embedding model.
 *
 * Two gaps it closes, at server start and in the background:
 *  - Memories written without a vector are invisible to relevance retrieval
 *    (MemoryStore.loadEmbeddingsForAgent skips them). Seeded backstory is
 *    inserted that way: a live world had 69 of 77 memories without one, so an
 *    agent never "remembered" their own history when it was relevant.
 *  - Vectors from different models are not comparable. After EMBEDDING_MODEL
 *    changes, every stored vector is recomputed; until then the old ones stay.
 *
 * The model that made the stored vectors is kept in `app_meta`. A DB that
 * predates the marker is assumed to hold vectors from mxbai-embed-large, the
 * previous default.
 */
import { sqlite } from '../../db';
import { CONFIG } from '../constants';
import { EMBED_KEEP_ALIVE, EMBED_OPTIONS, EMBEDDING_DIMENSIONS } from './constants';
import { float32ArrayToBuffer } from './MemoryService';
import { currentWorldEpoch, isStaleWorldEpoch } from '../worldEpoch';

const META_KEY = 'embedding_model';
const LEGACY_MODEL = 'mxbai-embed-large';
const BATCH = 32;

function metaGet(key: string): string | null {
  const row = sqlite.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function metaSet(key: string, value: string): void {
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${CONFIG.AI.EMBED_BASE_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CONFIG.AI.EMBEDDING_MODEL, input: texts, keep_alive: EMBED_KEEP_ALIVE, options: EMBED_OPTIONS }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`/api/embed ${res.status}: ${await res.text().catch(() => '')}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error('/api/embed returned no embeddings');
  }
  return data.embeddings;
}

export interface BackfillResult {
  embedded: number;
  reembeddedAll: boolean;
}

let running: Promise<BackfillResult | null> | null = null;

/**
 * Run a backfill unless one is already going; `onChanged` runs when vectors
 * were written (callers drop their vector caches there).
 */
export function runEmbeddingBackfill(onChanged: () => void): Promise<BackfillResult | null> {
  if (running) return running;
  running = backfillEmbeddings()
    .then((r) => {
      if (r && r.embedded > 0) {
        onChanged();
        console.log(`[memory] embedded ${r.embedded} memories${r.reembeddedAll ? ` (all re-embedded for ${CONFIG.AI.EMBEDDING_MODEL})` : ''}`);
      }
      return r;
    })
    .finally(() => { running = null; });
  return running;
}

/** Returns what it did, or null when Ollama failed (retried next time). */
export async function backfillEmbeddings(): Promise<BackfillResult | null> {
  const model = CONFIG.AI.EMBEDDING_MODEL;
  const madeBy = metaGet(META_KEY) ?? LEGACY_MODEL;
  const reembedAll = madeBy !== model;

  const rows = sqlite.prepare(
    reembedAll
      ? 'SELECT id, description FROM memories WHERE is_active = 1 ORDER BY id'
      : 'SELECT id, description FROM memories WHERE is_active = 1 AND embedding IS NULL ORDER BY id',
  ).all() as Array<{ id: number; description: string }>;

  // Text must still match when the vector lands: a world replaced meanwhile
  // reuses ids for different memories.
  const update = sqlite.prepare('UPDATE memories SET embedding = ? WHERE id = ? AND description = ?');
  let embedded = 0;
  // The row list was read from the world running now. The description guard
  // above covers most reuse, but a swap to the same seeded world recreates
  // identical texts under the same ids: stop at the first batch after a swap
  // (the next day change backfills the new world on its own).
  const worldEpoch = currentWorldEpoch();
  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const vectors = await embedBatch(batch.map((r) => r.description));
      if (isStaleWorldEpoch(worldEpoch)) return null;
      if (vectors[0]?.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`model ${model} returns ${vectors[0]?.length} dimensions, the store expects ${EMBEDDING_DIMENSIONS}`);
      }
      sqlite.transaction(() => {
        batch.forEach((r, j) => update.run(float32ArrayToBuffer(new Float32Array(vectors[j])), r.id, r.description));
      })();
      embedded += batch.length;
    }
  } catch (err) {
    console.warn(`[memory] embedding backfill stopped after ${embedded}/${rows.length}: ${(err as Error).message}`);
    return null;
  }
  // Only a complete pass may claim the vectors are all this model's.
  metaSet(META_KEY, model);
  return { embedded, reembeddedAll: reembedAll };
}
