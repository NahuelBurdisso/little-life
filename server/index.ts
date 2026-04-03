import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { appRouter } from './router';
import { startTickLoop, stopTickLoop } from './engine/tick';
import { taskRunner } from './ai/taskRunner';
import { sqlite } from './db';
import { memoryService } from './lib/memory/instance';
import { initMemoryObserver } from './lib/memory/MemoryObserver';
import { initPlanEventAdapter } from './lib/planning/PlanEventAdapter';

const PORT = parseInt(process.env.SERVER_PORT || '3001', 10);

// Initialize memory system
initMemoryObserver(memoryService);
console.log('Memory service initialized');

// Backfill embeddings for memories that don't have them (e.g., seed/backstory data)
import { db } from './db';
import { memories } from './db/schema';
import { sql, eq } from 'drizzle-orm';
import { EmbeddingBatcher } from './lib/memory/EmbeddingBatcher';

const unembedded = db.select({ id: memories.id, description: memories.description })
  .from(memories)
  .where(sql`${memories.embedding} IS NULL AND ${memories.is_active} = 1`)
  .all();
if (unembedded.length > 0) {
  console.log(`Backfilling embeddings for ${unembedded.length} memories...`);
  const backfillBatcher = new EmbeddingBatcher();
  (async () => {
    try {
      // Process in batches of 10 to avoid overwhelming Ollama
      for (let i = 0; i < unembedded.length; i += 10) {
        const batch = unembedded.slice(i, i + 10);
        const vecs = await backfillBatcher.embed(batch.map(m => m.description));
        for (let j = 0; j < batch.length; j++) {
          if (vecs[j]) {
            const buffer = Buffer.from(vecs[j].buffer, vecs[j].byteOffset, vecs[j].byteLength);
            db.update(memories).set({ embedding: buffer }).where(eq(memories.id, batch[j].id)).run();
          }
        }
      }
      console.log(`Backfilled ${unembedded.length} embeddings`);
    } catch (err) {
      console.warn('Embedding backfill failed (Ollama may be unavailable):', (err as Error).message);
    }
  })();
}

// Initialize planning system
initPlanEventAdapter();
console.log('Planning system initialized');

// Express for health check
const app = express();
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const server = createServer(app);

// WebSocket server for tRPC
const wss = new WebSocketServer({ server });
const handler = applyWSSHandler({
  wss,
  router: appRouter,
});

// Start tick loop
startTickLoop();
console.log('Simulation tick loop started');

server.listen(PORT, () => {
  console.log(`Server listening on ws://localhost:${PORT}`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  stopTickLoop();
  handler.broadcastReconnectNotification();
  wss.close();
  server.close();
  taskRunner.drain().then(() => {
    sqlite.close();
    console.log('Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
