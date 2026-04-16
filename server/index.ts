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
import { initCascade } from './lib/cascade';
import { reconstructZoneOccupancy } from './lib/interiorGrid';

const PORT = parseInt(process.env.SERVER_PORT || '3001', 10);

// Initialize memory system
initMemoryObserver(memoryService);
console.log('Memory service initialized');

// Backfill embeddings for memories that don't have them (e.g., seed/backstory data)
import { db } from './db';
import { agents as agentsTable, locations as locationsTable, memories } from './db/schema';
import { sql, eq } from 'drizzle-orm';
import { EmbeddingBatcher } from './lib/memory/EmbeddingBatcher';

const unembedded = db.select({ id: memories.id, description: memories.description })
  .from(memories)
  .where(sql`${memories.embedding} IS NULL AND ${memories.is_active} = 1`)
  .all();
if (unembedded.length > 0) {
  console.log(`Will backfill ${unembedded.length} embeddings after tick loop stabilizes...`);
  // Delay backfill by 30 seconds to avoid DB lock contention with initial tick burst
  setTimeout(async () => {
    try {
      const backfillBatcher = new EmbeddingBatcher();
      for (let i = 0; i < unembedded.length; i += 5) {
        const batch = unembedded.slice(i, i + 5);
        const vecs = await backfillBatcher.embed(batch.map(m => m.description));
        for (let j = 0; j < batch.length; j++) {
          if (vecs[j]) {
            const buffer = Buffer.from(vecs[j].buffer, vecs[j].byteOffset, vecs[j].byteLength);
            db.update(memories).set({ embedding: buffer }).where(eq(memories.id, batch[j].id)).run();
          }
        }
        // Breathe between batches to avoid DB contention
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`Backfilled ${unembedded.length} embeddings`);
    } catch (err) {
      console.warn('Embedding backfill failed:', (err as Error).message);
    }
  }, 30000);
}

// Initialize planning system
initPlanEventAdapter();
console.log('Planning system initialized');

// Initialize cascade system (ripple effects, tension, snap resolution)
initCascade();

// Reconstruct zone occupancy from agent positions (singleton is in-memory only)
try {
  const activeAgents = db
    .select({
      id: agentsTable.id,
      current_location: agentsTable.current_location,
      position: agentsTable.position,
    })
    .from(agentsTable)
    .all();
  const allLocations = db
    .select({
      id: locationsTable.id,
      type: locationsTable.type,
      position: locationsTable.position,
    })
    .from(locationsTable)
    .all();
  reconstructZoneOccupancy(activeAgents, allLocations);
  console.log(`Zone occupancy reconstructed (${activeAgents.length} agents, ${allLocations.length} locations)`);
} catch (err) {
  console.warn('Zone occupancy reconstruction failed:', (err as Error).message);
}

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
