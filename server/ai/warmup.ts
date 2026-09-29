/**
 * Load the chat and embedding models when the server starts.
 *
 * Without this the first minutes of play paid for model loading: the first
 * conversation turns and plans waited 15-60 s (Gemma 4 26B is ~18 GB), and
 * an embedding read that timed out mid-load cancelled the load, so memory
 * retrieval kept failing until something slower finished it. It also turns
 * "model not installed" — easy to hit after changing CHAT_MODEL in .env —
 * into one clear line instead of a stream of failed turns.
 */
import { CONFIG } from '../lib/constants';
import { llmHealth } from './llmHealth';

const LOAD_TIMEOUT_MS = 300_000;

async function post(path: string, body: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  try {
    return await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function report(what: 'chat' | 'embedding', model: string, started: number, res: Response): Promise<void> {
  if (res.ok) {
    console.log(`[llm] ${what} model ${model} ready (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    if (what === 'chat') llmHealth.noteChat(true, model);
    else llmHealth.noteEmbedding(true, model);
    return;
  }
  const text = await res.text().catch(() => '');
  if (res.status === 404 || /not found/i.test(text)) {
    console.error(`[llm] ${what} model "${model}" is not installed in Ollama. Run: ollama pull ${model}`);
    // Also to the in-game health banner: the console line alone is what the
    // player never sees while the townsfolk silently fall back to templates.
    llmHealth.noteModelMissing(what, model);
  } else {
    console.warn(`[llm] ${what} model ${model} failed to load (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function warmUpModels(): Promise<void> {
  const tasks: Array<Promise<void>> = [];

  if (CONFIG.AI.BACKEND === 'ollama') {
    for (const model of new Set([CONFIG.AI.CHAT_MODEL, CONFIG.AI.LIGHT_MODEL])) {
      const started = Date.now();
      // An empty message list loads the model without generating. num_ctx must
      // match the game's calls (ollama.ts), or the first real call reloads it.
      tasks.push(
        post(`${CONFIG.AI.CHAT_BASE_URL}/api/chat`, {
          model,
          messages: [],
          keep_alive: CONFIG.AI.KEEP_ALIVE,
          options: { num_ctx: CONFIG.AI.NUM_CTX },
        }).then((res) => report('chat', model, started, res), (err) => {
          // Unreachable Ollama: the failure is the evidence the banner needs.
          llmHealth.noteChat(false, model, (err as Error)?.message ?? String(err));
          throw err;
        }),
      );
    }
  }

  const started = Date.now();
  tasks.push(
    post(`${CONFIG.AI.EMBED_BASE_URL}/api/embed`, {
      model: CONFIG.AI.EMBEDDING_MODEL,
      input: 'warm up',
      keep_alive: CONFIG.AI.KEEP_ALIVE,
      options: { num_ctx: CONFIG.AI.EMBED_NUM_CTX },
    }).then((res) => report('embedding', CONFIG.AI.EMBEDDING_MODEL, started, res), (err) => {
      llmHealth.noteEmbedding(false, CONFIG.AI.EMBEDDING_MODEL, (err as Error)?.message ?? String(err));
      throw err;
    }),
  );

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn(`[llm] model warm-up failed — is Ollama running at ${CONFIG.AI.CHAT_BASE_URL}? ${(r.reason as Error)?.message ?? r.reason}`);
    }
  }
}
