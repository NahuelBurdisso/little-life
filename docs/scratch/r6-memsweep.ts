// Round-6 read-only verification harness. Imports real project modules.
import { getImportance, getTypePriority } from '../../server/lib/memory/ImportanceScorer';
import { rankCandidates, recencyScore } from '../../server/lib/memory/RetrievalEngine';
import { SCORE_WEIGHTS, DECAY_RATE } from '../../server/lib/memory/constants';
import { PlanExecutor } from '../../server/lib/planning/PlanExecutor';
import type { DailyPlan, PlanExecutionState } from '../../server/lib/planning/types';

console.log('=== 1. IMPORTANCE TAXONOMY ===');
// These are the `type` strings actually passed to memoryService.record() by MemoryObserver.
const actualTypesWritten = ['observation', 'conversation', 'plan', 'reflection'];
for (const t of actualTypesWritten) {
  console.log(`  record(type='${t}') -> importance ${getImportance(t)}  priority ${getTypePriority(t)}`);
}
console.log('  -- keys the table actually defines (event names, never passed as `type`):');
for (const k of ['moved_to_location', 'relationship_changed', 'need_critical', 'interaction_completed', 'created_secret', 'plan_created']) {
  console.log(`     '${k}' -> ${getImportance(k)}   (unreachable)`);
}

console.log('\n=== 2. RETRIEVAL RANKING WITH FLAT IMPORTANCE ===');
console.log('  SCORE_WEIGHTS =', JSON.stringify(SCORE_WEIGHTS), ' DECAY_RATE =', DECAY_RATE);
// A highly relevant but slightly older memory vs a trivial "I arrived at Home" 20 ticks old.
const cands = [
  { memoryId: 1, lastAccessed: 0,    importance: 3, similarity: 0.92 }, // deeply relevant reflection-ish
  { memoryId: 2, lastAccessed: 1400, importance: 3, similarity: 0.41 }, // "arrived at Home", just now
];
const ranked = rankCandidates(cands, 1440, 2);
for (const r of ranked) {
  console.log(`  mem#${r.memoryId} sim=${r.similarity} recency=${recencyScore(r.lastAccessed, 1440).toFixed(4)} -> score ${r.score.toFixed(4)}`);
}
console.log('  winner:', ranked[0].memoryId === 2 ? 'the trivial recent one (relevance loses)' : 'the relevant one');

console.log('\n=== 3. PlanExecutor: duration_minutes consumed as TICKS ===');
function runAtSpeed(tickSpeed: number) {
  const plan: DailyPlan = {
    day: 1, generated_at: 0,
    blocks: [{
      id: 'b1', start_hour: 9, end_hour: 12,
      broad_action: 'work', location_hint: 'Shop', status: 'active',
      decomposed_actions: [
        { description: 'a1', action_type: 'work', duration_minutes: 60 },
        { description: 'a2', action_type: 'work', duration_minutes: 60 },
        { description: 'a3', action_type: 'work', duration_minutes: 60 },
      ],
    }],
    needs_snapshot: { hunger: 50, energy: 50, social: 50 },
  };
  let exec: PlanExecutionState | null = {
    currentBlockId: 'b1', currentActionIndex: 0, blockStartedAt: 0, actionStartedAt: 0,
  };
  const cache = {
    get: () => plan,
    set: () => {},
    getExecState: () => exec,
    setExecState: (_a: number, s: PlanExecutionState) => { exec = s; },
  };
  const ex = new PlanExecutor(cache as any, { queueDecomposition: () => {} } as any);

  // The block covers 09:00-12:00 = 180 game minutes. Walk ticks until the window closes.
  let tick = 0;
  let minutes = 0;
  let completedActions = 0;
  let lastIdx = 0;
  while (minutes < 180) {
    const hour = 9 + Math.floor(minutes / 60);
    ex.getPlannedAction(1, hour, tick, 1);
    if (exec && exec.currentActionIndex > lastIdx) { completedActions++; lastIdx = exec.currentActionIndex; }
    tick += 1;
    minutes += tickSpeed;
  }
  console.log(`  tick_speed=${tickSpeed}: block window 180 game-min = ${tick} ticks; ` +
    `actions advanced past = ${completedActions} of 3 (each nominally 60 min)`);
}
for (const s of [0.5, 1, 2, 4]) runAtSpeed(s);

console.log('\n=== 4. MemoryConsolidator retention in real game days ===');
const TICKS_PER_DAY_CONST = 1440;
for (const s of [0.5, 1, 2, 4]) {
  const routineTicks = 5 * TICKS_PER_DAY_CONST;
  const realDays = (routineTicks * s) / 1440;
  console.log(`  tick_speed=${s}: "keep routine memories 5 days" actually keeps them ${realDays} game days`);
}
