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
