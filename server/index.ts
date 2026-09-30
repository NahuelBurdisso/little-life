import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { appRouter } from './router';
import { startTickLoop, stopTickLoopAndWait } from './engine/tick';
import { restoreWorldCaches, saveWorldCaches } from './engine/worldCaches';
import { warmUpModels } from './ai/warmup';
import { startHealthWatch } from './lib/health';
import { recoverInterruptedSkip } from './engine/nightSkip';
import { runEmbeddingBackfill } from './lib/memory/embeddingBackfill';
import { endOrphanedLLMConversations } from './engine/systems/conversations';
import { taskRunner } from './ai/taskRunner';
import { sqlite } from './db';
import { memoryService } from './lib/memory/instance';
import { initMemoryObserver } from './lib/memory/MemoryObserver';
import { initPlanEventAdapter } from './lib/planning/PlanEventAdapter';
import { initCascade } from './lib/cascade';
import { reconstructZoneOccupancy } from './lib/interiorGrid';
import { CONFIG } from './lib/constants';
import './lib/giftEngine'; // Initialize gift-giving event listeners
import './lib/secretSharing'; // Initialize secret-sharing event listeners
import './lib/playerOutcomes'; // Report what the player's nudges came to
import './lib/milestonesEngine'; // Proposals, engagements and weddings of real couples
import './lib/family'; // Children of married couples: a parent's death or departure
import { initBirthdays } from './lib/agingEngine';
import { initPersonalityDrift } from './lib/personalityDrift';
import { initFavorTracking } from './lib/favorEngine';

const PORT = parseInt(process.env.SERVER_PORT || '3001', 10);

// Initialize memory system
initMemoryObserver(memoryService);
console.log('Memory service initialized');
initBirthdays();
initPersonalityDrift();
initFavorTracking();

// Log LLM configuration
console.log(`LLM backend: ${CONFIG.AI.BACKEND} @ ${CONFIG.AI.CHAT_BASE_URL}`);
console.log(`  Chat model:  ${CONFIG.AI.CHAT_MODEL}`);
console.log(`  Light model: ${CONFIG.AI.LIGHT_MODEL}${CONFIG.AI.LIGHT_MODEL === CONFIG.AI.CHAT_MODEL ? ' (same)' : ''}`);
console.log(`  Embed model: ${CONFIG.AI.EMBEDDING_MODEL} @ ${CONFIG.AI.EMBED_BASE_URL}`);

// Backfill embeddings for memories that don't have them (e.g., seed/backstory data)
import { db } from './db';
import { agents as agentsTable, locations as locationsTable, memories } from './db/schema';
import { sql, eq } from 'drizzle-orm';
import { EmbeddingBatcher } from './lib/memory/EmbeddingBatcher';

// Backfill may fail on fresh DB (no tables yet — setup wizard creates them)
let unembedded: { id: number; description: string }[] = [];
try {
  unembedded = db.select({ id: memories.id, description: memories.description })
    .from(memories)
    .where(sql`${memories.embedding} IS NULL AND ${memories.is_active} = 1`)
    .all();
} catch { /* empty DB — setup wizard will create tables */ }
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

// Bring back the in-memory sim state the previous process checkpointed
// (hobbies, favors, tension, momentum, drift baselines, trackers). After
// initCascade only for tidiness — the tension store holds a restore that
// arrives before its tracker exists. Never throws; a fresh DB has no rows.
const restoredStores = restoreWorldCaches();
if (restoredStores > 0) console.log(`Restored ${restoredStores} sim state snapshot(s)`);

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

// LLM conversations the previous process was running have no turn chain now
// (the task runner is in-memory): end them and free their participants.
try {
  const ended = endOrphanedLLMConversations();
  if (ended > 0) console.log(`Ended ${ended} LLM conversation(s) orphaned by the restart`);
} catch (err) {
  console.warn('Ending orphaned conversations failed:', (err as Error).message);
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

// Health banner plumbing first, so the warm-up's own "model missing" verdict
// reaches the client. Tells subscribers only when the verdict changes.
startHealthWatch();

// Load the models in the background so the first turns don't pay for it.
// Then give every memory a vector from the current embedding model (seeded
// backstory has none; a model change invalidates the old ones).
void warmUpModels().then(() => runEmbeddingBackfill(() => memoryService.invalidateEmbeddings()));

// A skip the previous process died in the middle of left tick_speed at its
// fast-forward value; put the player's speed back before the first tick.
const recoveredSpeed = recoverInterruptedSkip();
if (recoveredSpeed != null) console.log(`Night skip was interrupted; speed restored to ${recoveredSpeed}x`);

// Start tick loop
startTickLoop();
console.log('Simulation tick loop started');

server.listen(PORT, () => {
  console.log(`Server listening on ws://localhost:${PORT}`);
});

// Graceful shutdown
//
// The sim state checkpoint is written twice: once as soon as the in-flight tick
// has finished (so it cannot capture half a tick), and again after the task
// runner drains, since LLM tasks finishing during the drain still move state
// (a snap resolved, a conversation ended with a favor). The first save is the
// one that matters when the drain is cut short — Windows gives a closing
// console only a few seconds. Both are cheap, synchronous and never throw.
let shuttingDown = false;
function shutdown() {
  // A second signal while the drain is still waiting on the LLM: the user
  // wants out now. The first checkpoint has normally been written by then.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log('Shutting down...');
  handler.broadcastReconnectNotification();
  wss.close();
  server.close();
  void stopTickLoopAndWait()
    .then(() => {
      saveWorldCaches();
      return taskRunner.drain();
    })
    .then(() => {
      saveWorldCaches();
      sqlite.close();
      console.log('Shutdown complete.');
      process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Closing the console window on Windows (start-game.bat) sends SIGHUP, not
// SIGINT; without a handler the process died without its final checkpoint.
process.on('SIGHUP', shutdown);
