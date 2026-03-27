import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { appRouter } from './router';
import { startTickLoop, stopTickLoop } from './engine/tick';
import { taskRunner } from './ai/taskRunner';
import { sqlite, db } from './db';
import { vectorStore } from './lib/vectors';
import { memories } from './db/schema';

const PORT = parseInt(process.env.SERVER_PORT || '3001', 10);

// Load vector store on startup + embed any unembedded memories
try {
  const allMemories = db.select({
    id: memories.id,
    agentId: memories.agent_id,
    embedding: memories.embedding,
  }).from(memories).all();
  vectorStore.load(allMemories);
  console.log(`Loaded ${vectorStore.size} embeddings into vector store`);

  // Queue embedding generation for memories that don't have embeddings yet (e.g. seed/backstory)
  const unembedded = db.select({ id: memories.id, content: memories.content })
    .from(memories).all()
    .filter(m => !allMemories.find(am => am.id === m.id && am.embedding));
  if (unembedded.length > 0) {
    console.log(`Queueing ${unembedded.length} unembedded memories for embedding generation...`);
    for (const mem of unembedded) {
      taskRunner.generateEmbedding(mem.id, mem.content);
    }
  }
} catch (err) {
  console.error('Failed to load vector store, continuing with empty store:', err);
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
